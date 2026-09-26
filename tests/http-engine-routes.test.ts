import test from "node:test";
import assert from "node:assert/strict";
import {
  createHttpVerifier,
  handleHttpEngineAction,
  isHttpEngineAction,
  type HttpEngineActionResult,
} from "../src/server/http-engine-routes.ts";
import { HttpEngineSetup } from "../src/server/http-engine-setup.ts";
import { HTTP_LIMITS, type HttpEngineView } from "../src/ai-contract.ts";
import {
  chatCompletion,
  startMockOpenAI,
  type MockOpenAIServer,
} from "./mock-openai-server.ts";

const API_KEY = "sk-route-canary-5e1a8f3b2d";
const WRONG_KEY = "sk-route-wrong-9c0d4e";

let idSeq = 0;
function makeSetup(verifier = createHttpVerifier()) {
  return new HttpEngineSetup({
    verifier,
    randomId: () => `cfg-${++idSeq}`,
  });
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

function configureBody(
  baseUrl: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action: "configure-http",
    providerId: "openai-compatible",
    baseUrl,
    model: "mock-model",
    apiKey: API_KEY,
    ...overrides,
  };
}

function httpView(res: HttpEngineActionResult): HttpEngineView {
  assert.ok(
    "http" in res.body,
    `expected http view, got ${JSON.stringify(res.body)}`,
  );
  const view = res.body.http;
  assert.ok(view);
  return view;
}

test("isHttpEngineAction accepts only the three http actions", () => {
  for (const action of ["configure-http", "verify-http", "forget-http"])
    assert.equal(isHttpEngineAction({ action }), true);
  for (const body of [
    null,
    undefined,
    1,
    "configure-http",
    [],
    {},
    { action: "rescan" },
    { action: "configure" },
    { action: ["configure-http"] },
  ])
    assert.equal(isHttpEngineAction(body), false);
});

