import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, access, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
const built = path.resolve("desktop/build/runtime");
test("compiled runtime boots without tsx or source cwd and serves real UI + demo + dynamic AI module", async () => {
  await access(path.join(built, "desktop/backend.js"));
  const data = await realpath(
    await mkdtemp(path.join(tmpdir(), "prce-packaged-")),
  );
  const root = path.join(data, "isolated-runtime");
  await cp(built, root, { recursive: true });
  const child = spawn(
    process.env.PRCE_TEST_NODE || process.execPath,
    [path.join(root, "desktop/backend.js")],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: data,
        PRCE_DATA_DIR: path.join(data, "live"),
        PRCE_FIXTURE_DIR: path.join(data, "demo"),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (x) => (stderr += x));
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20000);
  try {
    child.send({
      type: "start",
      key: "b".repeat(64),
      dist: path.join(root, "dist"),
      admissionClosed: true,
    });
    const ready = await Promise.race([
      once(child, "message").then(([m]) => m),
      once(child, "exit").then(() => {
        throw Error("Backend exited: " + stderr);
      }),
    ]);
    assert.equal(ready.type, "ready");
    const origin = ready.origin;
    assert.equal(new URL(origin).hostname, "127.0.0.1");
    assert.equal((await fetch(origin)).status, 403);
    const headers = { "x-prce-desktop": "b".repeat(64) };
    const html = await fetch(origin, { headers });
    assert.equal(html.status, 200);
    assert.match(await html.text(), /assets\/index-/);
    const response = await fetch(origin + "/api/session", {
      method: "POST",
      headers: { ...headers, origin, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const { csrf } = await response.json();
    const frozen = await fetch(origin + "/api/live/run", {
      method: "POST",
      headers: {
        ...headers,
        cookie,
        origin,
        "content-type": "application/json",
        "x-prce-csrf": csrf,
      },
      body: "{}",
    });
    assert.equal(frozen.status, 503);
    assert.match((await frozen.json()).error, /admission closed/);
    const unlocked = once(child, "message");
    child.send({ type: "admission", id: 12, locked: false });
    assert.deepEqual((await unlocked)[0], {
      type: "admission",
      id: 12,
      ok: true,
    });
    const snap = await fetch(origin + "/api/snapshot", {
      headers: { ...headers, cookie },
    });
    assert.equal(snap.status, 200);
    assert.ok((await snap.json()).snapshot);
    const ai = await import(path.join(root, "src/server/live-analysis.js"));
    assert.equal(typeof (await ai.aiModule()).probeProviders, "function");
    await access(path.join(data, "demo/fixture/.git"));
    child.send({ type: "status", id: 1 });
    const [status] = await once(child, "message");
    assert.equal(status.active, false);
    const ended = once(child, "exit");
    child.send({ type: "shutdown" });
    await ended;
    assert.equal(child.exitCode, 0);
    assert.equal(stderr, "");
  } finally {
    clearTimeout(timeout);
    child.kill("SIGKILL");
    await rm(data, { recursive: true, force: true });
  }
});
