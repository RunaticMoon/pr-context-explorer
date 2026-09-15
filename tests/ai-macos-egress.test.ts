import test from "node:test";
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { startMacEgress } from "../src/server/ai/macos-runtime.ts";

test("owned exact-port proxy reserves both localhost families and denies CONNECT", async () => {
  const scratch = await mkdtemp("/tmp/ai-dual-proxy-");
  let proxy: Awaited<ReturnType<typeof startMacEgress>> | undefined;
  try {
    proxy = await startMacEgress("codex", `${scratch}/proxy.sock`);
    for (const host of ["127.0.0.1", "::1"]) {
      const competitor = createServer();
      try {
        await assert.rejects(
          new Promise<void>((resolve, reject) => {
            competitor.once("error", reject);
            competitor.listen(
              { host, port: proxy!.port, ipv6Only: true },
              resolve,
            );
          }),
          { code: "EADDRINUSE" },
        );
      } finally {
        await new Promise<void>((r) => competitor.close(() => r()));
      }
      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect({ host, port: proxy!.port });
        let text = "";
        socket.on("connect", () =>
          socket.write(
            "CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n",
          ),
        );
        socket.on("data", (b) => (text += b));
        socket.on("end", () => resolve(text));
        socket.on("error", reject);
        socket.setTimeout(2000, () =>
          socket.destroy(new Error("proxy timed out")),
        );
      });
      assert.match(response, /403 Forbidden/);
    }
  } finally {
    await proxy?.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
