import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("loopback Host/Origin와 세션 인증; 임의 경로 거부", async () => {
  assert.ok(existsSync("src/server/http.ts"), "보안 서버 구현 필요");
  const { createApp } = await import("../src/server/http.ts");
  const app = await createApp(4389);
  await new Promise<void>((r) => app.listen(4389, "127.0.0.1", r));
  try {
    const base = "http://127.0.0.1:4389";
    assert.equal((await fetch(base + "/api/snapshot")).status, 401);
    assert.equal(
      (
        await fetch(base + "/api/session", {
          method: "POST",
          headers: { Origin: "https://evil.invalid" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(base + "/api/session", { method: "POST" })).status,
      403,
    );
    const { request } = await import("node:http");
    assert.equal(
      await new Promise<number>((resolve) => {
        const r = request(
          base + "/api/session",
          { method: "POST", headers: { Origin: base, Host: "evil.invalid" } },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          },
        );
        r.end();
      }),
      403,
    );
    const auth = await fetch(base + "/api/session", {
      method: "POST",
      headers: { Origin: base },
    });
    assert.equal(auth.status, 200);
    const cookie = auth.headers.get("set-cookie")!.split(";")[0];
    assert.match(auth.headers.get("set-cookie")!, /HttpOnly/);
    const result = await fetch(base + "/api/snapshot", {
      headers: { Cookie: cookie },
    });
    assert.equal(result.status, 200);
    assert.ok((await result.json()).snapshot.phases.length === 3);
    assert.equal(
      (
        await fetch(base + "/api/file?path=/etc/passwd", {
          headers: { Cookie: cookie },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(base + "/api/snapshot", {
          headers: { Cookie: cookie, Origin: "https://evil.invalid" },
        })
      ).status,
      403,
    );
    assert.match(
      result.headers.get("content-security-policy")!,
      /img-src 'self'/,
    );
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
});
