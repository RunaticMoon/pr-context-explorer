import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LiveAPI, type LiveAPIOptions } from "../src/server/live-api.ts";
import {
  HttpEngineSetup,
  type HttpVerifier,
} from "../src/server/http-engine-setup.ts";
import { AnalysisConsentStore } from "../src/server/analysis-consent.ts";
import { fakeEngineSetup } from "./fake-engine-setup.ts";
import { richSnapshot, richRunner } from "./integration-v3-fixture.ts";
import { executeAnalysis } from "../src/server/live-analysis.ts";
import { cacheKey } from "../src/server/store.ts";
import { AIError } from "../src/server/ai/errors.ts";
import type { LocalProviderId } from "../src/ai-contract.ts";
import type {
  LiveSnapshot,
  PipelineRunner,
} from "../src/server/analysis-v3/index.ts";

// Deterministic runner fixtures and an in-memory engine store only — no real
// provider traffic, CLI processes, or credentials leave this file.
const API_KEY = "sk-live-api-run-CANARY-3d9a2f1e";
const MODEL = "mock-model";
const BASE_URL = "https://api.example.com/v1";

const url = (p: string) => new URL("http://localhost" + p);

async function finish(api: LiveAPI, id: string) {
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 5));
    const j = api.jobs.get(id)!.job;
    if (!["queued", "running"].includes(j.status)) return j;
  }
  throw Error("bounded fixture job timeout");
}

/** Fixture runner that reports the public HTTP engine identity in stage
 * metadata the same way the real OpenAI-compatible adapter does. */
function httpEchoRunner(s: LiveSnapshot, calls: any[]): PipelineRunner {
  const base = richRunner(s, calls);
  return async (request) => {
    const result = await base(request);
    return {
      output: result.output,
      metadata: {
        ...result.metadata,
        transport: "http",
        host: request.engine?.host,
        configId: request.engine?.configId,
        revision: request.engine?.revision,
      },
    };
  };
}

async function fixture(
  t: { after: (fn: () => void) => void },
  opts: {
    verifier?: HttpVerifier;
    runner?: (s: LiveSnapshot, calls: any[]) => PipelineRunner;
    execute?: LiveAPIOptions["execute"];
  } = {},
) {
  const s = await richSnapshot(t);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "live-http-run-")));
  const consent = new AnalysisConsentStore();
  const httpSetup = new HttpEngineSetup({
    verifier: opts.verifier ?? (async () => {}),
  });
  const stats = { resolveConfig: 0 };
  const base = fakeEngineSetup();
  const calls: any[] = [];
  const api = new LiveAPI({
    dataDir: root,
    engineSetup: {
      ...base,
      resolveConfig: (providerId: LocalProviderId) => {
        stats.resolveConfig += 1;
        return base.resolveConfig(providerId);
      },
    },
    httpSetup,
    consentStore: consent,
    runner: (opts.runner ?? httpEchoRunner)(s, calls),
    ...(opts.execute ? { execute: opts.execute } : {}),
  });
  api.store.put("config", cacheKey({ connection: s.connectionId }), {
    id: s.connectionId,
    type: "github",
    webUrl: "https://github.com",
    apiUrl: "https://api.github.com",
    apiVersion: "2022-11-28",
    account: "fixture",
    auth: { kind: "public" },
  });
  api.store.put("snapshot", s.snapshotId, { snapshot: s, stale: false });
  t.after(() => {
    api.close();
    rmSync(root, { recursive: true, force: true });
  });
  const configure = async () => {
    const created = httpSetup.configure({
      providerId: "openai-compatible",
      baseUrl: BASE_URL,
      model: MODEL,
      apiKey: API_KEY,
    });
    return httpSetup.verify({
      configId: created.configId,
      revision: created.revision,
      consent: true,
    });
  };
  const plan = (body: unknown) =>
    api.handle("POST", url("/api/live/plan"), body);
  const run = (body: unknown) => api.handle("POST", url("/api/live/run"), body);
  const planBody = (over: Record<string, unknown> = {}) => ({
    snapshotId: s.snapshotId,
    scope: { kind: "pr" },
    audit: false,
    providerId: "openai-compatible",
    model: MODEL,
    ...over,
  });
  const runBody = (planId?: string, over: Record<string, unknown> = {}) => ({
    snapshotId: s.snapshotId,
    providerId: "openai-compatible",
    model: MODEL,
    scope: { kind: "pr" },
    consent: true,
    ...(planId !== undefined ? { planId } : {}),
    ...over,
  });
  return {
    s,
    api,
    consent,
    httpSetup,
    stats,
    calls,
    configure,
    plan,
    run,
    planBody,
    runBody,
  };
}

