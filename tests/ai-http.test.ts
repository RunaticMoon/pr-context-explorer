import test from "node:test";
import assert from "node:assert/strict";
import {
  chatCompletion,
  startMockOpenAI,
  type MockOpenAIServer,
  type MockReplyObject,
} from "./mock-openai-server.ts";
import {
  resetHttpSupportCache,
  runHttpAnalysis,
  type HttpAnalysisRequest,
} from "../src/server/ai/http.ts";
import { createCallBudget } from "../src/server/ai/call-budget.ts";
import { AIError } from "../src/server/ai/errors.ts";
import type { HttpRuntimeConfig } from "../src/server/ai/types.ts";

const API_KEY = "sk-canary-http-adapter-7f31c9d2";
const MODEL = "mock-model";

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

const successJson = (content: unknown): MockReplyObject => ({
  status: 200,
  json: chatCompletion(JSON.stringify(content)),
});

const VALID_OUTPUT = { summary: "ok", findings: ["a"], note: null };
const VALID_STRIPPED = { summary: "ok", findings: ["a"] };

const rateLimited: MockReplyObject = {
  status: 429,
  headers: { "retry-after": "0" },
  json: {
    error: {
      message: "rate limited",
      type: "tokens",
      code: "rate_limit_exceeded",
      param: null,
    },
  },
};

