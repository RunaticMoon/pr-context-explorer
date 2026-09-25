import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LiveAPI } from "../src/server/live-api.ts";
import {
  HttpEngineSetup,
  type HttpVerifier,
} from "../src/server/http-engine-setup.ts";
import { AnalysisConsentStore } from "../src/server/analysis-consent.ts";
import { fakeEngineSetup } from "./fake-engine-setup.ts";
import { waitForFixture } from "./wait-for-fixture.ts";
import type { HttpEngineView } from "../src/ai-contract.ts";

const API_KEY = "sk-live-api-CANARY-8f2e6d1b";
const SETUP_URL = new URL("http://localhost/api/engines/setup");

const okVerifier: HttpVerifier = async () => {};

function fixture(verifier: HttpVerifier = okVerifier) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "live-http-")));
  const consent = new AnalysisConsentStore();
  const httpSetup = new HttpEngineSetup({ verifier });
  const api = new LiveAPI({
    dataDir: root,
    engineSetup: fakeEngineSetup(),
    httpSetup,
    consentStore: consent,
  });
  return {
    root,
    api,
    consent,
    httpSetup,
    cleanup: () => {
      api.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function configureBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action: "configure-http",
    providerId: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    model: "mock-model",
    apiKey: API_KEY,
    ...overrides,
  };
}

function httpView(res: { status: number; data: unknown } | null) {
  assert.equal(res?.status, 200, JSON.stringify(res?.data));
  const view = (res!.data as { http: HttpEngineView | null }).http;
  assert.ok(view);
  return view;
}

test("GET and CLI actions carry the credential-free http view; configure-http sets it", async (t) => {
  const { api, consent, httpSetup, cleanup } = fixture();
  t.after(cleanup);
  assert.equal(api.httpSetup, httpSetup);
  assert.equal(api.consent, consent);

  const get = await api.handle("GET", SETUP_URL, undefined);
  assert.equal(get?.status, 200);
  const first = get!.data as any;
  assert.equal(first.http, null);
  assert.deepEqual(first.engines.map((e: any) => e.providerId).sort(), [
    "claude",
    "codex",
  ]);

  const body = configureBody();
  const configured = httpView(await api.handle("POST", SETUP_URL, body));
  assert.equal(configured.providerId, "openai-compatible");
  assert.equal(configured.transport, "http");
  assert.equal(configured.hasApiKey, true);
  assert.equal(configured.verification, "not_checked");
  assert.equal(configured.host, "api.example.com");
  assert.equal("apiKey" in body, false);

  const after = (await api.handle("GET", SETUP_URL, undefined))!.data as any;
  assert.equal(after.http.configId, configured.configId);
  assert.equal(after.http.hasApiKey, true);
  for (const payload of [get!.data, after]) {
    const json = JSON.stringify(payload);
    assert.equal(json.includes(API_KEY), false);
    assert.equal(json.includes(API_KEY.slice(-6)), false);
    assert.equal(json.includes("/v1"), false);
  }

  // Existing CLI action shape is preserved with http added alongside engines.
  const rescan = (await api.handle("POST", SETUP_URL, { action: "rescan" }))!
    .data as any;
  assert.deepEqual(rescan.engines.map((e: any) => e.providerId).sort(), [
    "claude",
    "codex",
  ]);
  assert.equal(rescan.http.configId, configured.configId);
  assert.equal(JSON.stringify(rescan).includes(API_KEY), false);
});

test("verify-http reports verified and forget-http drops the key", async (t) => {
  const { api, cleanup } = fixture();
  t.after(cleanup);
  const configured = httpView(
    await api.handle("POST", SETUP_URL, configureBody()),
  );
  const verified = httpView(
    await api.handle("POST", SETUP_URL, {
      action: "verify-http",
      configId: configured.configId,
      revision: configured.revision,
      consent: true,
    }),
  );
  assert.equal(verified.verification, "verified");
  assert.equal(verified.ready, true);
  const forgot = httpView(
    await api.handle("POST", SETUP_URL, {
      action: "forget-http",
      configId: verified.configId,
      revision: verified.revision,
    }),
  );
  assert.equal(forgot.hasApiKey, false);
  assert.equal(forgot.ready, false);
  assert.equal(forgot.revision, verified.revision + 1);
});