test("HTTP plan issues a planId bound to public engine identity; CLI plan is unchanged", async (t) => {
  const x = await fixture(t);
  const view = await x.configure();
  const res = await x.plan(x.planBody());
  assert.equal(res?.status, 200, JSON.stringify(res?.data));
  const data = res!.data as any;
  assert.match(data.planId, /^[0-9a-f]{32,128}$/);
  assert.deepEqual(data.engine, {
    transport: "http",
    providerId: "openai-compatible",
    model: MODEL,
    host: "api.example.com",
    configId: view.configId,
    revision: view.revision,
  });
  assert.equal(typeof data.maxProviderCalls, "number");
  assert.equal(typeof data.maxOutputTokensPerCall, "number");
  assert.equal(typeof data.totalOutputTokenReservation, "number");
  const json = JSON.stringify(data);
  for (const leak of [
    API_KEY,
    "apiKey",
    "getApiKey",
    "baseUrl",
    "Bearer",
    "/v1",
  ])
    assert.equal(json.includes(leak), false, leak);
  // The issued binding covers exactly the fields run recomputes.
  assert.deepEqual(x.consent.peek(data.planId), {
    snapshotId: x.s.snapshotId,
    scopeKey: cacheKey({ kind: "pr" }),
    providerId: "openai-compatible",
    model: MODEL,
    configId: view.configId,
    revision: view.revision,
    audit: false,
    historical: false,
    maxProviderCalls: data.maxProviderCalls,
    maxOutputTokensPerCall: data.maxOutputTokensPerCall,
    totalOutputTokenReservation: data.totalOutputTokenReservation,
  });
  // CLI/absent providerId keeps the legacy, planId-free response.
  for (const [body, auditCalls] of [
    [{ snapshotId: x.s.snapshotId, scope: { kind: "pr" }, audit: true }, 1],
    [x.planBody({ providerId: "codex" }), 0],
  ] as const) {
    const cli = await x.plan(body);
    assert.equal(cli?.status, 200);
    assert.equal((cli!.data as any).planId, undefined);
    assert.equal((cli!.data as any).engine, undefined);
    assert.equal((cli!.data as any).auditCalls, auditCalls);
  }
});

test("HTTP plan/run fail closed with a blocker code until the engine is verified", async (t) => {
  const x = await fixture(t);
  for (const attempt of [
    () => x.plan(x.planBody()),
    () => x.run(x.runBody("0".repeat(32))),
  ]) {
    const res = await attempt();
    assert.equal(res?.status, 409);
    assert.deepEqual(res!.data, {
      error: "http engine not ready",
      code: "auth_required",
    });
  }
  // Configured but not yet verified still blocks with the same fixed phrase.
  x.httpSetup.configure({
    providerId: "openai-compatible",
    baseUrl: BASE_URL,
    model: MODEL,
    apiKey: API_KEY,
  });
  const pending = await x.plan(x.planBody());
  assert.equal(pending?.status, 409);
  assert.equal((pending!.data as any).code, "auth_required");
  assert.equal(x.calls.length, 0);
});

test("a failed connection check surfaces its AIError code on plan", async (t) => {
  const x = await fixture(t, {
    verifier: async () => {
      throw new AIError("auth_invalid");
    },
  });
  const created = x.httpSetup.configure({
    providerId: "openai-compatible",
    baseUrl: BASE_URL,
    model: MODEL,
    apiKey: API_KEY,
  });
  await x.httpSetup.verify({
    configId: created.configId,
    revision: created.revision,
    consent: true,
  });
  const res = await x.plan(x.planBody());
  assert.equal(res?.status, 409);
  assert.deepEqual(res!.data, {
    error: "http engine not ready",
    code: "auth_invalid",
  });
});

