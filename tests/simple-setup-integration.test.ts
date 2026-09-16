import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server/http.ts";
import { LiveAPI } from "../src/server/live-api.ts";
import { executeAnalysis } from "../src/server/live-analysis.ts";
import { richSnapshot, richRunner } from "./integration-v3-fixture.ts";
import { fakeEngineSetup } from "./fake-engine-setup.ts";
import { createServer as createHttps } from "node:https";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { LocalStore } from "../src/server/store.ts";

test("real protected HTTP Jira onboarding binds session credentials to snapshot capture and forgets them on restart", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "jira-live-http-")));
  const key = path.join(root, "key.pem"),
    certFile = path.join(root, "cert.pem");
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
      certFile,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(certFile, "utf8"),
    seen: string[] = [];
  const upstream = createHttps({ key: readFileSync(key), cert }, (req, res) => {
    seen.push(req.url!);
    assert.equal(
      req.headers.authorization,
      "Basic " +
        Buffer.from("fake@example.test:FAKE-HTTP-JIRA-ONLY").toString("base64"),
    );
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url!.endsWith("/myself")
          ? { accountId: "FAKE-account" }
          : req.url!.endsWith("/serverInfo")
            ? { version: "FAKE-version" }
            : {
                id: "1",
                key: "APP-1",
                fields: {
                  summary: "FAKE HTTP issue",
                  description: null,
                  status: { name: "Open" },
                  issuetype: { name: "Task" },
                },
              },
      ),
    );
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const s = await richSnapshot(t),
    dataDir = path.join(root, "store");
  new LocalStore(dataDir).put("snapshot", s.snapshotId, {
    snapshot: s,
    stale: false,
  });
  let app = await createApp(0, { dataDir });
  const start = async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(app.address() as any).port}`;
    const session = await fetch(origin + "/api/session", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: "{}",
    });
    const cookie = session.headers.get("set-cookie")!.split(";")[0],
      { csrf } = await session.json();
    return {
      origin,
      cookie,
      headers: {
        origin,
        cookie,
        "content-type": "application/json",
        "x-prce-csrf": csrf,
      },
    };
  };
  let auth = await start();
  const request = async (p: string, body?: unknown) => {
    const r = await fetch(
      auth.origin + p,
      body === undefined
        ? { headers: { cookie: auth.cookie } }
        : { method: "POST", headers: auth.headers, body: JSON.stringify(body) },
    );
    const d = await r.json();
    assert.ok(r.ok, JSON.stringify(d));
    return d;
  };
  const capture = async () => {
    const j = await request("/api/jira/capture", { snapshotId: s.snapshotId });
    for (let i = 0; i < 200; i++) {
      const result = await request("/api/live/job?id=" + j.id);
      if (!["queued", "running"].includes(result.status)) return result;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error("capture timeout");
  };
  try {
    assert.equal(
      (
        await fetch(auth.origin + "/api/jira/connect", {
          method: "POST",
          headers: { origin: auth.origin, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(auth.origin + "/api/jira/connect", {
          method: "POST",
          headers: {
            origin: auth.origin,
            cookie: auth.cookie,
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    const connected = await request("/api/jira/connect", {
      deployment: "cloud",
      webUrl: `https://localhost:${(upstream.address() as any).port}`,
      authentication: "token",
      email: "fake@example.test",
      token: "FAKE-HTTP-JIRA-ONLY",
      advanced: { customCaPem: cert },
    });
    assert.equal(connected.summary.accountId, "FAKE-account");
    assert.ok(
      !JSON.stringify(await request("/api/jira/settings")).includes(
        "FAKE-HTTP-JIRA-ONLY",
      ),
    );
    await request("/api/jira/candidates/edit", {
      snapshotId: s.snapshotId,
      connectionId: connected.settings.connections[0].id,
      key: "APP-1",
    });
    const job = await capture();
    assert.equal(job.processStatus, "succeeded", job.error);
    assert.ok(
      job.result.snapshot.sourceEvidence.some(
        (e: any) => e.sourceKind === "jira" && e.text === "FAKE HTTP issue",
      ),
    );
    assert.ok(seen.some((p) => p.includes("/issue/APP-1")));
    const saved = await request(
      "/api/live/snapshot?id=" + job.result.snapshot.snapshotId,
    );
    assert.ok(!JSON.stringify(saved).includes("FAKE-HTTP-JIRA-ONLY"));
    await new Promise<void>((r) => app.close(() => r()));
    app = await createApp(0, { dataDir });
    auth = await start();
    const before = seen.length,
      restarted = await capture();
    assert.equal(seen.length, before);
    assert.ok(
      !restarted.result.snapshot.sourceEvidence.some(
        (e: any) => e.sourceKind === "jira",
      ),
    );
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("PR and selected-code jobs receive resolved server config through the existing pipeline; cache reads do not resolve or rerun", async (t) => {
  const s = await richSnapshot(t),
    calls: any[] = [],
    configs: any[] = [],
    resolved: string[] = [];
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "setup-pipeline-")));
  const config = {
    providers: { codex: { executablePath: "/FAKE/server-only-codex" } },
  };
  const engineSetup = fakeEngineSetup(config);
  engineSetup.resolveConfig = async (provider) => {
    resolved.push(provider);
    return config;
  };
  const api = new LiveAPI({
    dataDir: root,
    engineSetup,
    runner: richRunner(s, calls),
    execute: async (...args) => {
      configs.push((args[6] as any).config);
      return executeAnalysis(...args);
    },
  });
  t.after(() => {
    api.close();
    rmSync(root, { recursive: true, force: true });
  });
  const request = async (p: string, method = "GET", body: any = {}) =>
    (await api.handle(method, new URL("http://127.0.0.1" + p), body))!
      .data as any;
  await request("/api/connections", "POST", {
    id: s.connectionId,
    type: "github",
    webUrl: "https://github.com",
    apiUrl: "https://api.github.com",
    apiVersion: "2022-11-28",
    account: "FAKE",
    auth: { kind: "public" },
  });
  api.store.put("snapshot", s.snapshotId, { snapshot: s, stale: false });
  const ev = s.phases
    .find((p) => p.sha === s.headSha)!
    .files.find((f) => f.content && f.status !== "deleted")!;
  const payload = {
    snapshotId: s.snapshotId,
    providerId: "codex",
    model: "FAKE-not-inference",
    consent: true,
    scope: { kind: "pr" },
  };
  for (const scope of [
    { kind: "pr" },
    {
      kind: "code",
      commitSha: s.headSha,
      fileId: ev.id,
      side: "new",
      lineStart: 1,
      lineEnd: 1,
      question: "FAKE explain",
    },
  ]) {
    const started = await request("/api/live/run", "POST", {
      ...payload,
      scope,
    });
    let job: any;
    for (let i = 0; i < 300; i++) {
      job = api.jobs.get(started.id)!.job;
      if (!["queued", "running"].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(job.processStatus, "succeeded", job.error);
    assert.deepEqual(configs.at(-1), config);
    const count = calls.length,
      resolves = resolved.length;
    await request("/api/live/analysis?key=" + job.result.cacheKey);
    const cached = await request("/api/live/run", "POST", {
      ...payload,
      scope,
    });
    assert.equal(cached.cached, true);
    assert.equal(calls.length, count);
    assert.equal(resolved.length, resolves);
  }
  assert.deepEqual(resolved, ["codex", "codex"]);
});

