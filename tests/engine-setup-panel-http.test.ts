import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EngineSetupPanel,
  buildConfigureHttpBody,
  configureHttpEngine,
  forgetHttpEngine,
  httpSetupErrorText,
  isStaleHttpVerify,
  verifyHttpEngine,
} from "../src/engine-setup-panel.tsx";
import type { HttpEngineDraft } from "../src/http-engine-setup-form.tsx";
import type { HttpEngineView } from "../src/ai-contract.ts";

function httpView(overrides: Partial<HttpEngineView> = {}): HttpEngineView {
  return {
    providerId: "openai-compatible",
    transport: "http",
    configId: "cfg-fake-1",
    revision: 3,
    host: "api.example.com",
    model: "model-x",
    hasApiKey: true,
    verification: "not_checked",
    blockers: [],
    ready: false,
    ...overrides,
  };
}

const draft = (overrides: Partial<HttpEngineDraft> = {}): HttpEngineDraft => ({
  baseUrl: "https://api.example.com/v1",
  model: "model-x",
  apiKey: "fake-key",
  ...overrides,
});

function renderPanel(providerId: "codex" | "claude" | "openai-compatible") {
  let calls = 0;
  const api = async <T>(): Promise<T> => {
    calls++;
    throw new Error("not called");
  };
  const html = renderToStaticMarkup(
    React.createElement(EngineSetupPanel, {
      api,
      ready: true,
      providerId,
      onProviderChange: () => {},
    }),
  );
  return { html, calls };
}

test("HTTP selection renders the setup form and no CLI install/auth UI", () => {
  const { html, calls } = renderPanel("openai-compatible");
  assert.equal(calls, 0);
  assert.match(html, /value="openai-compatible"/);
  assert.match(html, /checked=""/);
  assert.match(html, /aria-label="OpenAI 호환 API 설정"/);
  assert.match(html, /Base URL/);
  assert.match(html, /연결 확인/);
  assert.match(html, /키 삭제/);
  assert.doesNotMatch(html, /상세 진단 · 설치/);
  assert.doesNotMatch(html, /공식 설치 안내/);
  assert.doesNotMatch(html, /setup token/i);
  assert.doesNotMatch(html, /로그인 재사용/);
});

test("CLI selection keeps the existing panel and renders no HTTP form", () => {
  for (const providerId of ["codex", "claude"] as const) {
    const { html, calls } = renderPanel(providerId);
    assert.equal(calls, 0);
    assert.match(html, /value="openai-compatible"/); // option stays listed
    assert.doesNotMatch(html, /http-engine-setup/);
    assert.doesNotMatch(html, /aria-label="OpenAI 호환 API 설정"/);
    assert.match(html, /다시 검색/);
    assert.match(html, /설치 상태 확인 중…/);
  }
});

test("configure posts the exact key set for a new config", async () => {
  let sent = "";
  const post = async (serialized: string) => {
    sent = serialized;
    return { http: httpView() };
  };
  const result = await configureHttpEngine(post, null, draft());
  assert.ok(result.ok);
  const body = JSON.parse(sent);
  assert.deepEqual(Object.keys(body).sort(), [
    "action",
    "apiKey",
    "baseUrl",
    "model",
    "providerId",
  ]);
  assert.equal(body.action, "configure-http");
  assert.equal(body.providerId, "openai-compatible");
  assert.equal(body.baseUrl, "https://api.example.com/v1");
  assert.equal(body.model, "model-x");
  assert.equal(body.apiKey, "fake-key");
});

test("configure with a saved view adds configId and expectedRevision", async () => {
  let sent = "";
  const post = async (serialized: string) => {
    sent = serialized;
    return { http: httpView({ revision: 4 }) };
  };
  const view = httpView({ configId: "cfg-9", revision: 11 });
  const result = await configureHttpEngine(post, view, draft());
  assert.ok(result.ok && result.view?.revision === 4);
  const body = JSON.parse(sent);
  assert.equal(body.configId, "cfg-9");
  assert.equal(body.expectedRevision, 11);
  assert.deepEqual(Object.keys(body).sort(), [
    "action",
    "apiKey",
    "baseUrl",
    "configId",
    "expectedRevision",
    "model",
    "providerId",
  ]);
  // An untouched key field is omitted, never sent as an empty string.
  await configureHttpEngine(post, view, draft({ apiKey: "" }));
  const kept = JSON.parse(sent);
  assert.ok(!("apiKey" in kept));
  assert.equal(kept.expectedRevision, 11);
});

test("configure failures surface fixed phrases, never raw server text", async () => {
  const fail = (code?: string) => async () => {
    throw code === undefined
      ? new Error("http engine setup failed")
      : Object.assign(new Error("http engine setup failed"), { code });
  };
  const auth = await configureHttpEngine(fail("auth_required"), null, draft());
  assert.deepEqual(auth, {
    ok: false,
    text: "엔드포인트를 바꾸면 API 키를 다시 입력해야 합니다",
  });
  const version = await configureHttpEngine(
    fail("invalid_request"),
    null,
    draft(),
  );
  assert.deepEqual(version, {
    ok: false,
    text: "입력값 또는 설정 버전이 맞지 않습니다. 새로고침 후 다시 시도하세요",
  });
  for (const bad of ["quota_exceeded", undefined]) {
    const r = await configureHttpEngine(fail(bad), null, draft());
    assert.deepEqual(r, { ok: false, text: "설정을 저장하지 못했습니다" });
  }
  // A verbose server message is replaced by the generic phrase.
  const raw = await configureHttpEngine(
    async () => {
      throw new Error("upstream 10.0.0.1 rejected key sk-live-secret");
    },
    null,
    draft(),
  );
  assert.equal(raw.ok, false);
  assert.equal(raw.text, "설정을 저장하지 못했습니다");
  assert.doesNotMatch(raw.text, /sk-live|10\.0\.0\.1/);
  // A bare-code message still maps to the matching fixed phrase.
  const coded = await configureHttpEngine(
    async () => {
      throw new Error("auth_required");
    },
    null,
    draft(),
  );
  assert.equal(coded.ok, false);
  assert.equal(coded.text, "엔드포인트를 바꾸면 API 키를 다시 입력해야 합니다");
});

