import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server/http.ts";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("ephemeral desktop backend requires app capability in addition to exact origin/session/CSRF", async () => {
  const dir = await realpath(
    await mkdtemp(path.join(tmpdir(), "prce-desktop-")),
  );
  const app = await createApp(0, {
    dataDir: dir,
    desktopKey: "a".repeat(64),
  } as any);
  try {
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const address = app.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
    const session = (headers: Record<string, string>) =>
      fetch(origin + "/api/session", {
        method: "POST",
        headers: { origin, "content-type": "application/json", ...headers },
        body: "{}",
      });
    assert.equal((await session({})).status, 403);
    const accepted = await session({ "x-prce-desktop": "a".repeat(64) });
    assert.equal(accepted.status, 200);
    const csrf = (await accepted.json()).csrf;
    const cookie = accepted.headers.get("set-cookie")!.split(";")[0];
    const snapshot = await fetch(origin + "/api/snapshot", {
      headers: { cookie, "x-prce-desktop": "a".repeat(64) },
    });
    assert.equal(snapshot.status, 200);
    assert.ok((await snapshot.json()).snapshot);
    assert.equal(
      (
        await session({
          "x-prce-desktop": "a".repeat(64),
          origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal(typeof csrf, "string");
    assert.equal(typeof (app as any).desktopStatus, "function");
    assert.equal((app as any).desktopStatus().active, false);
  } finally {
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