test("engine setup is a real authenticated HTTP route with strict CSRF and JSON boundaries", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "setup-http-")));
  const app = await createApp(0, { dataDir: root });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(app.address() as any).port}`;
  try {
    assert.equal((await fetch(origin + "/api/engines/setup")).status, 401);
    const session = await fetch(origin + "/api/session", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: "{}",
    });
    const cookie = session.headers.get("set-cookie")!.split(";")[0];
    const { csrf } = await session.json();
    const headers = {
      origin,
      cookie,
      "content-type": "application/json",
      "x-prce-csrf": csrf,
    };
    const get = await fetch(origin + "/api/engines/setup", {
      headers: { cookie },
    });
    assert.equal(get.status, 200);
    const status = await get.json();
    t.diagnostic(
      "REAL credential-free host discovery: " +
        JSON.stringify(
          status.engines.map((e: any) => ({
            providerId: e.providerId,
            installed: e.installed,
            ready: e.ready,
            inferenceVerified: e.inferenceVerified,
            blockers: e.blockers,
          })),
        ),
    );
    assert.deepEqual(status.engines.map((e: any) => e.providerId).sort(), [
      "claude",
      "codex",
    ]);
    for (const e of status.engines)
      if (!e.isolation.runtimeVerified) assert.equal(e.ready, false);
    assert.equal(
      (
        await fetch(origin + "/api/engines/setup", {
          method: "POST",
          headers: { origin, cookie, "content-type": "application/json" },
          body: '{"action":"rescan"}',
        })
      ).status,
      403,
    );
    for (const body of [
      { action: "rescan", executablePath: "/tmp/evil" },
      {
        action: "reuse-auth",
        providerId: "codex",
        candidateId: "fake",
        auth: { path: "/tmp/secret" },
      },
      { action: "rescan", config: {} },
      { action: "login" },
      [],
    ]) {
      assert.equal(
        (
          await fetch(origin + "/api/engines/setup", {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          })
        ).status,
        400,
      );
    }
    assert.equal(
      (
        await fetch(origin + "/api/engines/setup", {
          method: "POST",
          headers: { ...headers, origin: "https://evil.invalid" },
          body: '{"action":"rescan"}',
        })
      ).status,
      403,
    );
    const rescan = await fetch(origin + "/api/engines/setup", {
      method: "POST",
      headers,
      body: '{"action":"rescan"}',
    });
    assert.equal(rescan.status, 200);
    assert.equal((await rescan.json()).engines.length, 2);
    assert.equal(
      (
        await fetch(origin + "/api/jira/connect", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      400,
    );
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});
