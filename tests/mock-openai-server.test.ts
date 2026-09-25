import test from "node:test";
import assert from "node:assert/strict";
import {
  chatCompletion,
  startMockOpenAI,
  unsupportedParamError,
  type MockOpenAIServer,
} from "./mock-openai-server.ts";

const API_KEY = "sk-mock-test-key-9f8e7d6c";

function requestBody(extra: Record<string, unknown> = {}) {
  return {
    model: "mock-model",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ],
    stream: false,
    max_completion_tokens: 64,
    ...extra,
  };
}

function post(
  server: { baseUrl: string },
  body: unknown = requestBody(),
  init: {
    path?: string;
    key?: string | null;
    method?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...init.headers,
  };
  if (init.key !== null) headers.authorization = `Bearer ${init.key ?? API_KEY}`;
  return fetch(`${server.baseUrl}${init.path ?? "/chat/completions"}`, {
    method: init.method ?? "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const content = async (res: Response) =>
  ((await res.json()) as any).choices[0].message.content;

test("chatCompletion and unsupportedParamError produce OpenAI-shaped payloads", () => {
  const c = chatCompletion("hello", { model: "m-1" }) as any;
  assert.equal(c.object, "chat.completion");
  assert.equal(c.model, "m-1");
  assert.equal(c.choices[0].message.role, "assistant");
  assert.equal(c.choices[0].message.content, "hello");
  assert.equal(c.choices[0].finish_reason, "stop");

  const e = unsupportedParamError("response_format");
  assert.equal(e.status, 400);
  const err = (e.json as any).error;
  assert.equal(err.type, "invalid_request_error");
  assert.equal(err.param, "response_format");
  assert.ok(
    err.code === "unsupported_parameter" || err.code === "unsupported_value",
  );
});

test("missing or wrong API key gets a 401 OpenAI-style error", async (t) => {
  const server = await startMockOpenAI({
    apiKey: API_KEY,
    replies: [{ status: 200, json: chatCompletion("ok") }],
  });
  t.after(() => server.close());

  const missing = await post(server, requestBody(), { key: null });
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.type, "invalid_request_error");

  const wrong = await post(server, requestBody(), { key: "sk-wrong" });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error.code, "invalid_api_key");

  assert.equal(server.callCount(), 2);
  const [a, b] = server.calls();
  assert.equal(a.hasAuthorization, false);
  assert.equal(a.authorizationMatches, false);
  assert.equal(b.hasAuthorization, true);
  assert.equal(b.authorizationMatches, false);

  const ok = await post(server);
  assert.equal(ok.status, 200);
  assert.equal(await content(ok), "ok");
});

test("unsupported response_format and token limit field return 400 unsupported errors", async (t) => {
  const server = await startMockOpenAI({
    apiKey: API_KEY,
    supports: {
      jsonSchema: false,
      jsonObject: true,
      maxCompletionTokens: false,
    },
    replies: [
      { status: 200, json: chatCompletion("a") },
      { status: 200, json: chatCompletion("b") },
      { status: 200, json: chatCompletion("c") },
    ],
  });
  t.after(() => server.close());

  const schemaRes = await post(
    server,
    requestBody({ response_format: { type: "json_schema" } }),
  );
  assert.equal(schemaRes.status, 400);
  const e1 = (await schemaRes.json()) as any;
  assert.equal(e1.error.type, "invalid_request_error");
  assert.equal(e1.error.param, "response_format");
  assert.ok(
    ["unsupported_parameter", "unsupported_value"].includes(e1.error.code),
  );

  // Supported format but max_completion_tokens is rejected: 400 on that field.
  const tokenRes = await post(
    server,
    requestBody({ response_format: { type: "json_object" } }),
  );
  assert.equal(tokenRes.status, 400);
  const e2 = (await tokenRes.json()) as any;
  assert.equal(e2.error.param, "max_completion_tokens");

  // json_object + max_tokens is fully supported.
  const okRes = await post(
    server,
    requestBody({
      response_format: { type: "json_object" },
      max_completion_tokens: undefined,
      max_tokens: 64,
    }),
  );
  assert.equal(okRes.status, 200);
  assert.equal(await content(okRes), "a");
  const view = server.calls().at(-1)!;
  assert.equal(view.responseFormatType, "json_object");
  assert.equal(view.tokenLimitField, "max_tokens");

  // "text" is the OpenAI default and always allowed; unknown types are not.
  const textRes = await post(
    server,
    requestBody({
      response_format: { type: "text" },
      max_completion_tokens: undefined,
      max_tokens: 64,
    }),
  );
  assert.equal(await content(textRes), "b");
  const weirdRes = await post(
    server,
    requestBody({
      response_format: { type: "yaml" },
      max_completion_tokens: undefined,
      max_tokens: 64,
    }),
  );
  assert.equal(weirdRes.status, 400);
  assert.equal((await weirdRes.json()).error.param, "response_format");
});

test("replies are consumed in order; empty queue uses fallback, then 500", async (t) => {
  const server = await startMockOpenAI({
    apiKey: API_KEY,
    replies: [
      { status: 200, json: chatCompletion("first") },
      { status: 200, json: chatCompletion("second") },
    ],
    fallback: { status: 200, json: chatCompletion("fallback") },
  });
  t.after(() => server.close());

  const contents: string[] = [];
  for (let i = 0; i < 4; i++) {
    const res = await post(server);
    assert.equal(res.status, 200);
    contents.push(await content(res));
  }
  assert.deepEqual(contents, ["first", "second", "fallback", "fallback"]);

  const empty = await startMockOpenAI({ apiKey: API_KEY });
  t.after(() => empty.close());
  const res = await post(empty);
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.type, "server_error");
});

