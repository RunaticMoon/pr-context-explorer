import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { JiraCloudAdapter } from "../src/server/jira/index.ts";
import type { JiraConnection } from "../src/server/jira/index.ts";

// This is a local protocol harness with ephemeral test certificates, NOT a Jira/account smoke test.
test("real HTTPS transport verifies custom CA/hostname and refuses redirects without cross-host credentials", async () => {
  const dir = mkdtempSync(resolve("artifacts/jira-tls-"));
  const keyPath = join(dir, "key.pem"),
    certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(certPath, "utf8"),
    key = readFileSync(keyPath, "utf8");
  const requests: {
    url: string;
    authorization: string | undefined;
    method: string | undefined;
  }[] = [];
  const sockets = new Set<any>();
  let mode: "issue" | "redirect" | "oversized" | "slow" = "issue";
  let sinkHits = 0;
  const sink = createServer({ key, cert }, (_req, res) => {
    sinkHits++;
    res.end("never follow");
  });
  sink.listen(0, "127.0.0.1");
  await once(sink, "listening");
  const sinkPort = (sink.address() as any).port;
  const server = createServer({ key, cert }, (req, res) => {
    requests.push({
      url: req.url!,
      authorization: req.headers.authorization,
      method: req.method,
    });
    if (mode === "redirect") {
      res.writeHead(302, { location: `https://127.0.0.1:${sinkPort}/steal` });
      res.end("redirect");
      return;
    }
    res.setHeader("content-type", "application/json");
    if (mode === "oversized") {
      res.end("x".repeat(2048));
      return;
    }
    if (mode === "slow") {
      res.write("{");
      return;
    }
    res.end(
      JSON.stringify({
        id: "1",
        key: "APP-1",
        fields: {
          summary: "TLS harness",
          description: null,
          status: { name: "Open" },
          issuetype: { name: "Task" },
        },
      }),
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as any).port;
  const base: JiraConnection = {
    id: "loopback",
    deployment: "cloud",
    accountContextId: "harness",
    webBaseUrl: `https://localhost:${port}`,
    apiBaseUrl: `https://localhost:${port}`,
    credential: {
      kind: "callback",
      resolve: () => ({ Authorization: "Bearer LOCAL-HARNESS-ONLY" }),
    },
    limits: { timeoutMs: 1000, maxResponseBytes: 1024 },
  };
  try {
    const untrusted = await new JiraCloudAdapter(base).capture("APP-1");
    assert.equal(untrusted.state, "communication_error");
    assert.equal(requests.length, 0);
    const wrongHost = await new JiraCloudAdapter({
      ...base,
      apiBaseUrl: `https://127.0.0.1:${port}`,
      customCaPem: cert,
    }).capture("APP-1");
    assert.equal(wrongHost.state, "communication_error");
    assert.equal(requests.length, 0);
    const adapter = new JiraCloudAdapter({ ...base, customCaPem: cert });
    const captured = await adapter.capture("APP-1");
    assert.equal(captured.state, "captured");
    assert.equal(requests[0].authorization, "Bearer LOCAL-HARNESS-ONLY");
    assert.equal(requests[0].method, "GET");
    assert.match(requests[0].url, /^\/rest\/api\/3\/issue\/APP-1\?fields=/);
    mode = "redirect";
    assert.deepEqual(await adapter.capture("APP-1"), {
      state: "communication_error",
      reason: "redirect_rejected",
    });
    assert.equal(sinkHits, 0);
    mode = "oversized";
    assert.deepEqual(await adapter.capture("APP-1"), {
      state: "communication_error",
      reason: "response_too_large",
    });
    mode = "slow";
    const timedOut = await new JiraCloudAdapter({
      ...base,
      customCaPem: cert,
      limits: { timeoutMs: 60 },
    }).capture("APP-1");
    assert.deepEqual(timedOut, {
      state: "communication_error",
      reason: "timeout",
    });
    assert.equal(sinkHits, 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise<void>((r) => server.close(() => r())),
      new Promise<void>((r) => sink.close(() => r())),
    ]);
    rmSync(dir, { recursive: true, force: true });
  }
});
