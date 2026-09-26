import test from "node:test";
import assert from "node:assert/strict";
import type {
  AnalysisResult,
  AnyAnalysisMetadata,
  CliAnalysisMetadata,
  HttpAnalysisMetadata,
  HttpAttemptInput,
  HttpAttemptResult,
  HttpRuntimeConfig,
} from "../src/server/ai/types.ts";

const cliMetadata: CliAnalysisMetadata = {
  providerId: "codex",
  model: "m",
  observedModel: null,
  cliVersion: "1",
  startedAt: "",
  finishedAt: "",
  durationMs: 0,
  usage: {},
  isolation: "linux-bwrap",
  schemaValidated: true,
  referenceValidation: "caller-required",
  fallbackUsed: false,
  parserVersion: "1",
  stdoutBytes: 0,
  stderrBytes: 0,
};

const httpMetadata: HttpAnalysisMetadata = {
  transport: "http",
  providerId: "openai-compatible",
  model: "m",
  host: "api.example.test",
  configId: "cfg",
  revision: 1,
  startedAt: "",
  finishedAt: "",
  durationMs: 0,
  usage: {},
  isolation: "not-applicable",
  responseMode: "json_schema",
  formatFallbackUsed: false,
  attempts: 1,
  schemaValidated: true,
  referenceValidation: "caller-required",
  fallbackUsed: false,
  parserVersion: "1",
};

test("AnalysisResult.metadata accepts both transport variants", () => {
  const results: AnalysisResult[] = [
    { output: null, metadata: cliMetadata },
    { output: null, metadata: httpMetadata },
    // Pre-HTTP persisted records carry no transport marker.
    { output: null, metadata: { ...cliMetadata, transport: "cli" } },
  ];
  const metadata: AnyAnalysisMetadata[] = results.map((r) => r.metadata);
  assert.equal(metadata.length, 3);
  assert.equal(httpMetadata.transport, "http");
  assert.equal(cliMetadata.transport, undefined);
});

test("HttpRuntimeConfig keeps the key behind a closure", () => {
  const runtime: HttpRuntimeConfig = {
    providerId: "openai-compatible",
    configId: "cfg",
    revision: 3,
    baseUrl: "https://api.example.test/prefix",
    host: "api.example.test",
    model: "m",
    getApiKey: () => "key",
    maxOutputTokens: 8192,
  };
  assert.equal(runtime.getApiKey(), "key");
  assert.equal(JSON.stringify(runtime).includes("key"), false);
});

test("HttpAttemptInput/HttpAttemptResult shapes", () => {
  const input: HttpAttemptInput = {
    url: "https://api.example.test/prefix/chat/completions",
    model: "m",
    messages: [
      { role: "system", content: "trusted" },
      { role: "user", content: "{}" },
    ],
    responseMode: "json_object",
    tokenLimitField: "max_completion_tokens",
    maxOutputTokens: 8192,
    schema: { type: "object" },
    schemaName: "out",
    deadlineAt: Date.now() + 120_000,
  };
  const result: HttpAttemptResult = {
    status: 429,
    retryAfterMs: 500,
    bodyText: "{}",
    bytes: 2,
  };
  assert.equal(input.messages.length, 2);
  assert.equal(result.retryAfterMs, 500);
});
