import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  HttpEngineSetupForm,
  httpDraftWarning,
  normalizeHttpBaseUrl,
  validateApiKeyText,
  validateHttpDraft,
  type HttpEngineDraft,
} from "../src/http-engine-setup-form.tsx";
import type { HttpEngineView } from "../src/ai-contract.ts";
import type { AIErrorCode } from "../src/server/ai/errors.ts";

type Props = {
  view: HttpEngineView | null;
  busy: boolean;
  active?: boolean;
  onConfigure(draft: HttpEngineDraft): Promise<boolean>;
  onVerify(): void;
  onForget(): Promise<boolean>;
  onInvalidate(): void;
};

function baseProps(overrides: Partial<Props> = {}) {
  const calls: string[] = [];
  const props: Props = {
    view: null,
    busy: false,
    onConfigure: async () => {
      calls.push("configure");
      return true;
    },
    onVerify: () => {
      calls.push("verify");
    },
    onForget: async () => {
      calls.push("forget");
      return true;
    },
    onInvalidate: () => {
      calls.push("invalidate");
    },
    ...overrides,
  };
  return { props, calls };
}

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

function render(props: Props) {
  return renderToStaticMarkup(React.createElement(HttpEngineSetupForm, props));
}

const draft = (overrides: Partial<HttpEngineDraft> = {}): HttpEngineDraft => ({
  baseUrl: "https://api.example.com/v1",
  model: "model-x",
  apiKey: "fake-key",
  ...overrides,
});

test("renders fields with labels, placeholder, and describedby help links", () => {
  const { props, calls } = baseProps();
  const html = render(props);
  assert.equal(calls.length, 0);
  assert.match(html, /aria-label="OpenAI 호환 API 설정"/);
  assert.match(html, /<input[^>]*type="url"[^>]*\/>/);
  assert.match(html, /placeholder="https:\/\/api\.example\.com\/v1"/);
  assert.match(
    html,
    /<input[^>]*aria-describedby="http-engine-url-help"[^>]*\/>/,
  );
  assert.match(
    html,
    /<small id="http-engine-url-help"[^>]*>끝에 \/chat\/completions가 붙습니다<\/small>/,
  );
  assert.match(
    html,
    /<input[^>]*aria-describedby="http-engine-model-help"[^>]*\/>/,
  );
  assert.match(
    html,
    /<input[^>]*aria-describedby="http-engine-key-help"[^>]*\/>/,
  );
  assert.match(html, /Base URL/);
  assert.match(html, /모델 ID/);
  assert.match(html, /API 키/);
});

test("password input exists and never carries a key value", () => {
  const { props } = baseProps({ view: httpView() });
  const html = render(props);
  const input = html.match(/<input[^>]*type="password"[^>]*\/>/)![0];
  assert.match(input, /auto[Cc]omplete="off"/);
  assert.match(input, /value=""/);
  assert.doesNotMatch(html, /fake-key|apiKey=|value="[^"]*key/i);
});

test("stored key shows a fixed mask and no last digits", () => {
  const { props } = baseProps({ view: httpView({ hasApiKey: true }) });
  const html = render(props);
  assert.match(html, /등록됨 ••••/);
  assert.match(html, /비워 두면 같은 엔드포인트에서 등록된 키를 유지합니다/);
});

test("no mask text when the server reports no stored key", () => {
  const { props } = baseProps({
    view: httpView({ hasApiKey: false }),
  });
  const html = render(props);
  assert.doesNotMatch(html, /등록됨 ••••/);
});

test("view status shows host, model, and Korean verification text", () => {
  for (const [verification, text] of [
    ["not_checked", "연결 확인 전"],
    ["checking", "연결 확인 중…"],
    ["verified", "연결 확인됨"],
    ["failed", "연결 확인 실패"],
  ] as const) {
    const { props } = baseProps({
      view: httpView({ verification, model: "model-y", host: "h1.test:8443" }),
    });
    const html = render(props);
    assert.match(html, /h1\.test:8443/);
    assert.match(html, /모델 model-y/);
    assert.match(html, new RegExp(text));
  }
});

test("blockers render Korean text with codes and a generic fallback", () => {
  const { props } = baseProps({
    view: httpView({
      blockers: ["auth_required", "mystery_blocker" as AIErrorCode],
    }),
  });
  const html = render(props);
  assert.match(html, /aria-label="엔진 준비 차단 이유"/);
  assert.match(html, /data-code="auth_required"/);
  assert.match(html, /API 키가 등록되지 않았습니다/);
  assert.match(html, /data-code="mystery_blocker"/);
  assert.match(html, /엔진 준비를 완료하지 못했습니다/);
});

