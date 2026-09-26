import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LiveAnalysisControls,
  type LiveAnalysisControlsProps,
} from "../src/live-analysis-controls.tsx";
import type { EngineSetupEntry } from "../src/server/engine-setup.ts";
import type { HttpEngineView } from "../src/ai-contract.ts";

function baseProps(overrides: Partial<LiveAnalysisControlsProps> = {}) {
  let calls = 0;
  const bump = () => {
    calls++;
  };
  const props: LiveAnalysisControlsProps = {
    providerId: "codex",
    onProviderChange: bump,
    engine: undefined,
    blockers: [],
    model: "",
    onModelChange: bump,
    consent: false,
    onConsentChange: bump,
    audit: false,
    onAuditChange: bump,
    historical: false,
    onHistoricalChange: bump,
    freshRun: false,
    onFreshRunChange: bump,
    runDisabledReasons: [],
    onRun: bump,
    onOpenEngineSettings: bump,
    ...overrides,
  };
  return { props, calls: () => calls };
}

function readyEngine(): EngineSetupEntry {
  return {
    providerId: "codex",
    installed: true,
    cliVersion: "FAKE-setup-not-inference",
    candidateId: "FAKE-candidate",
    localAuth: "advanced",
    capabilities: { supported: true, missing: [] } as any,
    authentication: {
      status: "authenticated",
      method: null,
      checkedBy: "not-checked",
      networkValidated: false,
    },
    isolation: {
      available: true,
      runtimeVerified: true,
      platform: "FAKE",
      blocker: null,
    } as any,
    blockers: [],
    ready: true,
    inferenceVerified: false,
  };
}

test("renders always-visible controls and invokes no callbacks on render", () => {
  const { props, calls } = baseProps();
  const html = renderToStaticMarkup(
    React.createElement(LiveAnalysisControls, props),
  );
  assert.equal(calls(), 0);
  assert.match(html, /aria-label="로컬 CLI 분석"/);
  assert.match(html, /로컬 CLI 분석 · 커밋 요약과 Guided Flow 생성/);
  assert.match(html, /aria-label="분석 엔진"/);
  assert.match(html, /Codex CLI/);
  assert.match(html, /Claude Code CLI/);
  assert.match(html, /분석 엔진 설정/);
  assert.match(html, /분석 모델 ID \(필수\)/);
  assert.match(html, /PR 맥락 분석 실행/);
});

test("unknown engine status is never asserted as an auth failure", () => {
  const { props } = baseProps({ engine: undefined });
  const html = renderToStaticMarkup(
    React.createElement(LiveAnalysisControls, props),
  );
  assert.match(
    html,
    /엔진 상태를 아직 확인하지 못했습니다\(확인 중이거나 검색 실패\)/,
  );
  assert.match(html, /엔진 설정에서 다시 검색/);
  assert.match(html, /인증 실패로 단정하지 않음/);
});

test("ready engine shows install, version, and readiness", () => {
  const { props } = baseProps({ engine: readyEngine() });
  const html = renderToStaticMarkup(
    React.createElement(LiveAnalysisControls, props),
  );
  assert.match(html, /설치됨/);
  assert.match(html, /FAKE-setup-not-inference/);
  assert.match(html, /분석 준비됨/);
});

test("all engine blockers are listed with their codes", () => {
  const { props } = baseProps({
    blockers: [
      { code: "not-installed", text: "지원하는 로컬 CLI 설치를 찾지 못했습니다." },
      { code: "isolation", text: "격리 실행이 불가능합니다" },
      { code: "auth-not_configured", text: "인증이 설정되지 않았습니다." },
    ],
  });
  const html = renderToStaticMarkup(
    React.createElement(LiveAnalysisControls, props),
  );
  assert.match(html, /aria-label="엔진 준비 차단 이유"/);
  assert.match(html, /data-code="not-installed"/);
  assert.match(html, /data-code="isolation"/);
  assert.match(html, /data-code="auth-not_configured"/);
  assert.match(html, /지원하는 로컬 CLI 설치를 찾지 못했습니다/);
  assert.match(html, /격리 실행이 불가능합니다/);
  assert.match(html, /인증이 설정되지 않았습니다/);
});

