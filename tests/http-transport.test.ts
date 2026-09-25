import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import type { AddressInfo } from "node:net";
import {
  chatCompletion,
  startMockOpenAI,
  type MockOpenAIServer,
  type MockReplyObject,
} from "./mock-openai-server.ts";
import {
  parseRetryAfter,
  postCompletion,
} from "../src/server/ai/http-transport.ts";
import { AIError } from "../src/server/ai/errors.ts";
import { HTTP_LIMITS } from "../src/ai-contract.ts";
import type { HttpAttemptInput } from "../src/server/ai/types.ts";

const API_KEY = "sk-canary-transport-key-4c2d1b0a";

function attempt(
  url: string,
  body: unknown,
  extra: Partial<HttpAttemptInput> & { apiKey?: string; body?: string } = {},
) {
  return {
    url,
    model: "mock-model",
    messages: [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "ctx" },
    ],
    responseMode: "prompt_json" as const,
    tokenLimitField: "max_completion_tokens" as const,
    maxOutputTokens: 64,
    deadlineAt: Date.now() + 10_000,
    apiKey: API_KEY,
    ...extra,
    body:
      typeof body === "string" ? body : (extra.body ?? JSON.stringify(body)),
  };
}

const requestPayload = { ping: true };

async function expectAIError(code: string, promise: Promise<unknown>) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof AIError, `expected AIError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function withServer(
  opts: Parameters<typeof startMockOpenAI>[0],
  fn: (server: MockOpenAIServer) => Promise<void>,
) {
  const server = await startMockOpenAI(opts);
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

const urlOf = (server: MockOpenAIServer) =>
  `${server.baseUrl}/chat/completions`;

test("200 response returns status, body text and byte count", async () => {
  await withServer(
    { apiKey: API_KEY, fallback: { status: 200, json: chatCompletion("hi") } },
    async (server) => {
      const result = await postCompletion(
        attempt(urlOf(server), requestPayload),
        new AbortController().signal,
      );
      assert.equal(result.status, 200);
      const parsed = JSON.parse(result.bodyText) as any;
      assert.equal(parsed.choices[0].message.content, "hi");
      assert.equal(result.bytes, Buffer.byteLength(result.bodyText, "utf8"));
      assert.equal(result.retryAfterMs, undefined);
      assert.equal(server.callCount(), 1);
      assert.equal(server.calls()[0].authorizationMatches, true);
    },
  );
});

test("non-2xx statuses are returned without classification", async () => {
  const replies: MockReplyObject[] = [
    { status: 401, json: { error: { message: "bad key" } } },
    { status: 500, json: { error: { message: "boom" } } },
  ];
  await withServer({ apiKey: API_KEY, replies }, async (server) => {
    const r401 = await postCompletion(
      attempt(urlOf(server), requestPayload),
      new AbortController().signal,
    );
    assert.equal(r401.status, 401);
    const r500 = await postCompletion(
      attempt(urlOf(server), requestPayload),
      new AbortController().signal,
    );
    assert.equal(r500.status, 500);
    assert.ok(r500.bodyText.includes("boom"));
  });
});

test("Retry-After seconds and HTTP-date are parsed", async () => {
  const future = new Date(Date.now() + 5000).toUTCString();
  const replies: MockReplyObject[] = [
    { status: 429, headers: { "retry-after": "7" }, json: {} },
    { status: 429, headers: { "retry-after": future }, json: {} },
    { status: 429, headers: { "retry-after": "not-a-date" }, json: {} },
    {
      status: 429,
      headers: { "retry-after": new Date(0).toUTCString() },
      json: {},
    },
  ];
  await withServer({ apiKey: API_KEY, replies }, async (server) => {
    const signal = new AbortController().signal;
    const seconds = await postCompletion(
      attempt(urlOf(server), requestPayload),
      signal,
    );
    assert.equal(seconds.status, 429);
    assert.equal(seconds.retryAfterMs, 7000);

    const dated = await postCompletion(
      attempt(urlOf(server), requestPayload),
      signal,
    );
    assert.ok(dated.retryAfterMs !== undefined);
    assert.ok(dated.retryAfterMs > 2000 && dated.retryAfterMs <= 6000);

    const invalid = await postCompletion(
      attempt(urlOf(server), requestPayload),
      signal,
    );
    assert.equal(invalid.retryAfterMs, undefined);
    const past = await postCompletion(
      attempt(urlOf(server), requestPayload),
      signal,
    );
    assert.equal(past.retryAfterMs, undefined);
  });
});

test("parseRetryAfter unit checks", () => {
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter(""), undefined);
  assert.equal(parseRetryAfter("-3"), undefined);
  assert.equal(parseRetryAfter("12"), 12_000);
});

test("3xx redirect is refused as provider_unavailable", async () => {
  await withServer(
    {
      apiKey: API_KEY,
      fallback: {
        status: 302,
        headers: { location: "http://127.0.0.1:9/elsewhere" },
        json: {},
      },
    },
    async (server) => {
      await expectAIError(
        "provider_unavailable",
        postCompletion(
          attempt(urlOf(server), requestPayload),
          new AbortController().signal,
        ),
      );
    },
  );
});

test("2xx body over response byte limit aborts with output_limit", async () => {
  const big = "X".repeat(HTTP_LIMITS.responseBytes + 64);
  await withServer(
    { apiKey: API_KEY, fallback: { status: 200, body: big } },
    async (server) => {
      await expectAIError(
        "output_limit",
        postCompletion(
          attempt(urlOf(server), requestPayload),
          new AbortController().signal,
        ),
      );
    },
  );
});

test("non-2xx body is truncated at the error byte cap", async () => {
  const big = "E".repeat(HTTP_LIMITS.errorBodyBytes * 3);
  await withServer(
    { apiKey: API_KEY, fallback: { status: 500, body: big } },
    async (server) => {
      const result = await postCompletion(
        attempt(urlOf(server), requestPayload),
        new AbortController().signal,
      );
      assert.equal(result.status, 500);
      assert.equal(result.bytes, HTTP_LIMITS.errorBodyBytes);
      assert.equal(result.bodyText.length, HTTP_LIMITS.errorBodyBytes);
      assert.ok(/^E+$/.test(result.bodyText));
    },
  );
});

test("deadline during a slow body read produces timeout", async () => {
  const body = "Y".repeat(20_000);
  await withServer(
    { apiKey: API_KEY, fallback: { status: 200, body, slowBodyChunks: 200 } },
    async (server) => {
      await expectAIError(
        "timeout",
        postCompletion(
          attempt(urlOf(server), requestPayload, {
            deadlineAt: Date.now() + 100,
          }),
          new AbortController().signal,
        ),
      );
    },
  );
});

test("already-expired deadline produces timeout without sending", async () => {
  await withServer(
    { apiKey: API_KEY, fallback: { status: 200, json: {} } },
    async (server) => {
      await expectAIError(
        "timeout",
        postCompletion(
          attempt(urlOf(server), requestPayload, {
            deadlineAt: Date.now() - 1,
          }),
          new AbortController().signal,
        ),
      );
      assert.equal(server.callCount(), 0);
    },
  );
});

test("user abort during a slow body read produces cancelled", async () => {
  const body = "Y".repeat(20_000);
  await withServer(
    { apiKey: API_KEY, fallback: { status: 200, body, slowBodyChunks: 200 } },
    async (server) => {
      const controller = new AbortController();
      const promise = postCompletion(
        attempt(urlOf(server), requestPayload),
        controller.signal,
      );
      setTimeout(() => controller.abort(), 60);
      await expectAIError("cancelled", promise);
    },
  );
});

test("pre-aborted signal produces cancelled without sending", async () => {
  await withServer(
    { apiKey: API_KEY, fallback: { status: 200, json: {} } },
    async (server) => {
      const controller = new AbortController();
      controller.abort();
      await expectAIError(
        "cancelled",
        postCompletion(
          attempt(urlOf(server), requestPayload),
          controller.signal,
        ),
      );
      assert.equal(server.callCount(), 0);
    },
  );
});

test("connection refused produces provider_unavailable", async () => {
  const port = await unusedPort();
  await expectAIError(
    "provider_unavailable",
    postCompletion(
      attempt(`http://127.0.0.1:${port}/v1/chat/completions`, requestPayload),
      new AbortController().signal,
    ),
  );
});