test("save button stays disabled until the draft validates", () => {
  const { props } = baseProps({ view: httpView() });
  const html = render(props);
  const button = html.match(
    /<button[^>]*type="submit"[^>]*>저장<\/button>/,
  )![0];
  assert.match(button, /disabled/);
});

test("verify button requires a stored key and is not busy", () => {
  const enabled = render(baseProps({ view: httpView() }).props);
  const enabledButton = enabled.match(/<button[^>]*>연결 확인<\/button>/)![0];
  assert.doesNotMatch(enabledButton, /disabled/);
  assert.match(
    enabled,
    /연결 확인은 작은 요청 1건\(최대 4회 시도\)을 보냅니다/,
  );
  for (const overrides of [
    { view: null },
    { view: httpView({ hasApiKey: false }) },
    { view: httpView(), busy: true },
  ] as const) {
    const html = render(baseProps(overrides).props);
    const button = html.match(/<button[^>]*>연결 확인<\/button>/)![0];
    assert.match(button, /disabled/);
  }
});

test("forget button requires a stored key", () => {
  const enabled = render(baseProps({ view: httpView() }).props);
  const button = enabled.match(/<button[^>]*>키 삭제<\/button>/)![0];
  assert.doesNotMatch(button, /disabled/);
  const disabled = render(
    baseProps({ view: httpView({ hasApiKey: false }) }).props,
  );
  const disabledButton = disabled.match(/<button[^>]*>키 삭제<\/button>/)![0];
  assert.match(disabledButton, /disabled/);
});

test("validateHttpDraft accepts a valid new draft", () => {
  assert.deepEqual(validateHttpDraft(draft(), null), []);
});

test("validateHttpDraft rejects credential-bearing, query, fragment, and non-http URLs", () => {
  const cases: [string, RegExp][] = [
    ["https://user:pw@api.example.com/v1", /사용자 이름·비밀번호/],
    ["https://api.example.com/v1?x=1", /쿼리 문자열/],
    ["https://api.example.com/v1#frag", /프래그먼트/],
    ["ftp://api.example.com/v1", /http:\/\/ 또는 https:\/\/ 절대 URL/],
    ["api.example.com/v1", /절대 URL/],
  ];
  for (const [baseUrl, pattern] of cases) {
    const errors = validateHttpDraft(draft({ baseUrl }), null);
    assert.ok(
      errors.some((e) => pattern.test(e)),
      `expected ${baseUrl} to fail with ${pattern}, got ${JSON.stringify(errors)}`,
    );
  }
});

test("validateHttpDraft rejects missing or malformed model ids", () => {
  assert.ok(
    validateHttpDraft(draft({ model: "  " }), null).some((e) =>
      /모델 ID를 입력하세요/.test(e),
    ),
  );
  assert.ok(
    validateHttpDraft(draft({ model: "bad model" }), null).some((e) =>
      /모델 ID 형식/.test(e),
    ),
  );
});

test("http draft is a warning, not an error", () => {
  const httpDraft = draft({ baseUrl: "http://localhost:8080/v1" });
  assert.deepEqual(validateHttpDraft(httpDraft, null), []);
  assert.match(httpDraftWarning(httpDraft)!, /암호화되지 않은 연결/);
  assert.equal(httpDraftWarning(draft()), null);
  assert.equal(httpDraftWarning(draft({ baseUrl: "not a url" })), null);
});

test("key is required for a new setup but optional when the endpoint is unchanged", () => {
  assert.ok(
    validateHttpDraft(draft({ apiKey: "" }), null).some((e) =>
      /API 키를 입력하세요/.test(e),
    ),
  );
  const view = httpView({ hasApiKey: true, host: "api.example.com" });
  assert.deepEqual(validateHttpDraft(draft({ apiKey: "" }), view), []);
});

test("key is required again when the endpoint host changes", () => {
  const view = httpView({ hasApiKey: true, host: "api.example.com" });
  const errors = validateHttpDraft(
    draft({ baseUrl: "https://other.example.com/v1", apiKey: "" }),
    view,
  );
  assert.ok(errors.some((e) => /엔드포인트가 변경되었습니다/.test(e)));
  const withKey = validateHttpDraft(
    draft({ baseUrl: "https://other.example.com/v1" }),
    view,
  );
  assert.deepEqual(withKey, []);
});