test("run button is disabled and every reason is listed", () => {
  const { props } = baseProps({
    runDisabledReasons: ["모델 ID를 입력하세요.", "전송 동의가 필요합니다."],
  });
  const html = renderToStaticMarkup(
    React.createElement(LiveAnalysisControls, props),
  );
  assert.match(html, /<button[^>]*disabled[^>]*>PR 맥락 분석 실행<\/button>/);
  assert.match(html, /aria-label="실행할 수 없는 이유"/);
  assert.match(html, /모델 ID를 입력하세요\./);
  assert.match(html, /전송 동의가 필요합니다\./);
});

test("disabled run button points at the reasons list via aria-describedby", () => {
  const { props } = baseProps({
    runDisabledReasons: ["모델 ID를 입력하세요."],
  });
  const html = renderToStaticMarkup(
    React.createElement(LiveAnalysisControls, props),
  );
  assert.match(
    html,
    /<button[^>]*aria-describedby="live-run-disabled-reasons"[^>]*>/,
  );
  assert.match(html, /<ul id="live-run-disabled-reasons"/);
});

test("run button is enabled when no disabled reasons", () => {
  const { props } = baseProps({ runDisabledReasons: [] });
  const html = renderToStaticMarkup(
    React.createElement(LiveAnalysisControls, props),
  );
  const runButton = html.match(
    /<button[^>]*>PR 맥락 분석 실행<\/button>/,
  )![0];
  assert.doesNotMatch(runButton, /disabled|aria-describedby/);
  assert.doesNotMatch(html, /실행할 수 없는 이유|live-run-disabled-reasons/);
});

test("consent label names the currently selected provider", () => {
  for (const [providerId, name] of [
    ["codex", "Codex CLI"],
    ["claude", "Claude Code CLI"],
  ] as const) {
    const { props } = baseProps({ providerId });
    const html = renderToStaticMarkup(
      React.createElement(LiveAnalysisControls, props),
    );
    assert.match(
      html,
      new RegExp(`동의합니다\\.\\s*\\(현재 제공자: ${name}\\)`),
    );
    assert.match(html, /선택 범위의 PR\/코드\/Jira를 선택 모델 제공자에게/);
  }
});

test("model label never collides with the settings input label", () => {
  const { props } = baseProps();
  const html = renderToStaticMarkup(
    React.createElement(LiveAnalysisControls, props),
  );
  assert.doesNotMatch(html, /모델 식별자/);
});

test("model help text is linked via aria-describedby, not inside the label", () => {
  const { props } = baseProps();
  const html = renderToStaticMarkup(
    React.createElement(LiveAnalysisControls, props),
  );
  assert.match(
    html,
    /<label>분석 모델 ID \(필수\)<input[^>]*aria-describedby="live-model-help"[^>]*\/><\/label>/,
  );
  assert.match(
    html,
    /<small id="live-model-help" class="muted">모델 ID는 제공자별로 다를 수 있습니다/,
  );
  const labelHtml = html.match(
    /<label>분석 모델 ID \(필수\)[\s\S]*?<\/label>/,
  )![0];
  assert.doesNotMatch(labelHtml, /제공자를 바꾸면/);
});

test("plan section renders when plan and onPlan are provided", () => {
  const { props } = baseProps({
    onPlan: () => {},
    plan: {
      snapshotId: "snap-1",
      plannedChunks: 3,
      maxProviderCalls: 52,
      auditCalls: 1,
      serializedChunkBytes: 4096,
      scope: { kind: "pr" },
      note: "계획만 확인, 모델 호출 없음",
    },
  });
  const html = renderToStaticMarkup(
    React.createElement(LiveAnalysisControls, props),
  );
  assert.match(html, /PR 전송 계획 확인 · 모델 호출 없음/);
  assert.match(html, /data-testid="live-transmission-plan"/);
  assert.match(html, /분할 3/);
  assert.match(html, /제공자 호출 상한 52/);
  assert.match(html, /4096 bytes/);
  assert.match(html, /&quot;kind&quot;:&quot;pr&quot;|\{"kind":"pr"\}/);
  assert.match(html, /계획만 확인, 모델 호출 없음/);
});