function runtimeFor(
  server: MockOpenAIServer,
  extra: Partial<HttpRuntimeConfig> = {},
): HttpRuntimeConfig {
  return {
    providerId: "openai-compatible",
    configId: "cfg-http-adapter-test",
    revision: 3,
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

function budget(maxCalls = 16) {
  return createCallBudget({
    maxCalls,
    maxOutputTokensPerCall: 8192,
    totalOutputTokenLimit: 52 * 32768,
  });
}

async function expectAIError(code: string, promise: Promise<unknown>) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof AIError, `expected AIError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
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
  }
}

test("json_schema success sends strict response_format, no tools, one token field", async () => {
  await withServer(
    { apiKey: API_KEY, fallback: successJson(VALID_OUTPUT) },
    async (server) => {
      const result = await runHttpAnalysis(
        requestFor(),
        runtimeFor(server),
        budget(),
      );
      assert.equal(server.callCount(), 1);
      const call = server.calls()[0];
      assert.equal(call.path, "/v1/chat/completions");
      assert.equal(call.method, "POST");
      assert.equal(call.authorizationMatches, true);
      assert.equal(call.hasTools, false);
      assert.equal(call.responseFormatType, "json_schema");
      assert.equal(call.tokenLimitField, "max_completion_tokens");
      const body = call.body as Record<string, unknown>;
      assert.equal(body.stream, false);
      assert.ok(
        "max_completion_tokens" in body && !("max_tokens" in body),
        "exactly one token limit field",
      );
      const rf = body.response_format as {
        type: string;
        json_schema: { strict: boolean; schema: unknown };
      };
      assert.equal(rf.json_schema.strict, true);
      // Provider-emitted null for the optional `note` is restored to absent
      // before canonical validation.
      assert.deepEqual(result.output, VALID_STRIPPED);
      const meta = result.metadata;
      if (meta.transport !== "http") assert.fail("expected http metadata");
      assert.equal(meta.providerId, "openai-compatible");
      assert.equal(meta.model, MODEL);
      assert.equal(meta.host, runtimeFor(server).host);
      assert.equal(meta.configId, "cfg-http-adapter-test");
      assert.equal(meta.revision, 3);
      assert.equal(meta.isolation, "not-applicable");
      assert.equal(meta.responseMode, "json_schema");
      assert.equal(meta.formatFallbackUsed, false);
      assert.equal(meta.attempts, 1);
      assert.equal(meta.schemaValidated, true);
      assert.equal(meta.referenceValidation, "caller-required");
      assert.equal(meta.fallbackUsed, false);
      assert.equal(meta.parserVersion, "1");
      for (const value of Object.values(meta.usage))
        assert.equal(typeof value, "number");
    },
  );
});

test("unsupported json_schema falls back to json_object", async () => {
  await withServer(
    {
      apiKey: API_KEY,
      supports: {
        jsonSchema: false,
        jsonObject: true,
        maxCompletionTokens: true,
      },
      fallback: successJson(VALID_OUTPUT),
    },
    async (server) => {
      const result = await runHttpAnalysis(
        requestFor(),
        runtimeFor(server),
        budget(),
      );
      assert.equal(server.callCount(), 2);
      assert.equal(server.calls()[0].responseFormatType, "json_schema");
      assert.equal(server.calls()[1].responseFormatType, "json_object");
      const meta = result.metadata;
      if (meta.transport !== "http") assert.fail("expected http metadata");
      assert.equal(meta.responseMode, "json_object");
      assert.equal(meta.formatFallbackUsed, true);
      assert.equal(meta.attempts, 2);
      assert.deepEqual(result.output, VALID_STRIPPED);
    },
  );
});

test("unsupported json_object continues the chain to prompt_json", async () => {
  await withServer(
    {
      apiKey: API_KEY,
      supports: {
        jsonSchema: false,
        jsonObject: false,
        maxCompletionTokens: true,
      },
      fallback: successJson(VALID_OUTPUT),
    },
    async (server) => {
      const result = await runHttpAnalysis(
        requestFor(),
        runtimeFor(server),
        budget(),
      );
      assert.equal(server.callCount(), 3);
      const last = server.calls()[2];
      assert.equal(last.responseFormatType, undefined);
      const body = last.body as Record<string, unknown>;
      assert.ok(!("response_format" in body));
      const meta = result.metadata;
      if (meta.transport !== "http") assert.fail("expected http metadata");
      assert.equal(meta.responseMode, "prompt_json");
      assert.equal(meta.formatFallbackUsed, true);
      assert.equal(meta.attempts, 3);
    },
  );
});

test("unsupported max_completion_tokens falls back to max_tokens", async () => {
  await withServer(
    {
      apiKey: API_KEY,
      supports: {
        jsonSchema: true,
        jsonObject: true,
        maxCompletionTokens: false,
      },
      fallback: successJson(VALID_OUTPUT),
    },
    async (server) => {
      const result = await runHttpAnalysis(
        requestFor(),
        runtimeFor(server),
        budget(),
      );
      assert.equal(server.callCount(), 2);
      assert.equal(server.calls()[0].tokenLimitField, "max_completion_tokens");
      assert.equal(server.calls()[1].tokenLimitField, "max_tokens");
      const body = server.calls()[1].body as Record<string, unknown>;
      assert.ok(!("max_completion_tokens" in body));
      assert.equal(body.max_tokens, 512);
      const meta = result.metadata;
      if (meta.transport !== "http") assert.fail("expected http metadata");
      assert.equal(meta.formatFallbackUsed, true);
      assert.equal(meta.attempts, 2);
    },
  );
});

test("generic 429 is retried and then succeeds", async () => {
  await withServer(
    {
      apiKey: API_KEY,
      replies: [rateLimited, rateLimited, successJson(VALID_OUTPUT)],
    },
    async (server) => {
      const result = await runHttpAnalysis(
        requestFor(),
        runtimeFor(server),
        budget(),
      );
      assert.equal(server.callCount(), 3);
      const meta = result.metadata;
      if (meta.transport !== "http") assert.fail("expected http metadata");
      assert.equal(meta.attempts, 3);
      assert.equal(meta.formatFallbackUsed, false);
      assert.deepEqual(result.output, VALID_STRIPPED);
    },
  );
});

test("persistent 429 fails rate_limited within the attempt cap", async () => {
  await withServer(
    { apiKey: API_KEY, fallback: rateLimited },
    async (server) => {
      await expectAIError(
        "rate_limited",
        runHttpAnalysis(requestFor(), runtimeFor(server), budget()),
      );
      assert.ok(server.callCount() <= 4, `calls: ${server.callCount()}`);
      assert.equal(server.callCount(), 3);
    },
  );
});

test("401 fails auth_invalid without retrying", async () => {
  await withServer(
    {
      apiKey: API_KEY,
      fallback: {
        status: 401,
        json: {
          error: {
            message: "bad key",
            type: "invalid_request_error",
            code: "invalid_api_key",
            param: null,
          },
        },
      },
    },
    async (server) => {
      await expectAIError(
        "auth_invalid",
        runHttpAnalysis(requestFor(), runtimeFor(server), budget()),
      );
      assert.equal(server.callCount(), 1);
    },
  );
});

test("insufficient_quota fails quota_exceeded without retrying", async () => {
  await withServer(
    {
      apiKey: API_KEY,
      fallback: {
        status: 429,
        headers: { "retry-after": "0" },
        json: {
          error: {
            message: "quota exhausted",
            type: "insufficient_quota",
            code: "insufficient_quota",
            param: null,
          },
        },
      },
    },
    async (server) => {
      await expectAIError(
        "quota_exceeded",
        runHttpAnalysis(requestFor(), runtimeFor(server), budget()),
      );
      assert.equal(server.callCount(), 1);
    },
  );
});

test("5xx is retried and then succeeds", async () => {
  await withServer(
    {
      apiKey: API_KEY,
      replies: [
        {
          status: 503,
          headers: { "retry-after": "0" },
          json: {
            error: {
              message: "unavailable",
              type: "server_error",
              code: null,
              param: null,
            },
          },
        },
        successJson(VALID_OUTPUT),
      ],
    },
    async (server) => {
      const result = await runHttpAnalysis(
        requestFor(),
        runtimeFor(server),
        budget(),
      );
      assert.equal(server.callCount(), 2);
      assert.deepEqual(result.output, VALID_STRIPPED);
    },
  );
});

test("schema-violating output fails schema_mismatch with value-free diagnostics", async () => {
  const bad = { summary: "ok", findings: "MARKER-NOT-AN-ARRAY" };
  await withServer(
    { apiKey: API_KEY, fallback: successJson(bad) },
    async (server) => {
      await assert.rejects(
        runHttpAnalysis(requestFor(), runtimeFor(server), budget()),
        (err) => {
          assert.ok(err instanceof AIError);
          assert.equal(err.code, "schema_mismatch");
          assert.equal(err.detail?.reasonCode, "output_schema_mismatch");
          assert.ok(
            Array.isArray(err.detail?.schemaErrors) &&
              err.detail.schemaErrors.length > 0,
          );
          const serialized = JSON.stringify(err.detail);
          assert.ok(!serialized.includes("MARKER-NOT-AN-ARRAY"));
          return true;
        },
      );
      // No retry and no format fallback on canonical validation failure.
      assert.equal(server.callCount(), 1);
    },
  );
});

test("content echoing the API key is discarded as provider_failed", async () => {
  const echo = { summary: `leak ${API_KEY}`, findings: ["a"] };
  await withServer(
    { apiKey: API_KEY, fallback: successJson(echo) },
    async (server) => {
      await expectAIError(
        "provider_failed",
        runHttpAnalysis(requestFor(), runtimeFor(server), budget()),
      );
      assert.equal(server.callCount(), 1);
    },
  );
});

test("an exhausted call budget refuses the retry before transmission", async () => {
  await withServer(
    { apiKey: API_KEY, replies: [rateLimited, successJson(VALID_OUTPUT)] },
    async (server) => {
      await expectAIError(
        "input_limit",
        runHttpAnalysis(requestFor(), runtimeFor(server), budget(1)),
      );
      // The second send was denied before any request reached the provider.
      assert.equal(server.callCount(), 1);
    },
  );
});

test("abort during retry backoff fails cancelled", async () => {
  await withServer(
    {
      apiKey: API_KEY,
      fallback: { ...rateLimited, headers: { "retry-after": "10" } },
    },
    async (server) => {
      const controller = new AbortController();
      const promise = runHttpAnalysis(
        requestFor({ signal: controller.signal }),
        runtimeFor(server),
        budget(),
      );
      setTimeout(() => controller.abort(), 50);
      await expectAIError("cancelled", promise);
      assert.equal(server.callCount(), 1);
    },
  );
});

test("the support cache starts the next call at the negotiated mode", async () => {
  await withServer(
    {
      apiKey: API_KEY,
      supports: {
        jsonSchema: false,
        jsonObject: true,
        maxCompletionTokens: true,
      },
      fallback: successJson(VALID_OUTPUT),
    },
    async (server) => {
      const runtime = runtimeFor(server);
      const first = await runHttpAnalysis(requestFor(), runtime, budget());
      if (first.metadata.transport !== "http")
        assert.fail("expected http metadata");
      assert.equal(first.metadata.responseMode, "json_object");
      assert.equal(first.metadata.attempts, 2);

      server.reset();
      const second = await runHttpAnalysis(requestFor(), runtime, budget());
      assert.equal(server.callCount(), 1);
      // The first send already uses the cached json_object combination.
      assert.equal(server.calls()[0].responseFormatType, "json_object");
      if (second.metadata.transport !== "http")
        assert.fail("expected http metadata");
      assert.equal(second.metadata.responseMode, "json_object");
      assert.equal(second.metadata.attempts, 1);
      assert.equal(second.metadata.formatFallbackUsed, false);
    },
  );
});

test("a model mismatch fails invalid_request without sending", async () => {
  await withServer(
    { apiKey: API_KEY, fallback: successJson(VALID_OUTPUT) },
    async (server) => {
      await expectAIError(
        "invalid_request",
        runHttpAnalysis(
          requestFor({ model: "other-model" }),
          runtimeFor(server),
          budget(),
        ),
      );
      assert.equal(server.callCount(), 0);
    },
  );
});

test("results and errors never contain the API key or the base URL path", async () => {
  await withServer(
    { apiKey: API_KEY, fallback: successJson(VALID_OUTPUT) },
    async (server) => {
      const result = await runHttpAnalysis(
        requestFor(),
        runtimeFor(server),
        budget(),
      );
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes(API_KEY));
      assert.ok(!serialized.includes(server.baseUrl));
      assert.ok(!serialized.includes("/v1"));
    },
  );

  await withServer(
    {
      apiKey: API_KEY,
      fallback: {
        status: 400,
        json: {
          error: {
            message: "nope",
            type: "invalid_request_error",
            code: "weird_failure",
            param: null,
          },
        },
      },
    },
    async (server) => {
      await assert.rejects(
        runHttpAnalysis(requestFor(), runtimeFor(server), budget()),
        (err) => {
          assert.ok(err instanceof AIError);
          const serialized = JSON.stringify({
            message: err.message,
            stack: err.stack,
            detail: err.detail ?? null,
          });
          assert.ok(!serialized.includes(API_KEY));
          assert.ok(!serialized.includes(server.baseUrl));
          return true;
        },
      );
    },
  );
});