test("plan/run reject browser-supplied engine fields and mismatched models", async (t) => {
  const x = await fixture(t);
  await x.configure();
  await assert.rejects(
    x.plan(x.planBody({ baseUrl: "https://attacker.invalid", apiKey: "k" })),
    /unsupported analysis request field/,
  );
  await assert.rejects(
    x.run(x.runBody("0".repeat(32), { baseUrl: "https://attacker.invalid" })),
    /unsupported analysis request field/,
  );
  await assert.rejects(
    x.plan(x.planBody({ model: "other-model" })),
    /explicit model required/,
  );
  const p = (await x.plan(x.planBody()))!.data as any;
  await assert.rejects(
    x.run(x.runBody(p.planId, { model: "other-model" })),
    /explicit model required/,
  );
  // A rejected model comparison never consumes the plan.
  assert.ok(x.consent.peek(p.planId));
});

test("HTTP run rejects missing, unknown, or mismatched plans with zero provider calls", async (t) => {
  const x = await fixture(t);
  await x.configure();
  await assert.rejects(x.run(x.runBody()), /analysis plan required/);
  const unknown = await x.run(x.runBody("0".repeat(32)));
  assert.equal(unknown?.status, 409);
  assert.deepEqual(unknown!.data, {
    error: "analysis plan required",
    code: "invalid_request",
  });
  // audit mismatch: the binding is the consent, so any mismatch consumes it.
  const p1 = (await x.plan(x.planBody()))!.data as any;
  const audited = await x.run(
    x.runBody(p1.planId, { audit: true, auditConsent: true }),
  );
  assert.equal(audited?.status, 409);
  assert.equal((audited!.data as any).error, "analysis plan required");
  assert.equal(x.consent.peek(p1.planId), undefined);
  // scope mismatch on a structurally valid alternate scope.
  const p2 = (await x.plan(x.planBody()))!.data as any;
  const scoped = await x.run(
    x.runBody(p2.planId, {
      scope: {
        kind: "code",
        commitSha: x.s.headSha,
        fileId: x.s.phases.at(-1)!.files[0].id,
        side: "new",
        lineStart: 1,
        lineEnd: 1,
        question: "이 범위는 무엇을 하나요?",
      },
    }),
  );
  assert.equal(scoped?.status, 409);
  assert.equal(x.consent.peek(p2.planId), undefined);
  // Missing consent still fails before any plan handling.
  await assert.rejects(
    x.run({ ...x.runBody("0".repeat(32)), consent: false }),
    /consent/,
  );
  // A busy rejection must not consume the one-shot plan.
  const p3 = (await x.plan(x.planBody()))!.data as any;
  x.api.jobs.set("other", {
    job: { kind: "analysis", status: "running" } as any,
    controller: new AbortController(),
  });
  await assert.rejects(x.run(x.runBody(p3.planId)), /busy/);
  assert.ok(x.consent.peek(p3.planId));
  x.api.jobs.delete("other");
  assert.equal(x.calls.length, 0);
});

