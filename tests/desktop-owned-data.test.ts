import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  realpathSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { identity } from "../desktop/smoke-helpers.mjs";
import {
  createOwnedAppData,
  assertProcessGone,
} from "./e2e/desktop-owned-data.mjs";

function fixture(t: import("node:test").TestContext) {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "prce-owned-data-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const app = {
    pid: 1234,
    parent: 1,
    group: 1234,
    uid: process.getuid!(),
    started: "start",
    command: "/fixture/app --arg",
  };
  const backend = {
    ...app,
    pid: 1235,
    parent: 1234,
    command: "/fixture/node backend.js",
  };
  const live = new Map([
    [app.pid, app],
    [backend.pid, backend],
  ]);
  const options = {
    ci: "1",
    identity: (pid: number) => live.get(pid) || null,
    assertGone: (pid: number) =>
      assert.ok(!live.has(pid), "process still present"),
  };
  const launch = () => {
    mkdirSync(data);
    writeFileSync(
      path.join(data, "desktop-runtime.json"),
      JSON.stringify({
        pid: app.pid,
        executable: "/fixture/app",
        backendPid: backend.pid,
      }),
    );
  };
  const capture = (owner: ReturnType<typeof createOwnedAppData>) =>
    owner.capture({ app, executable: "/fixture/app", node: "/fixture/node" });
  return { root, data, app, backend, live, options, launch, capture };
}
test("refuses non-CI, preexisting data, and dangling symlinks without deleting anything", (t) => {
  const f = fixture(t);
  assert.throws(
    () => createOwnedAppData([f.data], { ...f.options, ci: "0" }),
    /dedicated/,
  );
  f.launch();
  assert.throws(
    () => createOwnedAppData([f.data], f.options),
    /existing app data/,
  );
  assert.ok(existsSync(path.join(f.data, "desktop-runtime.json")));
  rmSync(f.data, { recursive: true });
  symlinkSync(path.join(f.root, "missing"), f.data);
  assert.throws(
    () => createOwnedAppData([f.data], f.options),
    /existing app data/,
  );
});
for (const mutation of [
  "replacement",
  "symlink",
  "ancestor",
  "live app",
  "live backend",
  "unknown data",
  "wrong lease",
  "changed app",
  "wrong backend",
]) {
  test(`preserves data on ${mutation}`, (t) => {
    const f = fixture(t);
    const owner = createOwnedAppData([f.data], f.options);
    f.launch();
    if (mutation === "wrong lease")
      writeFileSync(
        path.join(f.data, "desktop-runtime.json"),
        JSON.stringify({
          pid: 999,
          executable: "/fixture/app",
          backendPid: f.backend.pid,
        }),
      );
    if (mutation === "changed app")
      f.live.set(f.app.pid, { ...f.app, started: "reused" });
    if (mutation === "wrong backend")
      f.live.set(f.backend.pid, { ...f.backend, parent: 999 });
    if (["wrong lease", "changed app", "wrong backend"].includes(mutation))
      assert.throws(() => f.capture(owner));
    else if (mutation !== "unknown data") f.capture(owner);
    if (mutation === "replacement" || mutation === "symlink") {
      renameSync(f.data, f.data + ".original");
      if (mutation === "replacement") mkdirSync(f.data);
      else symlinkSync(f.data + ".original", f.data);
    }
    if (mutation === "ancestor") {
      renameSync(f.root, f.root + ".original");
      mkdirSync(f.root);
      mkdirSync(f.data);
      t.after(() =>
        rmSync(f.root + ".original", { recursive: true, force: true }),
      );
    }
    if (mutation !== "live app") f.live.delete(f.app.pid);
    if (mutation !== "live backend") f.live.delete(f.backend.pid);
    assert.throws(() => owner.cleanup());
    assert.ok(existsSync(f.data));
  });
}
test(
  "real owned app/backend fixtures can smoke twice then admit the gate",
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t);
    for (let i = 0; i < 2; i++) {
      const owner = createOwnedAppData([f.data], { ci: "1" });
      const script = `const fs=require('node:fs');const {spawn}=require('node:child_process');const b=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.on('SIGTERM',()=>{b.once('exit',()=>process.exit(0));b.kill('SIGTERM');});fs.mkdirSync(process.argv[1]);fs.writeFileSync(process.argv[1]+'/desktop-runtime.json',JSON.stringify({pid:process.pid,executable:process.execPath,backendPid:b.pid}));console.log('ready');`;
      const app = spawn(process.execPath, ["-e", script, f.data], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      try {
        await once(app.stdout!, "data");
        const owned = identity(app.pid!);
        const captured = owner.capture({
          app: owned,
          executable: process.execPath,
          node: process.execPath,
        });
        assert.equal(captured.length, 1);
        assert.throws(() => owner.cleanup(), /process still present/);
        const exit = once(app, "exit");
        app.kill("SIGTERM");
        await exit;
        assertProcessGone(app.pid!);
        assertProcessGone(captured[0].backend.pid);
        owner.cleanup();
        assert.equal(existsSync(f.data), false);
      } finally {
        if (app.exitCode === null && app.signalCode === null) {
          const exit = once(app, "exit");
          app.kill("SIGTERM");
          await exit;
        }
      }
    }
    // Gate's account preflight and fixture sentinel are now admissible.
    assert.equal(existsSync(f.data), false);
    mkdirSync(f.data);
    writeFileSync(
      path.join(f.data, "ci-update-preservation-sentinel"),
      "gate-owned",
    );
  },
);
test("two smoke lifecycles leave the account clean for the update sentinel gate", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 2; i++) {
    const owner = createOwnedAppData([f.data], f.options);
    f.live.set(f.app.pid, f.app);
    f.live.set(f.backend.pid, f.backend);
    f.launch();
    f.capture(owner);
    f.live.clear();
    owner.cleanup();
    assert.equal(existsSync(f.data), false);
  }
  // Same absence contract as public-update-mac, then its own preservation sentinel.
  assert.equal(existsSync(f.data), false);
  mkdirSync(f.data);
  writeFileSync(
    path.join(f.data, "ci-update-preservation-sentinel"),
    "owned by gate",
  );
  assert.throws(
    () => createOwnedAppData([f.data], f.options),
    /existing app data/,
  );
});