test("function replies receive the request view and can answer from it", async (t) => {
  const server = await startMockOpenAI({
    apiKey: API_KEY,
    replies: [
      async (req) => ({
        status: 200,
        json: chatCompletion(
          JSON.stringify({
            rf: req.responseFormatType,
            model: (req.body as any).model,
            path: req.path,
          }),
        ),
      }),
    ],
  });
  t.after(() => server.close());

  const res = await post(
    server,
    requestBody({ response_format: { type: "json_object" } }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(await content(res)), {
    rf: "json_object",
    model: "mock-model",
    path: "/v1/chat/completions",
  });
});

test("delayMs stalls the response", async (t) => {
  const server = await startMockOpenAI({
    apiKey: API_KEY,
    replies: [{ status: 200, json: chatCompletion("slow"), delayMs: 150 }],
  });
  t.after(() => server.close());

  const started = Date.now();
  const res = await post(server);
  assert.equal(res.status, 200);
  assert.equal(await content(res), "slow");
  assert.ok(Date.now() - started >= 140);
});

test("slowBodyChunks streams the JSON body in pieces", async (t) => {
  const expected = "chunked-".repeat(200);
  const server = await startMockOpenAI({
    apiKey: API_KEY,
    replies: [{ status: 200, json: chatCompletion(expected), slowBodyChunks: 6 }],
  });
  t.after(() => server.close());

  const started = Date.now();
  const res = await post(server);
  assert.equal(res.status, 200);
  assert.equal(await content(res), expected);
  assert.ok(Date.now() - started >= 40);
});

test("429 replies pass through status and Retry-After header", async (t) => {
  const server = await startMockOpenAI({
    apiKey: API_KEY,
    replies: [
      {
        status: 429,
        headers: { "retry-after": "7" },
        json: {
          error: {
            message: "rate limited",
            type: "rate_limit_error",
            param: null,
            code: "rate_limit_exceeded",
          },
        },
      },
    ],
  });
  t.after(() => server.close());

  const res = await post(server);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "7");
  assert.equal((await res.json()).error.code, "rate_limit_exceeded");
});

test("hasTools reports tools, tool_choice, or functions in the request", async (t) => {
  const server = await startMockOpenAI({
    apiKey: API_KEY,
    fallback: { status: 200, json: chatCompletion("ok") },
  });
  t.after(() => server.close());

  await post(
    server,
    requestBody({ tools: [{ type: "function", function: { name: "f" } }] }),
  );
  await post(server, requestBody({ tool_choice: "auto" }));
  await post(server, requestBody());

  const [withTools, withChoice, plain] = server.calls();
  assert.equal(withTools.hasTools, true);
  assert.equal(withChoice.hasTools, true);
  assert.equal(plain.hasTools, false);
});

test("recorded calls never contain the raw API key", async (t) => {
  const server = await startMockOpenAI({
    apiKey: API_KEY,
    replies: [{ status: 200, json: chatCompletion("ok") }],
  });
  t.after(() => server.close());

  await post(server);
  assert.equal(server.calls()[0].authorizationMatches, true);
  assert.equal(JSON.stringify(server.calls()).includes(API_KEY), false);
});

test("unknown paths and non-POST methods get 404", async (t) => {
  const server: MockOpenAIServer = await startMockOpenAI({ apiKey: API_KEY });
  t.after(() => server.close());

  const wrongPath = await post(server, requestBody(), { path: "/completions" });
  assert.equal(wrongPath.status, 404);

  const get = await fetch(`${server.baseUrl}/chat/completions`, {
    headers: { authorization: `Bearer ${API_KEY}` },
  });
  assert.equal(get.status, 404);
});

test("request bodies over 2MiB get 413 and the server keeps working", async (t) => {
  const server = await startMockOpenAI({
    apiKey: API_KEY,
    fallback: { status: 200, json: chatCompletion("ok") },
  });
  t.after(() => server.close());

  const res = await post(
    server,
    requestBody({ pad: "x".repeat(2 * 1024 * 1024) }),
  );
  assert.equal(res.status, 413);

  const ok = await post(server);
  assert.equal(ok.status, 200);
});

test("reset clears recorded calls and restores the reply queue", async (t) => {
  const server = await startMockOpenAI({
    apiKey: API_KEY,
    replies: [{ status: 200, json: chatCompletion("once") }],
  });
  t.after(() => server.close());

  await post(server);
  const drained = await post(server);
  assert.equal(drained.status, 500);
  assert.equal(server.callCount(), 2);

  server.reset();
  assert.equal(server.callCount(), 0);
  assert.deepEqual(server.calls(), []);
  const res = await post(server);
  assert.equal(await content(res), "once");
});

test("close releases the port", async () => {
  const server = await startMockOpenAI({ apiKey: API_KEY });
  const baseUrl = server.baseUrl;
  await server.close();
  await assert.rejects(post({ baseUrl }));
});
