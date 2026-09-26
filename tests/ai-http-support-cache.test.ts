import test from "node:test";
import assert from "node:assert/strict";
import {
  chatCompletion,
  startMockOpenAI,
  type MockOpenAIServer,
  type MockReplyObject,
} from "./mock-openai-server.ts";
import {
  httpSupportCacheSize,
  resetHttpSupportCache,
  runHttpAnalysis,
  type HttpAnalysisRequest,
} from "../src/server/ai/http.ts";
import { createCallBudget } from "../src/server/ai/call-budget.ts";
import type { HttpRuntimeConfig } from "../src/server/ai/types.ts";

const API_KEY = "sk-canary-http-support-cache-51c2a9b7";
const MODEL = "mock-model";
const CACHE_LIMIT = 32;

const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    findings: { type: "array", items: { type: "string" }, minItems: 1 },
    note: { type: "string" },
  },
  required: ["summary", "findings"],
  additionalProperties: false,
};

const VALID_OUTPUT = { summary: "ok", findings: ["a"], note: null };

const successJson = (content: unknown): MockReplyObject => ({
  status: 200,
  json: chatCompletion(JSON.stringify(content)),
});

// json_schema unsupported, json_object supported: a cold (configId,
// revision, model, schema) combination needs two sends to negotiate, a
// cached combination only one.
const PARTIAL_SUPPORT = {
  jsonSchema: false,
  jsonObject: true,
  maxCompletionTokens: true,
};

function runtimeFor(
  server: MockOpenAIServer,
  extra: Partial<HttpRuntimeConfig> = {},
): HttpRuntimeConfig {
  return {
    providerId: "openai-compatible",
    configId: "cfg-support-cache-test",
    revision: 1,
    baseUrl: server.baseUrl,
    host: new URL(server.baseUrl).host,
    model: MODEL,
    maxOutputTokens: 512,
    getApiKey: () => API_KEY,
    ...extra,
  };
}

function requestFor(
  extra: Partial<HttpAnalysisRequest> = {},
): HttpAnalysisRequest {
  return {
    providerId: "openai-compatible",
    model: MODEL,
    schema: SCHEMA,
    context: { diff: "sample diff" },
    trustedPrompt: "You are a careful code analyzer.",
    ...extra,
  };
}

function budget() {
  return createCallBudget({
    maxCalls: 16,
    maxOutputTokensPerCall: 8192,
    totalOutputTokenLimit: 52 * 32768,
  });
}

async function withServer(
  opts: Parameters<typeof startMockOpenAI>[0],
  fn: (server: MockOpenAIServer) => Promise<void>,
) {
  resetHttpSupportCache();
  const server = await startMockOpenAI(opts);
  try {
    await fn(server);
  } finally {
    await server.close();
    resetHttpSupportCache();
  }
}

test("a cached combination is reused: the next call starts at the negotiated mode", async () => {
  await withServer(
    {
      apiKey: API_KEY,
      supports: PARTIAL_SUPPORT,
      fallback: successJson(VALID_OUTPUT),
    },
    async (server) => {
      const runtime = runtimeFor(server);
      await runHttpAnalysis(requestFor(), runtime, budget());
      assert.equal(server.callCount(), 2);
      assert.equal(httpSupportCacheSize(), 1);

      server.reset();
      await runHttpAnalysis(requestFor(), runtime, budget());
      assert.equal(server.callCount(), 1);
      assert.equal(server.calls()[0].responseFormatType, "json_object");
    },
  );
});

test("the support cache evicts the oldest entries past the bound", async () => {
  await withServer(
    {
      apiKey: API_KEY,
      supports: PARTIAL_SUPPORT,
      fallback: successJson(VALID_OUTPUT),
    },
    async (server) => {
      for (let i = 0; i < CACHE_LIMIT + 1; i += 1) {
        await runHttpAnalysis(
          requestFor(),
          runtimeFor(server, { configId: `cfg-cache-${i}` }),
          budget(),
        );
      }
      assert.equal(httpSupportCacheSize(), CACHE_LIMIT);

      // The first config was evicted: it renegotiates both formats.
      server.reset();
      await runHttpAnalysis(
        requestFor(),
        runtimeFor(server, { configId: "cfg-cache-0" }),
        budget(),
      );
      assert.equal(server.callCount(), 2);
      assert.equal(httpSupportCacheSize(), CACHE_LIMIT);

      // The most recent config is still cached: a single send suffices.
      server.reset();
      await runHttpAnalysis(
        requestFor(),
        runtimeFor(server, { configId: `cfg-cache-${CACHE_LIMIT}` }),
        budget(),
      );
      assert.equal(server.callCount(), 1);
      assert.equal(server.calls()[0].responseFormatType, "json_object");
    },
  );
});

test("storing a new revision drops entries of the same config under other revisions", async () => {
  await withServer(
    {
      apiKey: API_KEY,
      supports: PARTIAL_SUPPORT,
      fallback: successJson(VALID_OUTPUT),
    },
    async (server) => {
      const configId = "cfg-revision-bump";
      const otherId = "cfg-revision-bump-other";

      await runHttpAnalysis(
        requestFor(),
        runtimeFor(server, { configId, revision: 1 }),
        budget(),
      );
      await runHttpAnalysis(
        requestFor(),
        runtimeFor(server, { configId: otherId, revision: 1 }),
        budget(),
      );
      assert.equal(httpSupportCacheSize(), 2);

      // The revision bump supersedes the same config's old entry only.
      await runHttpAnalysis(
        requestFor(),
        runtimeFor(server, { configId, revision: 2 }),
        budget(),
      );
      assert.equal(httpSupportCacheSize(), 2);

      server.reset();
      // The new revision stayed cached: single send.
      await runHttpAnalysis(
        requestFor(),
        runtimeFor(server, { configId, revision: 2 }),
        budget(),
      );
      assert.equal(server.callCount(), 1);

      // The old revision was dropped: it renegotiates both formats, and
      // storing it supersedes the revision-2 entry in turn.
      await runHttpAnalysis(
        requestFor(),
        runtimeFor(server, { configId, revision: 1 }),
        budget(),
      );
      assert.equal(server.callCount(), 3);
      assert.equal(httpSupportCacheSize(), 2);

      // The unrelated config is untouched by either store.
      await runHttpAnalysis(
        requestFor(),
        runtimeFor(server, { configId: otherId, revision: 1 }),
        budget(),
      );
      assert.equal(server.callCount(), 4);
    },
  );
});