test("request body over the byte cap fails with input_limit before send", async () => {
  await withServer(
    { apiKey: API_KEY, fallback: { status: 200, json: {} } },
    async (server) => {
      const bigBody = " ".repeat(HTTP_LIMITS.requestBytes + 1);
      await expectAIError(
        "input_limit",
        postCompletion(
          attempt(urlOf(server), requestPayload, { body: bigBody }),
          new AbortController().signal,
        ),
      );
      assert.equal(server.callCount(), 0);
    },
  );
});

test("api key never appears in results or errors", async () => {
  await withServer(
    { apiKey: API_KEY, fallback: { status: 200, json: chatCompletion("ok") } },
    async (server) => {
      const result = await postCompletion(
        attempt(urlOf(server), requestPayload),
        new AbortController().signal,
      );
      assert.ok(!JSON.stringify(result).includes(API_KEY));
      assert.ok(!result.bodyText.includes(API_KEY));
    },
  );

  const port = await unusedPort();
  await assert.rejects(
    postCompletion(
      attempt(`http://127.0.0.1:${port}/v1/chat/completions`, requestPayload),
      new AbortController().signal,
    ),
    (err: unknown) => {
      assert.ok(err instanceof AIError);
      assert.ok(!String(err).includes(API_KEY));
      assert.ok(!String(err.stack).includes(API_KEY));
      assert.ok(!JSON.stringify(err.detail ?? null).includes(API_KEY));
      return true;
    },
  );
});