test("no plan button when onPlan is absent", () => {
  const { props } = baseProps();
  const html = renderToStaticMarkup(
    React.createElement(LiveAnalysisControls, props),
  );
  assert.doesNotMatch(html, /PR 전송 계획 확인/);
});

function fakeHttpView(overrides: Partial<HttpEngineView> = {}): HttpEngineView {
  return {
    providerId: "openai-compatible",
    transport: "http",
    configId: "cfg-FAKE-public",
    revision: 3,
    host: "llm.example.test:8443",
    model: "fake-http-model",
    hasApiKey: true,
    verification: "verified",
    blockers: [],
    ready: true,
    ...overrides,
  };
}

test("engine select offers the OpenAI-compatible option for every provider", () => {
  for (const providerId of [
    "codex",
    "claude",
    "openai-compatible",
  ] as const) {
    const { props } = baseProps({ providerId, httpView: fakeHttpView() });
    const html = renderToStaticMarkup(
      React.createElement(LiveAnalysisControls, props),
    );
    assert.match(
      html,
      /<option value="openai-compatible"[^>]*>OpenAI 호환 API<\/option>/,
    );
  }
});

test("HTTP engine shows read-only model, host, and call-cap consent", () => {
  const { props } = baseProps({
    providerId: "openai-compatible",
    httpView: fakeHttpView(),
    plan: {
      snapshotId: "snap-1",
      plannedChunks: 2,
      maxProviderCalls: 12,
      auditCalls: 0,
      serializedChunkBytes: 2048,
      logicalSteps: 4,
      maxOutputTokensPerCall: 8192,
      totalOutputTokenReservation: 98304,
      inputByteLimit: 65536,
      scope: { kind: "pr" },
      note: "계획만 확인, 모델 호출 없음",
    },
  });
  const html = renderToStaticMarkup(
    React.createElement(LiveAnalysisControls, props),
  );
  // Saved config replaces the editable model input.
  assert.doesNotMatch(html, /분석 모델 ID \(필수\)/);
  assert.match(html, /data-testid="live-http-model"[^>]*>fake-http-model</);
  assert.match(html, /모델은 엔진 설정에서 변경합니다/);
  // Engine state names the saved host/model, key flag, verification, readiness.
  assert.match(html, /OpenAI 호환 API · llm\.example\.test:8443/);
  assert.match(html, /API 키 등록됨/);
  assert.match(html, /연결 확인됨/);
  assert.match(html, /분석 준비됨/);
  // Consent text pins the destination and the planned call cap.
  assert.match(
    html,
    /선택한 PR·코드·Jira 문맥을 <strong>llm\.example\.test:8443 \/ fake-http-model<\/strong>에 전송합니다\./,
  );
  assert.match(
    html,
    /재시도와 응답 형식 변경을 포함해 최대 <strong>12회<\/strong> 호출하며 요금이 발생할 수 있습니다\./,
  );
  // Plan-derived limits are shown.
  assert.match(html, /data-testid="live-http-plan-limits"/);
  assert.match(html, /요청당 출력 토큰 상한 8192/);
  assert.match(html, /합산 출력 토큰 예약 98304/);
  assert.match(html, /요청 입력 크기 상한 65536 bytes/);
});

test("HTTP consent names the engine but no call cap before a plan exists", () => {
  const { props } = baseProps({
    providerId: "openai-compatible",
    httpView: fakeHttpView(),
  });
  const html = renderToStaticMarkup(
    React.createElement(LiveAnalysisControls, props),
  );
  assert.match(
    html,
    /<strong>llm\.example\.test:8443 \/ fake-http-model<\/strong>에 전송합니다\./,
  );
  assert.match(html, /재시도와 응답 형식 변경을 포함한 반복 호출로 요금이 발생할 수 있습니다\./);
  assert.doesNotMatch(html, /live-http-plan-limits/);
});

