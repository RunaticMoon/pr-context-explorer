import test from "node:test";
import assert from "node:assert/strict";
import { executeAnalysis } from "../src/server/live-analysis.ts";
import {
  createPlanBudget,
  transmissionPlan,
} from "../src/server/live-pipeline.ts";
import { resetHttpSupportCache } from "../src/server/ai/http.ts";
import type { HttpRuntimeConfig } from "../src/server/ai/types.ts";
import type { LiveSnapshot } from "../src/server/analysis-v3/index.ts";
import { chatCompletion, startMockOpenAI } from "./mock-openai-server.ts";
import { richRunner, richSnapshot } from "./integration-v3-fixture.ts";

// Deterministic fixtures and a loopback mock only — no real provider traffic.
const API_KEY = "sk-live-analysis-http-canary-9c41e0b7";
const MODEL = "fixture-http-model";

const signal = () => new AbortController().signal;
const noEvents = () => {};

function httpRuntime(
  overrides: Partial<HttpRuntimeConfig> = {},
): HttpRuntimeConfig {
  return {
    providerId: "openai-compatible",
    configId: "cfg-live-analysis-test",
    revision: 4,
    baseUrl: "http://127.0.0.1:9/unreachable",
    host: "127.0.0.1:9",
    model: MODEL,
    maxOutputTokens: 512,
    getApiKey: () => API_KEY,
    ...overrides,
  };
}

/** Mirrors how trusted server code binds a plan budget to the engine. */
function httpOptions(s: LiveSnapshot, runtime: HttpRuntimeConfig) {
  const plan = transmissionPlan(s, { kind: "pr" }, false, {
    transport: "http",
    providerId: "openai-compatible",
    model: runtime.model,
    host: runtime.host,
    configId: runtime.configId,
    revision: runtime.revision,
  });
  return { runtime, budget: createPlanBudget(plan) };
}

const publicEngine = (runtime: HttpRuntimeConfig) => ({
  transport: "http",
  providerId: "openai-compatible",
  model: runtime.model,
  host: runtime.host,
  configId: runtime.configId,
  revision: runtime.revision,
});

test("executeAnalysis rejects malformed provider/http combinations before any pipeline work", async (t) => {
  const s = await richSnapshot(t);
  const runtime = httpRuntime();
  const http = httpOptions(s, runtime);
  const run = (providerId: any, model: string, options: any = {}) =>
    executeAnalysis(
      s,
      providerId,
      model,
      { kind: "pr" },
      signal(),
      noEvents,
      options,
    );
  for (const attempt of [
    // HTTP provider without the server-injected binding.
    () => run("openai-compatible", MODEL),
    // Request model must match the stored configuration exactly.
    () => run("openai-compatible", "other-model", { http }),
    () =>
      run("openai-compatible", MODEL, {
        http: httpOptions(s, httpRuntime({ model: "other-model" })),
      }),
    // Local providers must not receive an HTTP binding.
    () => run("codex", "codex-model", { http }),
    () => run("claude", "claude-model", { http }),
    // Unknown providers are still rejected.
    () => run("bogus", MODEL),
  ])
    await assert.rejects(attempt(), /explicit provider\/model required/);
});

test("openai-compatible forwards the call budget and public engine identity to every stage", async (t) => {
  const s = await richSnapshot(t);
  const runtime = httpRuntime();
  const http = httpOptions(s, runtime);
  const calls: any[] = [];
  const events: unknown[] = [];
  const result = await executeAnalysis(
    s,
    "openai-compatible",
    MODEL,
    { kind: "pr" },
    signal(),
    (e) => events.push(e),
    { runner: richRunner(s, calls), http },
  );
  assert.equal(result.processStatus, "succeeded");
  assert.equal(result.metadata.providerId, "openai-compatible");
  assert.ok(calls.length >= 3, "chunk + synthesis + tour runner calls");
  for (const r of calls) {
    assert.equal(r.providerId, "openai-compatible");
    assert.equal(r.budget, http.budget);
    assert.deepEqual(r.engine, publicEngine(runtime));
  }
  // The runtime object and its credential closure never reach the result,
  // events, or stage metadata.
  const serialized = JSON.stringify({ result, events });
  for (const leak of [API_KEY, "getApiKey", "baseUrl", runtime.baseUrl])
    assert.ok(!serialized.includes(leak), leak);
});

test("openai-compatible without an injected runner runs the real HTTP adapter, never the CLI module", async (t) => {
  const s = await richSnapshot(t);
  const fixture = richRunner(s, []);
  resetHttpSupportCache();
  const server = await startMockOpenAI({
    apiKey: API_KEY,
    // Rebuild deterministic stage outputs from the serialized StageContext in
    // the POST body so the real runHttpAnalysis request/response path is used.
    fallback: async (req) => {
      const body = req.body as {
        messages: { role: string; content: string }[];
      };
      const context = JSON.parse(body.messages[1].content);
      const { output } = await fixture({
        stage: context.task.kind,
        taskId: context.task.taskId,
        providerId: "openai-compatible",
        model: MODEL,
        context,
      } as any);
      return { status: 200, json: chatCompletion(JSON.stringify(output)) };
    },
  });
  t.after(() => server.close());
  const runtime = httpRuntime({
    baseUrl: server.baseUrl,
    host: new URL(server.baseUrl).host,
  });
  const http = httpOptions(s, runtime);
  const events: unknown[] = [];
  const result = await executeAnalysis(
    s,
    "openai-compatible",
    MODEL,
    { kind: "pr" },
    signal(),
    (e) => events.push(e),
    { http },
  );
  assert.equal(result.processStatus, "succeeded");
  assert.equal(result.metadata.providerId, "openai-compatible");
  // Every stage result was produced by the OpenAI-compatible HTTP transport.
  for (const stage of result.metadata.stages)
    assert.equal((stage.metadata as any)?.transport, "http");
  assert.ok(server.callCount() >= 3);
  for (const call of server.calls()) {
    assert.equal(call.path, "/v1/chat/completions");
    assert.equal(call.authorizationMatches, true);
    assert.equal(call.hasTools, false);
  }
  const serialized = JSON.stringify({ result, events });
  for (const leak of [API_KEY, "getApiKey", "baseUrl", runtime.baseUrl])
    assert.ok(!serialized.includes(leak), leak);
});

test("local providers keep the CLI runner path with no budget/engine keys", async (t) => {
  const s = await richSnapshot(t);
  const calls: any[] = [];
  const result = await executeAnalysis(
    s,
    "codex",
    "fixture-cli-model",
    { kind: "pr" },
    signal(),
    noEvents,
    { runner: richRunner(s, calls) },
  );
  assert.equal(result.processStatus, "succeeded");
  assert.ok(calls.length >= 3);
  for (const r of calls) {
    assert.equal(r.providerId, "codex");
    assert.ok(!("budget" in r), "CLI runner request must not carry budget");
    assert.ok(!("engine" in r), "CLI runner request must not carry engine");
  }
});
