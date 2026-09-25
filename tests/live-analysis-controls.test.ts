import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LiveAnalysisControls,
  type LiveAnalysisControlsProps,
} from "../src/live-analysis-controls.tsx";
import type { EngineSetupEntry } from "../src/server/engine-setup.ts";

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
