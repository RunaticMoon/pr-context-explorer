import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { realpathSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceBridge } from "../src/server/source-bridge.ts";
import { LocalStore } from "../src/server/store.ts";
import {
  JiraCloudAdapter,
  JiraDataCenterAdapter,
} from "../src/server/jira/index.ts";
import { nodeJiraTransport } from "../src/server/jira/transport.ts";

// Real HTTPS loopback protocol fixture, not a live Jira tenant/account.
test("HTTPS onboarding -> secret-free persisted mapping -> authenticated issue capture; TLS/redirect/auth failures closed", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jira-connect-tls-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keyPath = join(root, "key.pem"),
    certPath = join(root, "cert.pem");
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
  const cert = readFileSync(certPath, "utf8");
  let mode = "normal";
  const seen: string[] = [];
  const server = createServer(
    { key: readFileSync(keyPath), cert },
    (req, res) => {
      seen.push(req.url!);
      if (mode === "redirect") {
        res.writeHead(302, { location: "https://never-follow.invalid/steal" });
        res.end();
        return;
      }
      if (mode === "denied") {
        res.writeHead(401);
        res.end("DO-NOT-SERIALIZE-ERROR");
        return;
      }
      res.setHeader("content-type", "application/json");
      const cloud = req.url!.includes("/api/3/");
      const expected = cloud
        ? "Basic " + Buffer.from("a@b.test:TLS-FAKE-ONLY").toString("base64")
        : "Bearer TLS-FAKE-ONLY";
      assert.equal(req.headers.authorization, expected);
      if (mode === "reflection") {
        res.end('{"accountId":"\\u0054LS-FAKE-ONLY"}');
        return;
      }
      res.end(
        JSON.stringify(
          req.url!.endsWith("/myself")
            ? cloud
              ? { accountId: "real-cloud-id" }
              : { name: "real-dc-name" }
            : req.url!.endsWith("/serverInfo")
              ? { version: "9.12.2" }
              : {
                  id: "1",
                  key: "APP-1",
                  fields: {
                    summary: "Fixture issue",
                    description: null,
                    status: { name: "Open" },
                    issuetype: { name: "Task" },
                  },
                },
        ),
      );
    },
  );
  let cleanupRoutes: SourceBridge | undefined;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `https://localhost:${(server.address() as any).port}`;
    const store = new LocalStore(join(root, "store"));
    const routes = new SourceBridge(store, { transport: nodeJiraTransport });
    cleanupRoutes = routes;
    const connect = (deployment: "cloud" | "data_center", ca = true) =>
      routes.handle("POST", new URL("http://127.0.0.1/api/jira/connect"), {
        deployment,
        webUrl: base + (deployment === "data_center" ? "/jira" : ""),
        authentication: "token",
        token: "TLS-FAKE-ONLY",
        ...(deployment === "cloud" ? { email: "a@b.test" } : {}),
        advanced: ca ? { customCaPem: cert } : {},
      });
    for (const deployment of ["cloud", "data_center"] as const) {
      const reply = await connect(deployment);
      assert.equal(reply?.status, 201, JSON.stringify(reply));
      const c = (reply!.data as any).settings.connections.find(
        (c: any) => c.deployment === deployment,
      );
      const adapter =
        deployment === "cloud"
          ? new JiraCloudAdapter(routes.bind(c))
          : new JiraDataCenterAdapter(routes.bind(c));
      const capture = await adapter.capture("APP-1");
      assert.equal(capture.state, "captured");
      assert.ok(!JSON.stringify(capture).includes("TLS-FAKE-ONLY"));
      assert.equal(
        c.accountContextId,
        deployment === "cloud" ? "real-cloud-id" : "real-dc-name",
      );
    }
    assert.ok(seen.includes("/jira/rest/api/2/myself"));
    const tls = await connect("cloud", false);
    assert.equal(tls?.status, 400);
    assert.match(JSON.stringify(tls), /tls_certificate_error/);
    for (const [state, reason] of [
      ["redirect", "redirect_rejected"],
      ["denied", "unknown_or_forbidden"],
      ["reflection", "credential_reflection"],
    ]) {
      mode = state;
      const reply = await connect("cloud");
      assert.equal(reply?.status, 400);
      assert.match(JSON.stringify(reply), new RegExp(reason));
      assert.ok(!JSON.stringify(reply).includes("TLS-FAKE-ONLY"));
      assert.ok(!JSON.stringify(reply).includes("DO-NOT-SERIALIZE"));
    }
    routes.close();
    const settings = (await routes.handle(
      "GET",
      new URL("http://127.0.0.1/api/jira/settings"),
      undefined,
    ))!.data as any;
    assert.equal(
      (
        await new JiraCloudAdapter(
          routes.bind(settings.connections[0]),
        ).capture("APP-1")
      ).state,
      "unconnected",
    );
  } finally {
    cleanupRoutes?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