test("unconfigured HTTP engine points to the engine settings area", () => {
  const { props } = baseProps({
    providerId: "openai-compatible",
    httpView: null,
    blockers: [
      {
        code: "http-config-missing",
        text: "OpenAI 호환 API 설정이 필요합니다",
      },
    ],
  });
  const html = renderToStaticMarkup(
    React.createElement(LiveAnalysisControls, props),
  );
  assert.match(html, /OpenAI 호환 API 설정이 필요합니다/);
  assert.match(html, /분석 엔진 설정에서 base URL·모델·API 키를 등록하세요/);
  assert.match(html, /data-code="http-config-missing"/);
  // Read-only model slot stays but holds no model value.
  assert.match(html, /data-testid="live-http-model"[^>]*>엔진 설정에서 등록</);
});

test("a still-loading HTTP engine view shows a checking message, not missing config", () => {
  const { props } = baseProps({
    providerId: "openai-compatible",
    httpView: undefined,
    blockers: [
      {
        code: "http-view-loading",
        text: "OpenAI 호환 API 상태를 확인하는 중입니다",
      },
    ],
  });
  const html = renderToStaticMarkup(
    React.createElement(LiveAnalysisControls, props),
  );
  assert.match(html, /OpenAI 호환 API 상태를 확인하는 중입니다/);
  assert.match(html, /data-code="http-view-loading"/);
  assert.match(html, /data-testid="live-http-model"[^>]*>확인 중</);
  // The missing-config guidance never appears while the view is loading.
  assert.doesNotMatch(html, /base URL·모델·API 키를 등록하세요/);
});

test("HTTP engine blockers and unready state come from props", () => {
  const { props } = baseProps({
    providerId: "openai-compatible",
    httpView: fakeHttpView({
      hasApiKey: false,
      verification: "failed",
      ready: false,
    }),
    blockers: [
      { code: "http-api-key-missing", text: "API 키가 등록되지 않았습니다" },
      { code: "http-verify-failed", text: "연결 확인에 실패했습니다" },
    ],
  });
  const html = renderToStaticMarkup(
    React.createElement(LiveAnalysisControls, props),
  );
  assert.match(html, /API 키 미등록/);
  assert.match(html, /연결 실패/);
  assert.match(html, /준비 안 됨/);
  assert.match(html, /data-code="http-api-key-missing"/);
  assert.match(html, /data-code="http-verify-failed"/);
  assert.match(html, /API 키가 등록되지 않았습니다/);
  assert.match(html, /연결 확인에 실패했습니다/);
});

test("CLI providers keep the editable model input and CLI consent text", () => {
  for (const providerId of ["codex", "claude"] as const) {
    const { props } = baseProps({ providerId });
    const html = renderToStaticMarkup(
      React.createElement(LiveAnalysisControls, props),
    );
    assert.match(html, /aria-label="로컬 CLI 분석"/);
    assert.match(html, /분석 모델 ID \(필수\)<input/);
    assert.match(html, /선택 범위의 PR\/코드\/Jira를 선택 모델 제공자에게/);
    assert.doesNotMatch(html, /live-http-model|live-http-plan-limits/);
    assert.doesNotMatch(html, /모델은 엔진 설정에서 변경합니다/);
  }
});

test("HTTP rendering never contains key fields or password inputs", () => {
  const { props } = baseProps({
    providerId: "openai-compatible",
    httpView: fakeHttpView(),
  });
  const html = renderToStaticMarkup(
    React.createElement(LiveAnalysisControls, props),
  );
  assert.doesNotMatch(html, /apiKey|api_key|hasApiKey/i);
  assert.doesNotMatch(html, /type="password"|비밀번호/);
});