test("wrong key sets and value types are rejected with 400", async () => {
  const setup = makeSetup(async () => {});
  const bad: Record<string, unknown>[] = [
    // configure-http
    configureBody("https://api.example.com/v1", { extra: 1 }),
    {
      action: "configure-http",
      providerId: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
    },
    configureBody("https://api.example.com/v1", { providerId: "codex" }),
    configureBody("https://api.example.com/v1", { apiKey: 42 }),
    configureBody("https://api.example.com/v1", { baseUrl: 7 }),
    configureBody("https://api.example.com/v1", { model: null }),
    configureBody("https://api.example.com/v1", { expectedRevision: 1.5 }),
    configureBody("https://api.example.com/v1", { configId: 9 }),
    // verify-http
    { action: "verify-http", configId: "c", revision: 1 },
    { action: "verify-http", configId: "c", revision: 1, consent: false },
    { action: "verify-http", configId: "c", revision: "1", consent: true },
    { action: "verify-http", configId: 3, revision: 1, consent: true },
    {
      action: "verify-http",
      configId: "c",
      revision: 1,
      consent: true,
      extra: 0,
    },
    // forget-http
    { action: "forget-http", configId: "c", revision: 1, consent: true },
    { action: "forget-http", configId: "c" },
    { action: "forget-http", configId: "c", revision: "x" },
    { action: "rescan" },
  ];
  for (const body of bad) {
    const res = await handleHttpEngineAction(setup, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok("error" in res.body);
    if ("error" in res.body) {
      assert.equal(res.body.error, "http engine setup failed");
      assert.equal(res.body.code, "invalid_request");
    }
  }
});

test("configure-http returns the credential-free view and scrubs apiKey", async () => {
  const setup = makeSetup(async () => {});
  const body = configureBody("https://api.example.com/v1");
  const res = await handleHttpEngineAction(setup, body);
  assert.equal(res.status, 200);
  const view = httpView(res);
  assert.equal(view.providerId, "openai-compatible");
  assert.equal(view.transport, "http");
  assert.equal(view.hasApiKey, true);
  assert.equal(view.verification, "not_checked");
  assert.equal(view.host, "api.example.com");
  assert.equal(view.model, "mock-model");
  assert.equal("apiKey" in body, false);
  const json = JSON.stringify(res.body);
  assert.equal(json.includes(API_KEY), false);
  assert.equal(json.includes(API_KEY.slice(-6)), false);
  assert.equal(json.includes("/v1"), false);
});

test("apiKey is scrubbed even when configure fails", async () => {
  const setup = makeSetup(async () => {});
  const body = configureBody("ftp://not-allowed");
  const res = await handleHttpEngineAction(setup, body);
  assert.equal(res.status, 400);
  assert.ok("error" in res.body);
  if ("error" in res.body) assert.equal(res.body.code, "invalid_request");
  assert.equal("apiKey" in body, false);
  assert.equal(JSON.stringify(res.body).includes(API_KEY), false);
});

test("a missing key maps to 400 auth_required", async () => {
  const setup = makeSetup(async () => {});
  const body = configureBody("https://api.example.com/v1");
  delete body.apiKey;
  const res = await handleHttpEngineAction(setup, body);
  assert.equal(res.status, 400);
  assert.ok("error" in res.body);
  if ("error" in res.body) assert.equal(res.body.code, "auth_required");
});

test("non-AIError failures map to a 500 fixed phrase", async () => {
  const broken = {
    configure() {
      throw new Error(`internal detail with ${API_KEY}`);
    },
  } as unknown as HttpEngineSetup;
  const res = await handleHttpEngineAction(
    broken,
    configureBody("https://api.example.com/v1"),
  );
  assert.equal(res.status, 500);
  assert.ok("error" in res.body);
  if ("error" in res.body) {
    assert.equal(res.body.error, "http engine setup failed");
    assert.equal("code" in res.body, false);
  }
  assert.equal(JSON.stringify(res.body).includes(API_KEY), false);
});

test("verify-http runs a completion probe and reports verified", async () => {
  await withServer(
    {
      apiKey: API_KEY,
      fallback: { status: 200, json: chatCompletion('{"ok":true}') },
    },
    async (server) => {
      const setup = makeSetup();
      const configured = httpView(
        await handleHttpEngineAction(setup, configureBody(server.baseUrl)),
      );
      const res = await handleHttpEngineAction(setup, {
        action: "verify-http",
        configId: configured.configId,
        revision: configured.revision,
        consent: true,
      });
      assert.equal(res.status, 200);
      const view = httpView(res);
      assert.equal(view.verification, "verified");
      assert.equal(view.ready, true);
      assert.deepEqual(view.blockers, []);
      assert.equal(server.callCount(), 1);
      const call = server.calls()[0];
      assert.equal(call.path, "/v1/chat/completions");
      assert.equal(call.method, "POST");
      assert.equal(call.authorizationMatches, true);
      assert.equal(call.tokenLimitField, "max_completion_tokens");
      assert.equal(call.responseFormatType, undefined);
      assert.equal(call.hasTools, false);
      const sent = call.body as Record<string, unknown>;
      assert.equal(sent.stream, false);
      assert.equal(sent.model, "mock-model");
      assert.equal(
        sent.max_completion_tokens,
        HTTP_LIMITS.verifyMaxOutputTokens,
      );
      assert.equal(JSON.stringify(res.body).includes(API_KEY), false);
      assert.equal(JSON.stringify(res.body).includes("/v1"), false);
    },
  );
});

test("verify-http against a rejected key reports failed + auth_invalid", async () => {
  await withServer(
    {
      apiKey: API_KEY,
      fallback: { status: 200, json: chatCompletion('{"ok":true}') },
    },
    async (server) => {
      const setup = makeSetup();
      const configured = httpView(
        await handleHttpEngineAction(
          setup,
          configureBody(server.baseUrl, { apiKey: WRONG_KEY }),
        ),
      );
      const res = await handleHttpEngineAction(setup, {
        action: "verify-http",
        configId: configured.configId,
        revision: configured.revision,
        consent: true,
      });
      assert.equal(res.status, 200);
      const view = httpView(res);
      assert.equal(view.verification, "failed");
      assert.equal(view.ready, false);
      assert.deepEqual(view.blockers, ["auth_invalid"]);
      const json = JSON.stringify(res.body);
      assert.equal(json.includes(WRONG_KEY), false);
      assert.equal(json.includes("/v1"), false);
    },
  );
});

test("verify falls back to max_tokens on an explicit field rejection", async () => {
  await withServer(
    {
      apiKey: API_KEY,
      supports: {
        jsonSchema: true,
        jsonObject: true,
        maxCompletionTokens: false,
      },
      fallback: { status: 200, json: chatCompletion('{"ok":true}') },
    },
    async (server) => {
      const setup = makeSetup();
      const configured = httpView(
        await handleHttpEngineAction(setup, configureBody(server.baseUrl)),
      );
      const res = await handleHttpEngineAction(setup, {
        action: "verify-http",
        configId: configured.configId,
        revision: configured.revision,
        consent: true,
      });
      assert.equal(res.status, 200);
      assert.equal(httpView(res).verification, "verified");
      assert.equal(server.callCount(), 2);
      const fields = server.calls().map((c) => c.tokenLimitField);
      assert.deepEqual(fields, ["max_completion_tokens", "max_tokens"]);
    },
  );
});

test("verify retries a plain 429 within the attempt cap and succeeds", async () => {
  await withServer(
    {
      apiKey: API_KEY,
      replies: [
        {
          status: 429,
          headers: { "retry-after": "0" },
          json: {
            error: {
              message: "Rate limit reached.",
              type: "rate_limit_error",
              param: null,
              code: "rate_limit",
            },
          },
        },
      ],
      fallback: { status: 200, json: chatCompletion('{"ok":true}') },
    },
    async (server) => {
      const setup = makeSetup();
      const configured = httpView(
        await handleHttpEngineAction(setup, configureBody(server.baseUrl)),
      );
      const res = await handleHttpEngineAction(setup, {
        action: "verify-http",
        configId: configured.configId,
        revision: configured.revision,
        consent: true,
      });
      assert.equal(res.status, 200);
      assert.equal(httpView(res).verification, "verified");
      assert.equal(server.callCount(), 2);
      assert.ok(server.callCount() <= HTTP_LIMITS.maxAttemptsPerStage);
    },
  );
});

test("verify never succeeds on /models alone and a bad probe fails closed", async () => {
  await withServer(
    {
      apiKey: API_KEY,
      fallback: { status: 200, json: chatCompletion("not json") },
    },
    async (server) => {
      const setup = makeSetup();
      const configured = httpView(
        await handleHttpEngineAction(setup, configureBody(server.baseUrl)),
      );
      const res = await handleHttpEngineAction(setup, {
        action: "verify-http",
        configId: configured.configId,
        revision: configured.revision,
        consent: true,
      });
      assert.equal(res.status, 200);
      const view = httpView(res);
      assert.equal(view.verification, "failed");
      assert.deepEqual(view.blockers, ["invalid_json"]);
      // The probe only ever POSTs to /chat/completions.
      for (const call of server.calls()) {
        assert.equal(call.path, "/v1/chat/completions");
        assert.equal(call.method, "POST");
      }
    },
  );
});

test("verify-http with a stale revision returns 400", async () => {
  const setup = makeSetup(async () => {});
  const configured = httpView(
    await handleHttpEngineAction(
      setup,
      configureBody("https://api.example.com/v1"),
    ),
  );
  const res = await handleHttpEngineAction(setup, {
    action: "verify-http",
    configId: configured.configId,
    revision: configured.revision + 1,
    consent: true,
  });
  assert.equal(res.status, 400);
  assert.ok("error" in res.body);
  if ("error" in res.body) assert.equal(res.body.code, "invalid_request");
});

test("forget-http drops the key and bumps the revision", async () => {
  const setup = makeSetup(async () => {});
  const configured = httpView(
    await handleHttpEngineAction(
      setup,
      configureBody("https://api.example.com/v1"),
    ),
  );
  const res = await handleHttpEngineAction(setup, {
    action: "forget-http",
    configId: configured.configId,
    revision: configured.revision,
  });
  assert.equal(res.status, 200);
  const view = httpView(res);
  assert.equal(view.hasApiKey, false);
  assert.equal(view.ready, false);
  assert.equal(view.revision, configured.revision + 1);
  assert.equal(view.host, "api.example.com");
  // A second forget with the stale revision is rejected.
  const stale = await handleHttpEngineAction(setup, {
    action: "forget-http",
    configId: configured.configId,
    revision: configured.revision,
  });
  assert.equal(stale.status, 400);
});
