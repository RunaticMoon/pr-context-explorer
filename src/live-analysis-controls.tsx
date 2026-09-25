import React from "react";
import type { EngineBlocker } from "./commit-review";
import type { EngineSetupEntry } from "./server/engine-setup";
import type { ProviderId } from "./server/ai/events";

// CONTRACT (conductor-owned): implement body only; keep the exported names and prop shapes.
export type TransmissionPlan = {
  snapshotId: string;
  plannedChunks: number;
  maxProviderCalls: number;
  auditCalls: number;
  serializedChunkBytes: number;
  scope: unknown;
  note: string;
};
export type LiveAnalysisControlsProps = {
  providerId: ProviderId;
  onProviderChange: (id: ProviderId) => void;
  /** Entry for providerId from the single existing EngineSetupPanel status (undefined = not yet known). */
  engine?: EngineSetupEntry;
  blockers: EngineBlocker[];
  model: string;
  onModelChange: (value: string) => void;
  consent: boolean;
  onConsentChange: (value: boolean) => void;
  audit: boolean;
  onAuditChange: (value: boolean) => void;
  historical: boolean;
  onHistoricalChange: (value: boolean) => void;
  freshRun: boolean;
  onFreshRunChange: (value: boolean) => void;
  /** Empty = run enabled. */
  runDisabledReasons: string[];
  onRun: () => void;
  /** undefined when no snapshot is open. */
  onPlan?: () => void;
  plan?: TransmissionPlan;
  onOpenEngineSettings: () => void;
  /** Existing job progress/cancel section rendered by the parent, shown inside this area. */
  jobStatus?: React.ReactNode;
};
export function LiveAnalysisControls(
  props: LiveAnalysisControlsProps,
): React.ReactElement {
  const {
    providerId,
    onProviderChange,
    engine,
    blockers,
    model,
    onModelChange,
    consent,
    onConsentChange,
    audit,
    onAuditChange,
    historical,
    onHistoricalChange,
    freshRun,
    onFreshRunChange,
    runDisabledReasons,
    onRun,
    onPlan,
    plan,
    onOpenEngineSettings,
    jobStatus,
  } = props;
  const engineName = providerId === "codex" ? "Codex CLI" : "Claude Code CLI";
  return (
    <section className="live-analysis-controls" aria-label="로컬 CLI 분석">
      <h3>로컬 CLI 분석 · 커밋 요약과 Guided Flow 생성</h3>
      <div className="live-analysis-controls-grid">
        <label>
          분석 엔진
          <select
            aria-label="분석 엔진"
            value={providerId}
            onChange={(e) => onProviderChange(e.target.value as ProviderId)}
          >
            <option value="codex">Codex CLI</option>
            <option value="claude">Claude Code CLI</option>
          </select>
        </label>
        <p className="live-analysis-controls-engine-state">
          {engine === undefined
            ? "엔진 상태를 아직 확인하지 못했습니다(확인 중이거나 검색 실패) · 엔진 설정에서 다시 검색 · 인증 실패로 단정하지 않음"
            : `${engineName} · ${engine.installed ? "설치됨" : "설치 안 됨"}` +
              ` · CLI ${engine.cliVersion ?? "버전 미확인"} · ` +
              (engine.ready ? "분석 준비됨" : "준비 안 됨")}
        </p>
        {blockers.length > 0 && (
          <ul
            className="live-analysis-controls-blockers live-analysis-controls-span"
            aria-label="엔진 준비 차단 이유"
          >
            {blockers.map((b) => (
              <li key={b.code} data-code={b.code}>
                {b.text}
              </li>
            ))}
          </ul>
        )}
        <button
          className="live-analysis-controls-span"
          onClick={onOpenEngineSettings}
        >
          분석 엔진 설정
        </button>
        <div>
          <label>
            분석 모델 ID (필수)
            <input
              value={model}
              onChange={(e) => onModelChange(e.target.value)}
              placeholder="설치 CLI에서 지원하는 정확한 모델 ID"
              aria-describedby="live-model-help"
            />
          </label>
          <small id="live-model-help" className="muted">
            모델 ID는 제공자별로 다를 수 있습니다 · 제공자를 바꾸면 전송 동의가
            초기화됩니다
          </small>
        </div>
        <label>
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => onConsentChange(e.target.checked)}
          />{" "}
          선택 범위의 PR/코드/Jira를 선택 모델 제공자에게 전송하는 데
          동의합니다. (현재 제공자: {engineName})
        </label>
        <label>
          <input
            type="checkbox"
            checked={audit}
            onChange={(e) => onAuditChange(e.target.checked)}
          />
          선택한 동일 엔진·모델의 의미 감사 추가 전송/과금 최대 1회에 동의합니다
          (선택)
        </label>
        <label>
          <input
            type="checkbox"
            checked={historical}
            onChange={(e) => onHistoricalChange(e.target.checked)}
          />
          투어의 명시적인 과거 revision 예외 허용 (기본 head 고정)
        </label>
        <label>
          <input
            type="checkbox"
            checked={freshRun}
            onChange={(e) => onFreshRunChange(e.target.checked)}
          />
          검증 캐시를 건너뛰고 새 실행 (추가 과금 가능)
        </label>
      </div>
      <p>
        PR: 변경/직접 import/원문을 최대 48개 분할 → 통합 1회 → 고정 head 투어
        1회. 선택 코드: 해당 SHA/side/라인과 원문 문맥의 분할 → 통합. 실행당 총
        최대 52회 호출, 15분. 실제 가격/토큰은 제공자 과금이며 캐시 적중으로
        호출이 줄 수 있습니다.
      </p>
      {onPlan && (
        <button onClick={onPlan}>PR 전송 계획 확인 · 모델 호출 없음</button>
      )}
      {plan && (
        <section data-testid="live-transmission-plan">
          <p>
            분할 {plan.plannedChunks} · 제공자 호출 상한 {plan.maxProviderCalls}{" "}
            · 추가 감사 {plan.auditCalls} · 분할 JSON UTF-8{" "}
            {plan.serializedChunkBytes} bytes
          </p>
          <pre>{JSON.stringify(plan.scope)}</pre>
          <p>{plan.note}</p>
        </section>
      )}
      <button
        className="primary"
        disabled={runDisabledReasons.length > 0}
        aria-describedby={
          runDisabledReasons.length > 0
            ? "live-run-disabled-reasons"
            : undefined
        }
        onClick={onRun}
      >
        PR 맥락 분석 실행
      </button>
      {runDisabledReasons.length > 0 && (
        <ul
          id="live-run-disabled-reasons"
          className="live-analysis-controls-blockers"
          aria-label="실행할 수 없는 이유"
        >
          {runDisabledReasons.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
      )}
      {jobStatus}
      <p className="muted">
        로컬 CLI는 오프라인 추론이 아닙니다. GitHub/Jira 토큰은 전달하지
        않습니다. 격리·인증·기능이 없으면 실행은 차단됩니다. 화면 이동은 모델을
        실행하지 않습니다.
      </p>
    </section>
  );
}