test("normalizeHttpBaseUrl matches the server normalization rules", () => {
  assert.equal(
    normalizeHttpBaseUrl("https://api.example.com/v1/"),
    "https://api.example.com/v1",
  );
  assert.equal(
    normalizeHttpBaseUrl("https://api.example.com"),
    "https://api.example.com",
  );
  assert.equal(
    normalizeHttpBaseUrl("http://localhost:8080/v1///"),
    "http://localhost:8080/v1",
  );
  // Case-insensitive scheme/authority, same as the server regex.
  assert.equal(
    normalizeHttpBaseUrl("HTTPS://API.EXAMPLE.COM/v1"),
    "https://api.example.com/v1",
  );
  assert.equal(normalizeHttpBaseUrl("https://u:p@api.example.com/v1"), null);
  assert.equal(normalizeHttpBaseUrl("https://api.example.com/v1?x=1"), null);
  assert.equal(normalizeHttpBaseUrl("https://api.example.com/v1#f"), null);
  assert.equal(normalizeHttpBaseUrl("ftp://api.example.com/v1"), null);
  // Spellings WHATWG silently repairs are rejected like on the server.
  assert.equal(normalizeHttpBaseUrl("http:/api.example.com/v1"), null);
  assert.equal(normalizeHttpBaseUrl("https:api.example.com"), null);
  assert.equal(normalizeHttpBaseUrl("not a url"), null);
  assert.equal(normalizeHttpBaseUrl(""), null);
});

test("key is required again when only the endpoint path changes", () => {
  const view = httpView({ hasApiKey: true, host: "api.example.com" });
  const committed = normalizeHttpBaseUrl("https://api.example.com/v1");
  const errors = validateHttpDraft(
    draft({ baseUrl: "https://api.example.com/v2", apiKey: "" }),
    view,
    committed,
  );
  assert.ok(errors.some((e) => /엔드포인트가 변경되었습니다/.test(e)));
  // A trailing-slash spelling of the committed endpoint keeps the stored key.
  assert.deepEqual(
    validateHttpDraft(
      draft({ baseUrl: "https://api.example.com/v1/", apiKey: "" }),
      view,
      committed,
    ),
    [],
  );
  // A scheme change also counts as an endpoint change.
  assert.ok(
    validateHttpDraft(
      draft({ baseUrl: "http://api.example.com/v1", apiKey: "" }),
      view,
      committed,
    ).some((e) => /엔드포인트가 변경되었습니다/.test(e)),
  );
  // Without a known committed baseUrl the view only exposes the host, so a
  // path-only change falls back to host comparison here and is caught by
  // the server's full-baseUrl check on submit.
  assert.deepEqual(
    validateHttpDraft(
      draft({ baseUrl: "https://api.example.com/v2", apiKey: "" }),
      view,
    ),
    [],
  );
});

test("validateApiKeyText rejects whitespace, control characters, and oversized input", () => {
  assert.deepEqual(validateApiKeyText(""), []);
  assert.deepEqual(validateApiKeyText("fine-key"), []);
  assert.ok(
    validateApiKeyText("has space").some((e) => /공백이나 제어 문자/.test(e)),
  );
  assert.ok(validateApiKeyText("a".repeat(8193)).some((e) => /8KiB/.test(e)));
});

test("key is still required when a stored config has no key", () => {
  const view = httpView({ hasApiKey: false });
  assert.ok(
    validateHttpDraft(draft({ apiKey: "" }), view).some((e) =>
      /API 키를 입력하세요/.test(e),
    ),
  );
});

test("key rejects whitespace, control characters, and oversized input", () => {
  for (const apiKey of ["has space", "tab\tkey", "line\nkey", "nul\u0000key"]) {
    const errors = validateHttpDraft(draft({ apiKey }), null);
    assert.ok(
      errors.some((e) => /공백이나 제어 문자/.test(e)),
      `expected rejection for ${JSON.stringify(apiKey)}`,
    );
  }
  assert.ok(
    validateHttpDraft(draft({ apiKey: "a".repeat(8193) }), null).some((e) =>
      /8KiB/.test(e),
    ),
  );
  assert.ok(
    validateHttpDraft(draft({ apiKey: "가".repeat(3000) }), null).some((e) =>
      /8KiB/.test(e),
    ),
  );
  assert.equal(
    validateHttpDraft(draft({ apiKey: "a".repeat(8192) }), null).length,
    0,
  );
});