test("verify posts consent-bound body and discards stale revisions", async () => {
  let sent = "";
  const base = httpView({ configId: "cfg-1", revision: 7 });
  const post = async (serialized: string) => {
    sent = serialized;
    return { http: httpView({ verification: "verified", ready: true }) };
  };
  const result = await verifyHttpEngine(
    post,
    { configId: "cfg-1", revision: 7 },
    () => base,
  );
  assert.ok(result !== "stale" && result.ok);
  assert.equal(result.view?.verification, "verified");
  const body = JSON.parse(sent);
  assert.deepEqual(Object.keys(body).sort(), [
    "action",
    "configId",
    "consent",
    "revision",
  ]);
  assert.equal(body.action, "verify-http");
  assert.equal(body.consent, true);
});

test("a verify response is dropped when the committed revision moved on", async () => {
  const base = httpView({ configId: "cfg-1", revision: 7 });
  let current: HttpEngineView | null = base;
  const result = await verifyHttpEngine(
    async () => {
      // A newer configure landed while the verify request was in flight.
      current = httpView({ configId: "cfg-1", revision: 8 });
      return { http: current };
    },
    { configId: "cfg-1", revision: 7 },
    () => current,
  );
  assert.equal(result, "stale");
  // Same rule when the config disappeared entirely.
  const gone = await verifyHttpEngine(
    async () => ({ http: base }),
    { configId: "cfg-1", revision: 7 },
    () => null,
  );
  assert.equal(gone, "stale");
  // A failure is discarded too: its fixed text belongs to the old revision.
  const failed = await verifyHttpEngine(
    async () => {
      throw Object.assign(new Error("http engine setup failed"), {
        code: "provider_failed",
      });
    },
    { configId: "cfg-1", revision: 7 },
    () => null,
  );
  assert.equal(failed, "stale");
  // Same revision on return: the result is applied normally.
  const fresh = await verifyHttpEngine(
    async () => ({ http: httpView({ verification: "verified" }) }),
    { configId: "cfg-1", revision: 7 },
    () => base,
  );
  assert.ok(fresh !== "stale" && fresh.ok);
});

test("forget posts the exact body and reports fixed failure text", async () => {
  let sent = "";
  const post = async (serialized: string) => {
    sent = serialized;
    return { http: httpView({ hasApiKey: false, revision: 4 }) };
  };
  const result = await forgetHttpEngine(post, {
    configId: "cfg-1",
    revision: 7,
  });
  assert.ok(result.ok && result.view?.hasApiKey === false);
  const body = JSON.parse(sent);
  assert.deepEqual(Object.keys(body).sort(), [
    "action",
    "configId",
    "revision",
  ]);
  assert.equal(body.action, "forget-http");
  const failed = await forgetHttpEngine(
    async () => {
      throw Object.assign(new Error("http engine setup failed"), {
        code: "invalid_request",
      });
    },
    { configId: "cfg-1", revision: 7 },
  );
  assert.deepEqual(failed, {
    ok: false,
    text: "입력값 또는 설정 버전이 맞지 않습니다. 새로고침 후 다시 시도하세요",
  });
});

test("the key exists only inside the serialized request payload", async () => {
  const KEY = "sk-test-7f00-secret-key";
  let sent = "";
  const post = async (serialized: string) => {
    sent = serialized;
    return { http: httpView({ hasApiKey: true }) };
  };
  const result = await configureHttpEngine(post, null, draft({ apiKey: KEY }));
  assert.ok(result.ok);
  assert.equal(JSON.parse(sent).apiKey, KEY);
  assert.ok(!JSON.stringify(result).includes(KEY));
  // Rendered markup never carries the key either.
  const { html } = renderPanel("openai-compatible");
  assert.ok(!html.includes(KEY));
  // The body builder does not copy the key to any other field.
  const body = buildConfigureHttpBody(draft({ apiKey: KEY }), null);
  for (const [k, v] of Object.entries(body))
    if (k !== "apiKey") assert.ok(!String(v).includes(KEY), k);
});

test("httpSetupErrorText covers verify and forget fallbacks", () => {
  assert.equal(
    httpSetupErrorText("verify", "provider_unavailable"),
    "연결 확인을 완료하지 못했습니다",
  );
  assert.equal(
    httpSetupErrorText("forget", "provider_failed"),
    "키를 삭제하지 못했습니다",
  );
  assert.equal(
    httpSetupErrorText("verify", undefined),
    "연결 확인을 완료하지 못했습니다",
  );
});

test("isStaleHttpVerify only accepts the request-time revision", () => {
  assert.equal(isStaleHttpVerify(3, httpView({ revision: 3 })), false);
  assert.equal(isStaleHttpVerify(3, httpView({ revision: 4 })), true);
  assert.equal(isStaleHttpVerify(3, null), true);
});
