import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalStore } from "../src/server/store.ts";
import * as bridge from "../src/server/source-bridge.ts";
const response = (value: unknown) => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: (async function* () {
    yield Buffer.from(JSON.stringify(value));
  })(),
});

test("real source route registers derived connection and settings remain secret-free, delete revokes binding", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "jira-onboarding-"));
  try {
    const SourceBridge = (bridge as any).SourceBridge;
    assert.equal(
      typeof SourceBridge,
      "function",
      "SourceBridge route controller must exist",
    );
    const routes = new SourceBridge(new LocalStore(root), {
      transport: async (r: any) =>
        response(
          r.url.endsWith("/myself")
            ? { accountId: "account-from-jira" }
            : { version: "1001" },
        ),
    });
    const url = new URL("http://127.0.0.1/api/jira/connect");
    const reply = await routes.handle("POST", url, {
      deployment: "cloud",
      webUrl: "https://jira.test",
      authentication: "token",
      email: "a@b.test",
      token: "DO-NOT-PERSIST",
      advanced: {
        projectKeys: ["APP"],
        acceptanceCriteriaFields: [{ id: "customfield_10001" }],
      },
    });
    assert.equal(reply.status, 201);
    const settings = reply.data.settings;
    assert.equal(settings.connections[0].accountContextId, "account-from-jira");
    assert.equal(settings.projectHosts.APP[0], settings.connections[0].id);
    assert.equal(settings.connections[0].authentication, "session");
    assert.ok(!JSON.stringify(reply).includes("DO-NOT-PERSIST"));
    const fetched = await routes.handle(
      "GET",
      new URL("http://127.0.0.1/api/jira/settings"),
      undefined,
    );
    assert.deepEqual(fetched.data, settings);
    for (const file of readdirSync(root, { recursive: true }).filter((x) =>
      String(x).endsWith(".json"),
    ))
      assert.ok(
        !readFileSync(path.join(root, String(file)), "utf8").includes(
          "DO-NOT-PERSIST",
        ),
      );
    assert.equal(
      routes.bind(settings.connections[0]).credential.kind,
      "callback",
    );
    await routes.handle("POST", new URL("http://127.0.0.1/api/jira/settings"), {
      connections: [],
      projectHosts: {},
    });
    assert.equal(routes.bind(settings.connections[0]).credential, undefined);
    routes.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