test("HTTP run consumes its plan once, skips CLI config resolution, and persists a re-readable result", async (t) => {
  const seen: { providerId: string; opts: any }[] = [];
  const execute: NonNullable<LiveAPIOptions["execute"]> = (
    snap,
    providerId,
    model,
    scope,
    signal,
    onEvent,
    opts,
  ) => {
    seen.push({ providerId, opts });
    return executeAnalysis(
      snap,
      providerId,
      model,
      scope,
      signal,
      onEvent,
      opts,
    );
  };
  const x = await fixture(t, { execute });
  const view = await x.configure();
  const plan = (await x.plan(x.planBody()))!.data as any;
  const started = await x.run(x.runBody(plan.planId));
  assert.equal(started?.status, 202, JSON.stringify(started?.data));
  const job = await finish(x.api, (started!.data as any).id);
  assert.equal(job.status, "succeeded", job.error);
  // The pipeline received the HTTP binding, not a CLI config.
  assert.equal(seen.length, 1);
  assert.equal(seen[0].providerId, "openai-compatible");
  assert.equal(seen[0].opts.config, undefined);
  assert.equal(seen[0].opts.http.runtime.host, "api.example.com");
  assert.equal(seen[0].opts.http.runtime.configId, view.configId);
  assert.equal(seen[0].opts.http.runtime.revision, view.revision);
  assert.equal(seen[0].opts.http.budget.limit, plan.maxProviderCalls);
  assert.equal(x.stats.resolveConfig, 0);
  assert.ok(x.calls.length >= 3);
  for (const c of x.calls) {
    assert.equal(c.providerId, "openai-compatible");
    assert.equal(c.model, MODEL);
    assert.equal(c.budget, seen[0].opts.http.budget);
    assert.deepEqual(c.engine, plan.engine);
  }
  // Credentials and the raw runtime never reach the job record or result.
  const serialized = JSON.stringify(job);
  for (const leak of [API_KEY, "apiKey", "getApiKey", "baseUrl", "/v1"])
    assert.equal(serialized.includes(leak), false, leak);
  // planId is single-use.
  const reuse = await x.run(x.runBody(plan.planId));
  assert.equal(reuse?.status, 409);
  assert.equal(x.consent.peek(plan.planId), undefined);
  // The stored result revalidates and stays readable without the key.
  const saved = await x.api.handle(
    "GET",
    url("/api/live/analysis?key=" + (job.result as any).cacheKey),
    undefined,
  );
  assert.equal(saved?.status, 200, JSON.stringify(saved?.data));
  assert.deepEqual(
    (saved!.data as any).result.output,
    (job.result as any).output,
  );
  // A fresh plan reaches the validated cache without new provider calls.
  const again = (await x.plan(x.planBody()))!.data as any;
  const count = x.calls.length;
  const cached = await x.run(x.runBody(again.planId));
  assert.equal((cached!.data as any).cached, true);
  assert.equal(x.calls.length, count);
});

test("reconfiguring the engine invalidates previously issued plans", async (t) => {
  const x = await fixture(t);
  const view = await x.configure();
  const plan = (await x.plan(x.planBody()))!.data as any;
  assert.ok(x.consent.peek(plan.planId));
  const next = x.httpSetup.configure({
    providerId: "openai-compatible",
    baseUrl: BASE_URL,
    model: MODEL,
    configId: view.configId,
    expectedRevision: view.revision,
  });
  assert.equal(next.revision, view.revision + 1);
  assert.equal(x.consent.peek(plan.planId), undefined);
  // Even after re-verification the stale planId is unusable.
  await x.httpSetup.verify({
    configId: next.configId,
    revision: next.revision,
    consent: true,
  });
  const res = await x.run(x.runBody(plan.planId));
  assert.equal(res?.status, 409);
  assert.deepEqual(res!.data, {
    error: "analysis plan required",
    code: "invalid_request",
  });
  assert.equal(x.calls.length, 0);
});

test("a stored HTTP result whose stage engine identity was altered fails revalidation", async (t) => {
  const x = await fixture(t);
  await x.configure();
  const plan = (await x.plan(x.planBody()))!.data as any;
  const started = await x.run(x.runBody(plan.planId));
  const job = await finish(x.api, (started!.data as any).id);
  assert.equal(job.status, "succeeded", job.error);
  const key = (job.result as any).cacheKey;
  const forged = x.api.store.get<any>("analysis", key)!;
  forged.metadata.stages[0].metadata.configId = "cfg-forged";
  x.api.store.put("analysis", key, forged);
  await assert.rejects(
    x.api.handle("GET", url("/api/live/analysis?key=" + key), undefined),
    /identity|mismatch/,
  );
});

test("CLI runs ignore planId and keep the existing config path and cache identity", async (t) => {
  const x = await fixture(t, { runner: (s, calls) => richRunner(s, calls) });
  await x.configure();
  const started = await x.run({
    snapshotId: x.s.snapshotId,
    providerId: "codex",
    model: "FAKE-cli-model",
    scope: { kind: "pr" },
    consent: true,
    planId: "0".repeat(32),
  });
  assert.equal(started?.status, 202, JSON.stringify(started?.data));
  const job = await finish(x.api, (started!.data as any).id);
  assert.equal(job.status, "succeeded", job.error);
  assert.ok(x.stats.resolveConfig > 0);
  for (const c of x.calls) {
    assert.equal(c.providerId, "codex");
    assert.ok(!("engine" in c));
    assert.ok(!("budget" in c));
  }
  const saved = await x.api.handle(
    "GET",
    url("/api/live/analysis?key=" + (job.result as any).cacheKey),
    undefined,
  );
  assert.equal(saved?.status, 200, JSON.stringify(saved?.data));
});