test("invalid http action bodies return 400 and scrub apiKey", async (t) => {
  const { api, cleanup } = fixture();
  t.after(cleanup);
  const keyed = configureBody({ apiKey: 42 });
  const bad: Record<string, unknown>[] = [
    keyed,
    configureBody({ extra: 1 }),
    { action: "configure-http", providerId: "openai-compatible" },
    { action: "verify-http", configId: "c", revision: 1 },
    { action: "verify-http", configId: "c", revision: 1, consent: false },
    { action: "forget-http", configId: "c" },
  ];
  for (const body of bad) {
    const res = await api.handle("POST", SETUP_URL, body);
    assert.equal(res?.status, 400, JSON.stringify(body));
    assert.equal((res!.data as any).error, "http engine setup failed");
    assert.equal(JSON.stringify(res!.data).includes(API_KEY), false);
  }
  assert.equal("apiKey" in keyed, false);
});

test("an active analysis job blocks http setup actions with 409", async (t) => {
  const { api, cleanup } = fixture();
  t.after(cleanup);
  api.jobs.set("active", {
    job: { kind: "analysis", status: "running" } as any,
    controller: new AbortController(),
  });
  for (const body of [
    configureBody(),
    { action: "verify-http", configId: "c", revision: 1, consent: true },
    { action: "forget-http", configId: "c", revision: 1 },
  ])
    assert.equal((await api.handle("POST", SETUP_URL, body))?.status, 409);
});

test("an in-flight connection check keeps the busy lock", async (t) => {
  let release!: () => void, entered!: () => void;
  const begun = new Promise<void>((r) => (entered = r));
  const held = new Promise<void>((r) => (release = r));
  const { api, cleanup } = fixture(async () => {
    entered();
    await held;
  });
  t.after(cleanup);
  try {
    const configured = httpView(
      await api.handle("POST", SETUP_URL, configureBody()),
    );
    const pending = api.handle("POST", SETUP_URL, {
      action: "verify-http",
      configId: configured.configId,
      revision: configured.revision,
      consent: true,
    });
    await waitForFixture(begun, pending);
    assert.equal(
      (await api.handle("POST", new URL("http://localhost/api/live/run"), {}))
        ?.status,
      409,
    );
    assert.equal(
      (await api.handle("POST", SETUP_URL, { action: "rescan" }))?.status,
      409,
    );
    release();
    const res = await pending;
    assert.equal(res?.status, 200);
    assert.equal((res!.data as any).http.verification, "verified");
  } finally {
    release();
  }
});

test("reconfigure invalidates issued plans bound to the config id", async (t) => {
  const { api, consent, cleanup } = fixture();
  t.after(cleanup);
  const configured = httpView(
    await api.handle("POST", SETUP_URL, configureBody()),
  );
  const planId = consent.issuePlan({
    snapshotId: "snap",
    scopeKey: "scope",
    providerId: "openai-compatible",
    model: "mock-model",
    configId: configured.configId,
    revision: configured.revision,
    audit: false,
    historical: false,
    maxProviderCalls: 4,
  });
  const cliPlanId = consent.issuePlan({
    snapshotId: "snap",
    scopeKey: "scope",
    providerId: "codex",
    model: "cli-model",
    audit: false,
    historical: false,
    maxProviderCalls: 1,
  });
  assert.ok(consent.peek(planId));
  const reconfigured = httpView(
    await api.handle("POST", SETUP_URL, {
      action: "configure-http",
      providerId: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      model: "other-model",
      configId: configured.configId,
      expectedRevision: configured.revision,
    }),
  );
  assert.equal(reconfigured.revision, configured.revision + 1);
  assert.equal(consent.peek(planId), undefined);
  assert.ok(consent.peek(cliPlanId));
});
