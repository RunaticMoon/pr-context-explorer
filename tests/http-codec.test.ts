import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChatBody,
  classifyHttpFailure,
  parseSuccess,
  systemPromptWithSchema,
} from "../src/server/ai/http-codec.ts";
import { AIError, type AIErrorCode } from "../src/server/ai/errors.ts";
import { HTTP_LIMITS } from "../src/ai-contract.ts";
import { chatCompletion } from "./mock-openai-server.ts";

const API_KEY = "sk-canary-codec-key-9f8e7d6c";

const baseInput = {
  model: "mock-model",
  system: "trusted system prompt",
  user: "serialized untrusted context",
  responseMode: "prompt_json" as const,
  tokenLimitField: "max_completion_tokens" as const,
  maxOutputTokens: 1024,
};

const providerSchema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

function expectAIError(code: AIErrorCode, fn: () => unknown) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof AIError, `expected AIError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

function errorBody(fields: {
  message?: string;
  type?: string;
  param?: string | null;
  code?: string | null;
}) {
  return JSON.stringify({ error: fields });
}

// ---------- buildChatBody ----------

test("json_schema mode emits strict response_format with the provider schema", () => {
  const body = JSON.parse(
    buildChatBody({
      ...baseInput,
      responseMode: "json_schema",
      providerSchema,
      schemaName: "grounded_output",
    }),
  );
  assert.equal(body.model, "mock-model");
  assert.equal(body.stream, false);
  assert.equal(body.max_completion_tokens, 1024);
  assert.deepEqual(body.response_format, {
    type: "json_schema",
    json_schema: {
      name: "grounded_output",
      strict: true,
      schema: providerSchema,
    },
  });
  assert.deepEqual(
    body.messages.map((m: { role: string }) => m.role),
    ["system", "user"],
  );
  assert.equal(body.messages[0].content, baseInput.system);
  assert.equal(body.messages[1].content, baseInput.user);
});

test("json_schema mode defaults the schema name when omitted", () => {
  const body = JSON.parse(
    buildChatBody({
      ...baseInput,
      responseMode: "json_schema",
      providerSchema,
    }),
  );
  assert.equal(body.response_format.json_schema.name, "analysis_result");
  assert.equal(body.response_format.json_schema.strict, true);
});

test("json_object mode emits a bare json_object response_format", () => {
  const body = JSON.parse(
    buildChatBody({
      ...baseInput,
      responseMode: "json_object",
      providerSchema,
    }),
  );
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.response_format.json_schema, undefined);
});

test("prompt_json mode omits response_format entirely", () => {
  const body = JSON.parse(
    buildChatBody({ ...baseInput, responseMode: "prompt_json" }),
  );
  assert.ok(!("response_format" in body));
});

test("token limit field follows tokenLimitField exactly once", () => {
  const completion = JSON.parse(
    buildChatBody({ ...baseInput, tokenLimitField: "max_completion_tokens" }),
  );
  assert.equal(completion.max_completion_tokens, 1024);
  assert.ok(!("max_tokens" in completion));

  const legacy = JSON.parse(
    buildChatBody({ ...baseInput, tokenLimitField: "max_tokens" }),
  );
  assert.equal(legacy.max_tokens, 1024);
  assert.ok(!("max_completion_tokens" in legacy));
});

test("tool fields are never emitted in any mode", () => {
  for (const responseMode of ["json_schema", "json_object", "prompt_json"]) {
    const body = JSON.parse(
      buildChatBody({
        ...baseInput,
        responseMode: responseMode as "json_schema",
        providerSchema,
      }),
    );
    for (const key of ["tools", "tool_choice", "functions", "function_call"])
      assert.ok(!(key in body), `${responseMode} must not carry ${key}`);
  }
});

test("provider schema over the byte cap fails with input_limit", () => {
  const big = {
    type: "object",
    description: "x".repeat(HTTP_LIMITS.schemaBytes),
  };
  expectAIError("input_limit", () =>
    buildChatBody({
      ...baseInput,
      responseMode: "json_schema",
      providerSchema: big,
    }),
  );
});

test("json_schema mode without a provider schema fails as invalid_request", () => {
  expectAIError("invalid_request", () =>
    buildChatBody({ ...baseInput, responseMode: "json_schema" }),
  );
});

// ---------- systemPromptWithSchema ----------

test("systemPromptWithSchema appends guidance and the canonical schema text", () => {
  const prompt = systemPromptWithSchema("You are an analyzer.", providerSchema);
  assert.ok(prompt.startsWith("You are an analyzer."));
  assert.ok(prompt.includes(JSON.stringify(providerSchema)));
  assert.ok(prompt.length > "You are an analyzer.".length + 20);
});

// ---------- parseSuccess ----------

test("valid completion parses output and projects usage", () => {
  const body = JSON.stringify(
    chatCompletion('{"answer":"ok"}', {
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }),
  );
  const result = parseSuccess(body, { apiKey: API_KEY });
  assert.deepEqual(result.output, { answer: "ok" });
  assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7 });
  // Provider model/id are not preserved.
  assert.deepEqual(Object.keys(result).sort(), ["output", "usage"]);
  assert.ok(!JSON.stringify(result).includes("mock-model"));
  assert.ok(!JSON.stringify(result).includes("chatcmpl-mock"));
});

test("missing or non-numeric usage fields are not projected", () => {
  const noUsage = parseSuccess(JSON.stringify(chatCompletion("{}")), {
    apiKey: API_KEY,
  });
  // mock returns numeric usage; replace it with junk shapes instead.
  const junk = JSON.stringify(
    chatCompletion("{}", {
      usage: { prompt_tokens: "11", completion_tokens: null, extra: 5 },
    }),
  );
  const result = parseSuccess(junk, { apiKey: API_KEY });
  assert.equal(result.usage, undefined);
  assert.ok(noUsage.usage !== undefined);
});

test("non-JSON body is invalid_envelope", () => {
  expectAIError("invalid_envelope", () =>
    parseSuccess("not json {", { apiKey: API_KEY }),
  );
});

test("choices length other than one is invalid_envelope", () => {
  const zero = JSON.stringify({ choices: [] });
  expectAIError("invalid_envelope", () =>
    parseSuccess(zero, { apiKey: API_KEY }),
  );
  const two = JSON.stringify(
    chatCompletion("{}", {
      choices: [
        { index: 0, message: { role: "assistant", content: "{}" } },
        { index: 1, message: { role: "assistant", content: "{}" } },
      ],
    }),
  );
  expectAIError("invalid_envelope", () =>
    parseSuccess(two, { apiKey: API_KEY }),
  );
});

test("tool_calls and function_call are rejected as tool_use_forbidden", () => {
  const toolCalls = JSON.stringify(
    chatCompletion("{}", {
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "{}",
            tool_calls: [{ id: "call_1", type: "function" }],
          },
          finish_reason: "tool_calls",
        },
      ],
    }),
  );
  expectAIError("tool_use_forbidden", () =>
    parseSuccess(toolCalls, { apiKey: API_KEY }),
  );

  const functionCall = JSON.stringify(
    chatCompletion("{}", {
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "{}",
            function_call: { name: "exfil" },
          },
        },
      ],
    }),
  );
  expectAIError("tool_use_forbidden", () =>
    parseSuccess(functionCall, { apiKey: API_KEY }),
  );
});

test("refusal is classified as provider_failed", () => {
  const body = JSON.stringify(
    chatCompletion("", {
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "", refusal: "cannot help" },
        },
      ],
    }),
  );
  expectAIError("provider_failed", () =>
    parseSuccess(body, { apiKey: API_KEY }),
  );
});

test("non-string content is invalid_envelope", () => {
  for (const content of [null, { answer: "ok" }, ["x"]]) {
    const body = JSON.stringify(
      chatCompletion("", {
        choices: [
          { index: 0, message: { role: "assistant", content, refusal: null } },
        ],
      }),
    );
    expectAIError("invalid_envelope", () =>
      parseSuccess(body, { apiKey: API_KEY }),
    );
  }
});

test("content that is not verbatim JSON fails as invalid_json", () => {
  const fenced = JSON.stringify(
    chatCompletion('```json\n{"answer":"ok"}\n```'),
  );
  expectAIError("invalid_json", () =>
    parseSuccess(fenced, { apiKey: API_KEY }),
  );

  const padded = JSON.stringify(
    chatCompletion('Here is the result: {"answer":"ok"}'),
  );
  expectAIError("invalid_json", () =>
    parseSuccess(padded, { apiKey: API_KEY }),
  );
});

test("content reflecting the API key is discarded as provider_failed", () => {
  const body = JSON.stringify(chatCompletion(`{"leak":"${API_KEY}"}`));
  expectAIError("provider_failed", () =>
    parseSuccess(body, { apiKey: API_KEY }),
  );
});

// ---------- classifyHttpFailure ----------

test("401 and 403 classify as auth_invalid", () => {
  for (const status of [401, 403]) {
    const result = classifyHttpFailure(
      status,
      errorBody({ message: "bad key", type: "invalid_request_error" }),
    );
    assert.deepEqual(result, { code: "auth_invalid", retryable: false });
  }
});

test("429 quota signals classify as quota_exceeded, generic as rate_limited", () => {
  const byCode = classifyHttpFailure(
    429,
    errorBody({ code: "insufficient_quota", type: "insufficient_quota" }),
  );
  assert.deepEqual(byCode, { code: "quota_exceeded", retryable: false });

  const byType = classifyHttpFailure(
    429,
    errorBody({ code: "rate_limit", type: "tokens_quota_hit" }),
  );
  assert.deepEqual(byType, { code: "quota_exceeded", retryable: false });

  const generic = classifyHttpFailure(
    429,
    errorBody({ code: "rate_limit_exceeded", type: "tokens" }),
  );
  assert.deepEqual(generic, { code: "rate_limited", retryable: true });
});

test("404 with a missing-model signal classifies as model_unavailable", () => {
  const byCode = classifyHttpFailure(
    404,
    errorBody({ code: "model_not_found", param: "model" }),
  );
  assert.deepEqual(byCode, { code: "model_unavailable", retryable: false });

  // Ollama-style bodies carry the provider text as a bare `error` string.
  const ollamaStyle = classifyHttpFailure(
    404,
    JSON.stringify({ error: "model 'mistral' not found" }),
  );
  assert.deepEqual(ollamaStyle, {
    code: "model_unavailable",
    retryable: false,
  });

  const byMessage = classifyHttpFailure(
    404,
    errorBody({ message: "Unknown model: llama3" }),
  );
  assert.deepEqual(byMessage, {
    code: "model_unavailable",
    retryable: false,
  });

  // model_not_found keeps its meaning on non-404 statuses too.
  const non404 = classifyHttpFailure(
    400,
    errorBody({ code: "model_not_found", param: "model" }),
  );
  assert.deepEqual(non404, { code: "model_unavailable", retryable: false });
});

test("404 without a missing-model signal classifies as provider_unavailable", () => {
  const marker = "Unknown request URL: POST /chat/completions";
  const wrongRoute = classifyHttpFailure(404, errorBody({ message: marker }));
  assert.deepEqual(wrongRoute, {
    code: "provider_unavailable",
    retryable: false,
  });
  // Provider text never reaches the classification.
  assert.ok(!JSON.stringify(wrongRoute).includes(marker));

  const emptyBody = classifyHttpFailure(404, "");
  assert.deepEqual(emptyBody, {
    code: "provider_unavailable",
    retryable: false,
  });
  assert.equal(emptyBody.retryable, false);
});

test("5xx classifies as retryable provider_unavailable", () => {
  for (const status of [500, 502, 503, 529]) {
    const result = classifyHttpFailure(
      status,
      errorBody({ message: "server exploded", type: "server_error" }),
    );
    assert.deepEqual(result, { code: "provider_unavailable", retryable: true });
  }
  // Unparseable bodies still classify by status.
  const html = classifyHttpFailure(503, "<html>bad gateway</html>");
  assert.deepEqual(html, { code: "provider_unavailable", retryable: true });
});

test("explicit unsupported parameters surface an unsupported marker", () => {
  const responseFormat = classifyHttpFailure(
    400,
    errorBody({
      message:
        "Unsupported parameter: 'response_format' is not supported with this model.",
      param: "response_format",
      code: "unsupported_parameter",
    }),
  );
  assert.deepEqual(responseFormat, {
    code: "provider_failed",
    retryable: false,
    unsupported: "response_format",
  });

  const jsonSchema = classifyHttpFailure(
    400,
    errorBody({
      message: "Unsupported value for response_format.json_schema.",
      param: "response_format.json_schema",
      code: "unsupported_value",
    }),
  );
  assert.deepEqual(jsonSchema, {
    code: "provider_failed",
    retryable: false,
    unsupported: "json_schema",
  });

  const maxTokens = classifyHttpFailure(
    422,
    errorBody({
      message:
        "Unsupported parameter: 'max_completion_tokens' is not supported with this model.",
      param: "max_completion_tokens",
      code: "unsupported_parameter",
    }),
  );
  assert.deepEqual(maxTokens, {
    code: "provider_failed",
    retryable: false,
    unsupported: "max_completion_tokens",
  });
});

test("param-level rejection is detected from the message when the code is absent", () => {
  const result = classifyHttpFailure(
    400,
    errorBody({
      message: "Unknown parameter: response_format",
      param: "response_format",
      code: null,
    }),
  );
  assert.deepEqual(result, {
    code: "provider_failed",
    retryable: false,
    unsupported: "response_format",
  });
});

test("explicit schema rejection classifies as schema_invalid", () => {
  const byCode = classifyHttpFailure(
    400,
    errorBody({
      message: "Invalid schema for response_format 'analysis_result'.",
      param: "response_format",
      code: "invalid_json_schema",
    }),
  );
  assert.deepEqual(byCode, { code: "schema_invalid", retryable: false });

  const byParam = classifyHttpFailure(
    422,
    errorBody({
      message: "schema rejected",
      param: "response_format.json_schema",
      code: "invalid_value",
    }),
  );
  assert.deepEqual(byParam, { code: "schema_invalid", retryable: false });
});

test("413 classifies as input_limit", () => {
  const result = classifyHttpFailure(
    413,
    errorBody({ code: "request_too_large" }),
  );
  assert.deepEqual(result, { code: "input_limit", retryable: false });
});

test("a generic 400 that only mentions response_format in the message stays provider_failed", () => {
  const result = classifyHttpFailure(
    400,
    errorBody({
      message:
        "The request failed validation; see response_format documentation.",
      type: "invalid_request_error",
      code: null,
      param: null,
    }),
  );
  assert.deepEqual(result, { code: "provider_failed", retryable: false });
  assert.equal(result.unsupported, undefined);
});

test("unlisted statuses and shapes fall back to provider_failed without provider text", () => {
  const secretPhrase = "internal-trace-7f3a9b-secret";
  const result = classifyHttpFailure(418, errorBody({ message: secretPhrase }));
  assert.deepEqual(result, { code: "provider_failed", retryable: false });
  assert.ok(!JSON.stringify(result).includes(secretPhrase));

  const badBody = classifyHttpFailure(400, "definitely not json");
  assert.deepEqual(badBody, { code: "provider_failed", retryable: false });

  const emptyError = classifyHttpFailure(400, JSON.stringify({}));
  assert.deepEqual(emptyError, {
    code: "provider_failed",
    retryable: false,
  });
});
