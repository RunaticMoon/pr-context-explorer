import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import type { RequestListener } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import type { Duplex } from "node:stream";
import { JiraCloudAdapter } from "../src/server/jira/index.ts";

// Real TLS, ephemeral CA and synthetic credentials only; not a Jira account smoke.
async function withHttps(
  respond: RequestListener,
  run: (adapter: JiraCloudAdapter) => Promise<void>,
  credential = `test-${randomUUID()}`,
) {
  const dir = await mkdtemp("/tmp/jira-validation-");
  const keyPath = `${dir}/key.pem`,
    certPath = `${dir}/cert.pem`;
  const sockets = new Set<Duplex>();
  let server: ReturnType<typeof createServer> | undefined;
  try {
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
    const cert = await readFile(certPath, "utf8");
    server = createServer(
      { key: await readFile(keyPath), cert },
      (req, res) => {
        assert.ok(
          req.headers.authorization === `Bearer ${credential}`,
          "expected harness authorization",
        );
        res.setHeader("content-type", "application/json");
        respond(req, res);
      },
    );
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `https://localhost:${address.port}`;
    await run(
      new JiraCloudAdapter({
        id: "validation-local",
        deployment: "cloud",
        accountContextId: "harness",
        webBaseUrl: base,
        apiBaseUrl: base,
        customCaPem: cert,
        credential: {
          kind: "callback",
          resolve: () => ({ Authorization: `Bearer ${credential}` }),
        },
        limits: { timeoutMs: 2000 },
      }),
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}
const issue = () => ({
  id: "1",
  key: "APP-1",
  fields: { summary: "TLS control", description: null },
});

test("HTTPS malformed nested ADF remains partial with exact source pointers and bytes", async () => {
  const description = {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: "MALFORMED-SOURCE-CONTENT" }],
  };
  const issueBody = JSON.stringify({
    ...issue(),
    fields: { summary: "ADF harness", description },
  });
  const commentBody = JSON.stringify({
    startAt: 0,
    total: 1,
    comments: [{ id: "2", body: description }],
  });
  await withHttps(
    (req, res) =>
      res.end(req.url?.includes("/comment?") ? commentBody : issueBody),
    async (adapter) => {
      const result = await adapter.capture("APP-1", {
        comments: { maxComments: 1 },
      });
      assert.equal(result.state, "captured");
      if (result.state !== "captured") return;
      assert.equal(result.snapshot.description.coverage, "partial");
      assert.deepEqual(result.snapshot.description.unsupportedPointers, [
        "/fields/description/content/0/content",
      ]);
      assert.deepEqual(result.snapshot.description.raw, description);
      assert.equal(result.snapshot.source.rawResponse, issueBody);
      assert.equal(
        result.snapshot.sourceHash,
        createHash("sha256").update(issueBody).digest("hex"),
      );
      assert.equal(result.snapshot.comments[0].body.coverage, "partial");
      assert.deepEqual(result.snapshot.comments[0].body.unsupportedPointers, [
        "/comments/0/body/content/0/content",
      ]);
      assert.equal(result.snapshot.commentPages[0].rawResponse, commentBody);
    },
  );
});

test("HTTPS rejects escaped credential keys and values before retaining issue or comment sources", async (t) => {
  const credential = `test-${randomUUID()}`;
  let issueBody = JSON.stringify(issue()),
    commentBody = "";
  await withHttps(
    (req, res) =>
      res.end(req.url?.includes("/comment?") ? commentBody : issueBody),
    async (adapter) => {
      const control = await adapter.capture("APP-1");
      assert.equal(control.state, "captured");
      if (control.state !== "captured") return;
      assert.equal(control.snapshot.source.rawResponse, issueBody);
      assert.equal(
        control.snapshot.sourceHash,
        createHash("sha256").update(issueBody).digest("hex"),
      );
      for (const endpoint of ["issue", "comments"] as const) {
        for (const location of ["value", "key", "nested"] as const) {
          await t.test(`${endpoint}: escaped ${location}`, async () => {
            issueBody = JSON.stringify(issue());
            const reflection =
              location === "key"
                ? { [credential]: "untrusted" }
                : location === "nested"
                  ? {
                      children: [
                        { nested: [{ text: `Bearer ${credential}` }] },
                      ],
                    }
                  : { text: credential };
            const raw =
              endpoint === "issue"
                ? { ...issue(), extra: reflection }
                : {
                    startAt: 0,
                    total: 1,
                    comments: [{ id: "2", body: "safe", extra: reflection }],
                  };
            const encoded = JSON.stringify(raw).replaceAll(
              credential,
              credential.replaceAll("-", "\\u002d"),
            );
            assert.ok(
              !encoded.includes(credential),
              "wire bytes must exercise escaped rather than literal detection",
            );
            if (endpoint === "issue") issueBody = encoded;
            else commentBody = encoded;
            const result = await adapter.capture(
              "APP-1",
              endpoint === "comments" ? { comments: { maxComments: 1 } } : {},
            );
            assert.ok(
              !JSON.stringify(result).includes(credential),
              "no decoded credential may escape in a snapshot",
            );
            if (endpoint === "issue") {
              assert.deepEqual(result, {
                state: "communication_error",
                reason: "credential_reflection",
              });
            } else {
              assert.equal(result.state, "captured");
              if (result.state !== "captured") return;
              assert.equal(
                result.snapshot.coverage.comments.state,
                "unavailable",
              );
              assert.equal(
                result.snapshot.coverage.comments.reason,
                "credential_reflection",
              );
              assert.deepEqual(result.snapshot.commentPages, []);
              assert.deepEqual(result.snapshot.comments, []);
            }
          });
        }
      }
    },
    credential,
  );
});
