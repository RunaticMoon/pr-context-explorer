import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
test("live local API persists connection without secret and requires session + Origin + CSRF + bounded JSON; symlink assets denied", async () => {
  const { createApp } = await import("../src/server/http.ts");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "prce-api-")));
  const dist = path.join(root, "dist");
  mkdirSync(dist);
  writeFileSync(path.join(root, "secret"), "PRIVATE");
  symlinkSync(path.join(root, "secret"), path.join(dist, "escape.txt"));
  writeFileSync(path.join(dist, "index.html"), "<h1>fixture</h1>");
  const port = 4391,
    base = `http://127.0.0.1:${port}`;
  const app = await createApp(port, { dataDir: path.join(root, "data"), dist });
  await new Promise<void>((r) => app.listen(port, "127.0.0.1", r));
  try {
    const auth = await fetch(base + "/api/session", {
      method: "POST",
      headers: { Origin: base },
    });
    const { csrf } = await auth.json();
    assert.match(csrf, /^[a-f0-9]{64}$/);
    const cookie = auth.headers.get("set-cookie")!.split(";")[0];
    const headers = {
      Origin: base,
      Cookie: cookie,
      "Content-Type": "application/json",
      "X-PRCE-CSRF": csrf,
    };
    const c = {
      id: "public",
      type: "github",
      webUrl: "https://github.com",
      apiUrl: "https://api.github.com",
      apiVersion: "2022-11-28",
      account: "public",
      auth: { kind: "public" },
    };
    assert.equal(
      (
        await fetch(base + "/api/connections", {
          method: "POST",
          headers: { ...headers, "X-PRCE-CSRF": "" },
          body: JSON.stringify(c),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/api/connections", {
          method: "POST",
          headers: {
            Cookie: cookie,
            "X-PRCE-CSRF": csrf,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(c),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/api/connections", {
          method: "POST",
          headers,
          body: JSON.stringify(c),
        })
      ).status,
      201,
    );
    const saved = await (
      await fetch(base + "/api/connections", { headers })
    ).json();
    assert.equal(saved.connections[0].id, "public");
    assert.ok(!JSON.stringify(saved).includes("token"));
    assert.equal(
      (
        await fetch(base + "/api/connections", {
          method: "POST",
          headers,
          body: JSON.stringify({ ...c, token: "do-not-save" }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(base + "/api/connections", {
          method: "POST",
          headers,
          body: "x".repeat(17000),
        })
      ).status,
      413,
    );
    assert.equal((await fetch(base + "/escape.txt")).status, 404);
    assert.equal(
      (
        await fetch(base + "/api/live/run", {
          method: "POST",
          headers,
          body: JSON.stringify({ providerId: "MockProvider", consent: true }),
        })
      ).status,
      400,
    );
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});
