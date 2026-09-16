import { test } from "node:test";
import { waitForFixture } from "./wait-for-fixture.ts";
import { once } from "node:events";
import assert from "node:assert/strict";
import { realpathSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveAPI } from "../src/server/live-api.ts";
import { GitHubClient } from "../src/server/github.ts";
import { githubSessionAvailable } from "../src/server/github-session-secrets.ts";

import { SourceBridge } from "../src/server/source-bridge.ts";
import { LocalStore } from "../src/server/store.ts";
import { JiraReadSession } from "../src/server/jira/session.ts";
import { connectionSettings } from "../src/server/jira/connection.ts";
import type { JiraAdapterDependencies } from "../src/server/jira/types.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const url = (path: string) => new URL("http://localhost" + path);
test("GitHub close cancels paused onboarding before release and cannot resurrect persisted credentials", async (t) => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "credential-lifecycle-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const started = gate(),
    release = gate();
  let ref = "";
  const api = new LiveAPI({
    dataDir: root,
    client: (c) => {
      if (c.auth.kind === "session") ref = c.auth.sessionId;
      return new GitHubClient(c, {
        transport: async () => {
          started.resolve();
          await release.promise;
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({ login: "fixture", id: 732 }),
          };
        },
      });
    },
  });
  try {
    const pending = api.handle("POST", url("/api/connections/connect"), {
      webUrl: "https://github.com",
      token: "FAKE_LIFECYCLE_ONLY",
    });
    const outcome = pending.then(
      () => "succeeded",
      (e) => e.message,
    );
    await waitForFixture(started.promise);
    api.close();
    const result = await Promise.race([
      outcome,
      new Promise<string>((r) => setTimeout(() => r("still pending"), 100)),
    ]);
    assert.match(result, /connection.*(closed|cancelled|failed)/i);
    assert.equal(githubSessionAvailable(ref), false);
    release.resolve();
    await outcome;
    await new Promise((r) => setImmediate(r));
    assert.equal(api.store.list("config").length, 0);
    await assert.rejects(
      api.handle("POST", url("/api/connections/connect"), {
        webUrl: "https://github.com",
        token: "FAKE_LIFECYCLE_ONLY",
      }),
      /closed/,
    );
  } finally {
    release.resolve();
    api.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const action of ["delete", "replace", "close"] as const) {
  test(`Jira ${action} revokes cached headers and aborts a paused capture without affecting another host`, async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "jira-lifecycle-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const started = gate(),
      release = gate();
    const seen: string[] = [];
    const deps: JiraAdapterDependencies = {
      transport: async (request) => {
        seen.push(request.url);
        if (request.url.endsWith("/paused")) {
          started.resolve();
          await release.promise;
        }
        return {
          status: 200,
          headers: {},
          body: (async function* () {
            yield Buffer.from(
              JSON.stringify(
                request.url.endsWith("/myself")
                  ? { name: "fixture" }
                  : { version: "9.0" },
              ),
            );
          })(),
        };
      },
    };
    const bridge = new SourceBridge(new LocalStore(root), deps);
    const connect = async (host = "jira.example") => {
      const reply = await bridge.handle("POST", url("/api/jira/connect"), {
        deployment: "data_center",
        webUrl: `https://${host}`,
        authentication: "token",
        token: "FAKE_JIRA_ONLY",
      });
      assert.equal(reply?.status, 201);
      return (reply!.data as any).settings.connections.find(
        (c: any) => c.webBaseUrl === `https://${host}`,
      );
    };
    const captures: JiraReadSession[] = [];
    const capture = (c: any) => {
      const v = connectionSettings(bridge.bind(c), "data_center");
      const s = new JiraReadSession(v.config, v.limits, deps);
      captures.push(s);
      return s;
    };
    try {
      const c = await connect(),
        other = await connect("other.example");
      const cached = capture(c),
        paused = capture(c),
        unrelated = capture(other);
      await cached.get(new URL(c.apiBaseUrl + "/rest/api/2/issue/ABC-1"));
      const pending = paused
        .get(new URL(c.apiBaseUrl + "/rest/api/2/paused"))
        .then(
          () => "succeeded",
          (e) => e.message,
        );
      await waitForFixture(started.promise);
      if (action === "close") bridge.close();
      else if (action === "replace") await connect();
      else
        await bridge.handle("POST", url("/api/jira/settings"), {
          connections: [other],
          projectHosts: {},
        });
      const before = seen.length;
      await assert.rejects(
        cached.get(new URL(c.apiBaseUrl + "/rest/api/2/issue/ABC-1/comment")),
        /cancelled|credentials_unavailable/,
      );
      assert.equal(
        seen.length,
        before,
        "no request with revoked headers may leave",
      );
      assert.equal(
        await Promise.race([
          pending,
          new Promise((r) => setTimeout(() => r("still pending"), 100)),
        ]),
        "cancelled",
      );
      if (action !== "close")
        await unrelated.get(
          new URL(other.apiBaseUrl + "/rest/api/2/issue/ABC-1"),
        );
      release.resolve();
      await pending;
    } finally {
      release.resolve();
      captures.forEach((s) => s.close());
      bridge.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("SourceBridge shutdown rejects settings writes and preserves existing metadata", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jira-closed-store-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new LocalStore(root),
    bridge = new SourceBridge(store);
  try {
    await bridge.handle("POST", url("/api/jira/settings"), {
      connections: [],
      projectHosts: {},
    });
    const before = store.list("config");
    bridge.close();
    await assert.rejects(
      bridge.handle("POST", url("/api/jira/settings"), {
        connections: [],
        projectHosts: { ABC: [] },
      }),
      /closed/,
    );
    assert.deepEqual(store.list("config"), before);
  } finally {
    bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("real HTTPS Jira revocation aborts response wait and emits no subsequent Authorization", async (t) => {
  const { createServer } = await import("node:https");
  const { execFileSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const { nodeJiraTransport } = await import("../src/server/jira/transport.ts");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jira-lifecycle-tls-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const key = join(root, "key.pem"),
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
      key,
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
    started = gate();
  const seen: string[] = [];
  const server = createServer({ key: readFileSync(key), cert }, (req, res) => {
    seen.push(req.url!);
    assert.equal(req.headers.authorization, "Bearer TLS_FAKE_ONLY");
    if (req.url!.endsWith("/paused")) {
      started.resolve();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url!.endsWith("/myself") ? { name: "fixture" } : { version: "9.0" },
      ),
    );
  });
  let bridge: SourceBridge | undefined;
  let session: JiraReadSession | undefined;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `https://localhost:${(server.address() as any).port}`;
    bridge = new SourceBridge(new LocalStore(join(root, "store")), {
      transport: nodeJiraTransport,
    });
    const reply = await bridge.handle("POST", url("/api/jira/connect"), {
      deployment: "data_center",
      webUrl: base,
      authentication: "token",
      token: "TLS_FAKE_ONLY",
      advanced: { customCaPem: cert },
    });
    assert.equal(reply?.status, 201);
    const c = (reply!.data as any).settings.connections[0];
    const v = connectionSettings(bridge.bind(c), "data_center");
    session = new JiraReadSession(v.config, v.limits, {});
    await session.get(new URL(base + "/rest/api/2/issue/ABC-1"));
    const pending = session.get(new URL(base + "/rest/api/2/paused")).then(
      () => "succeeded",
      (e) => e.message,
    );
    await waitForFixture(started.promise);
    await bridge.handle("POST", url("/api/jira/settings"), {
      connections: [],
      projectHosts: {},
    });
    assert.equal(await pending, "cancelled");
    const before = seen.length;
    await assert.rejects(
      session.get(new URL(base + "/rest/api/2/issue/ABC-1/comment")),
      /cancelled/,
    );
    assert.equal(seen.length, before);
  } finally {
    session?.close();
    bridge?.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub close during reconnect preserves existing metadata and other API accounts", async (t) => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "github-reconnect-close-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const started = gate(),
    release = gate();
  let pause = false;
  const client = (c: any) =>
    new GitHubClient(c, {
      transport: async () => {
        if (pause) {
          started.resolve();
          await release.promise;
        }
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ login: "fixture", id: 732 }),
        };
      },
    });
  const api = new LiveAPI({ dataDir: join(root, "first"), client });
  const other = new LiveAPI({ dataDir: join(root, "other"), client });
  const connect = (a: LiveAPI) =>
    a.handle("POST", url("/api/connections/connect"), {
      webUrl: "https://github.com",
      token: "FAKE_RECONNECT_ONLY",
    });
  try {
    const first = await connect(api),
      independent = await connect(other);
    const ref = (first!.data as any).connection.auth.sessionId,
      otherRef = (independent!.data as any).connection.auth.sessionId;
    const before = api.store.list("config");
    pause = true;
    const outcome = connect(api).then(
      () => "succeeded",
      (e) => e.message,
    );
    await waitForFixture(started.promise);
    api.close();
    assert.match(await outcome, /GitHub connection failed/);
    assert.equal(githubSessionAvailable(ref), false);
    assert.equal(githubSessionAvailable(otherRef), true);
    release.resolve();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(api.store.list("config"), before);
    pause = false;
    assert.equal((await connect(other))?.status, 201);
  } finally {
    release.resolve();
    api.close();
    other.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("LiveAPI shutdown prevents a paused executor from writing pipeline cache or completing a job", async (t) => {
  const { richSnapshot } = await import("./integration-v3-fixture.ts");
  const { fakeEngineSetup } = await import("./fake-engine-setup.ts");
  const s = await richSnapshot(t),
    root = realpathSync(mkdtempSync(join(tmpdir(), "shutdown-cache-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const started = gate(),
    release = gate(),
    finished = gate();
  let writeError: unknown;
  const api = new LiveAPI({
    dataDir: root,
    engineSetup: fakeEngineSetup(),
    execute: async (...args) => {
      started.resolve();
      await release.promise;
      try {
        await args[6]!.cache!.set("v3:" + "a".repeat(64), {} as any);
      } catch (e) {
        writeError = e;
      } finally {
        finished.resolve();
      }
      throw Error("fixture executor ended");
    },
  });
  try {
    await api.handle("POST", url("/api/connections"), {
      id: s.connectionId,
      type: "github",
      webUrl: "https://github.com",
      apiUrl: "https://api.github.com",
      apiVersion: "2022-11-28",
      account: "fixture",
      auth: { kind: "public" },
    });
    api.store.put("snapshot", s.snapshotId, { snapshot: s, stale: false });
    const reply = await api.handle("POST", url("/api/live/run"), {
      snapshotId: s.snapshotId,
      providerId: "codex",
      model: "FAKE-no-inference",
      scope: { kind: "pr" },
      consent: true,
    });
    await waitForFixture(started.promise);
    api.close();
    release.resolve();
    await finished.promise;
    await new Promise((r) => setImmediate(r));
    assert.equal(
      api.store.list("chunk").length,
      0,
      "no persistent cache write after shutdown",
    );
    assert.ok(
      writeError,
      "cache write rejects rather than silently succeeding",
    );
    assert.equal(
      api.jobs.get((reply!.data as any).id)!.job.status,
      "cancelled",
    );
    assert.equal(api.store.list("analysis").length, 0);
  } finally {
    release.resolve();
    api.close();
    rmSync(root, { recursive: true, force: true });
  }
});
