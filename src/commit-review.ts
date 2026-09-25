import type { EngineSetupStatus } from "./server/engine-setup.ts";
import type { AIErrorCode } from "./server/ai/errors.ts";
import type { HttpEngineView, ProviderId } from "./ai-contract.ts";
import type { V3Output } from "./server/analysis-v3/types.ts";

// Minimal structural shape shared by live phases and demo phases.
export type CommitPhase = {
  sha: string;
  subject: string;
  comparisonFromSha: string | null;
  hunks: unknown[];
  files: {
    id: string;
    path: string;
    status: string;
    oldPath: string | null;
    retrieved?: boolean;
    omission?: string;
  }[];
  parentComparisons?: { fromSha: string; toSha: string; partial: boolean }[];
};
export type StepRef = { id: string; revisionSha: string };

/** Phase summaries are pinned to the exact (commit, compared parent) pair so a
 * summary written against a different parent is never shown as this commit's
 * first-parent review. */
export function phaseSummaryFor(
  output: Pick<V3Output, "phaseSummaries"> | undefined,
  phase: { sha: string; comparisonFromSha: string | null },
) {
  return output?.phaseSummaries.find(
    (p) =>
      p.commitSha === phase.sha &&
      p.comparisonFromSha === (phase.comparisonFromSha ?? null),
  );
}

export type PhaseSummary = NonNullable<ReturnType<typeof phaseSummaryFor>>;

export type CommitFileChange = {
  id: string;
  status: string;
  /** Deleted files only exist on the old side of the comparison. */
  side: "old" | "new";
  /** Renames keep both real paths: old → new. */
  pathLabel: string;
  /** Retrieval/parse caveats that must stay visible (binary, caps, misses). */
  notes: string[];
};

/** Files whose status changed against the real first parent. `unchanged`
 * context files are excluded, but a changed file with zero parsed hunks is
 * still a change (mode-only diffs, truncated/partial diffs, binary). */
export function commitFileChanges(phase: CommitPhase): CommitFileChange[] {
  return phase.files
    .filter((f) => f.status !== "unchanged")
    .map((f) => {
      const notes: string[] = [];
      if (f.retrieved === false) notes.push("원문 미확보");
      if (f.omission) notes.push(f.omission);
      return {
        id: f.id,
        status: f.status,
        side: f.status === "deleted" ? "old" : "new",
        pathLabel:
          f.status === "renamed" && f.oldPath
            ? `${f.oldPath} → ${f.path}`
            : f.path,
        notes,
      };
    });
}

/** True when the actual first-parent diff was captured only partially. */
export function comparisonPartial(phase: CommitPhase): boolean {
  return (
    phase.parentComparisons?.find(
      (c) => c.fromSha === phase.comparisonFromSha && c.toSha === phase.sha,
    )?.partial === true
  );
}

/** Tour steps pinned to this revision (head-only tours only match head). */
export function stepsForRevision<T extends StepRef>(
  steps: T[] | undefined,
  sha: string,
): T[] {
  return (steps || []).filter((t) => t.revisionSha === sha);
}

/** Change groups that include this commit. `fileIds` are limited to files that
 * actually exist in this phase; `shared` marks groups spanning other commits. */
export function changeGroupsForPhase(
  output: Pick<V3Output, "changeGroups"> | undefined,
  phase: CommitPhase,
) {
  const ids = new Set(phase.files.map((f) => f.id));
  return (output?.changeGroups || [])
    .filter((g) => g.commitShas.includes(phase.sha))
    .map((group) => ({
      group,
      fileIds: group.fileIds.filter((id) => ids.has(id)),
      shared: group.commitShas.length > 1,
    }));
}

export function commitReview<S extends StepRef = StepRef>(
  phase: CommitPhase,
  options: {
    output?: Pick<V3Output, "phaseSummaries" | "changeGroups">;
    steps?: S[];
    readIds?: string[];
  } = {},
) {
  const steps = stepsForRevision(options.steps, phase.sha);
  return {
    sha: phase.sha,
    subject: phase.subject,
    comparisonFromSha: phase.comparisonFromSha ?? null,
    files: commitFileChanges(phase),
    hunkCount: phase.hunks.length,
    comparisonPartial: comparisonPartial(phase),
    summary: phaseSummaryFor(options.output, phase),
    steps,
    readCount: steps.filter((t) => options.readIds?.includes(t.id)).length,
    groups: changeGroupsForPhase(options.output, phase),
  };
}

export type CommitReview<S extends StepRef = StepRef> = ReturnType<
  typeof commitReview<S>
>;

export type EngineBlocker = { code: string; text: string };

/** Korean descriptions for the AIErrorCode values an HTTP transport can
 * surface through HttpEngineView.blockers. CLI-only codes are intentionally
 * absent; unknown codes are skipped rather than shown untranslated. */
const HTTP_BLOCKER_TEXT: Partial<Record<AIErrorCode, string>> = {
  cancelled: "작업이 취소되었습니다.",
  timeout: "제한 시간을 초과했습니다.",
  input_limit: "입력이 크기 제한을 초과했습니다.",
  output_limit: "응답이 크기 제한을 초과했습니다.",
  invalid_request: "요청 설정이 올바르지 않습니다.",
  auth_required: "인증 정보가 제공되지 않았습니다.",
  auth_invalid: "인증에 실패했거나 만료되었습니다.",
  quota_exceeded: "제공자 과금·쿼터 한도에 도달했습니다.",
  rate_limited: "제공자 요청 속도 제한에 도달했습니다.",
  model_unavailable: "선택한 모델을 사용할 수 없습니다.",
  provider_unavailable: "제공자에 연결할 수 없습니다.",
  provider_failed: "제공자가 요청을 실패 처리했습니다.",
  invalid_json: "제공자가 올바르지 않은 JSON을 반환했습니다.",
  invalid_envelope: "제공자 응답 형식이 올바르지 않습니다.",
  schema_invalid: "요청 스키마가 제공자에 의해 거부되었습니다.",
  schema_mismatch: "제공자 응답이 요청 스키마와 일치하지 않습니다.",
  tool_use_forbidden: "제공자가 허용되지 않은 도구 사용을 시도했습니다.",
  network_denied: "네트워크 정책이 요청을 거부했습니다.",
};

/** Structured form of httpEngineBlockers so engineBlockers can reuse the same
 * transport rules without losing codes. */
function httpEngineBlockerDetails(
  view: HttpEngineView | null,
): EngineBlocker[] {
  if (!view)
    return [
      {
        code: "http-config-missing",
        text: "OpenAI 호환 API 설정이 필요합니다",
      },
    ];
  if (view.ready) return [];
  const reasons: EngineBlocker[] = [];
  if (!view.hasApiKey)
    reasons.push({
      code: "http-api-key-missing",
      text: "API 키가 등록되지 않았습니다",
    });
  if (view.verification === "not_checked")
    reasons.push({ code: "http-verify-needed", text: "연결 확인이 필요합니다" });
  else if (view.verification === "checking")
    reasons.push({ code: "http-verify-checking", text: "연결 확인 중입니다" });
  else if (view.verification === "failed")
    reasons.push({
      code: "http-verify-failed",
      text: "연결 확인에 실패했습니다",
    });
  for (const code of view.blockers) {
    const text = HTTP_BLOCKER_TEXT[code];
    if (text) reasons.push({ code: `http-${code}`, text });
  }
  if (!reasons.length)
    reasons.push({
      code: "http-not-ready",
      text: "준비 조건을 충족하지 못했습니다. 엔진 설정에서 상세를 확인하세요.",
    });
  return reasons;
}

/** Korean reasons why the OpenAI-compatible HTTP engine cannot run analysis:
 * missing config, missing API key, verification pending/failed. CLI install,
 * isolation and local-auth blockers never apply to this transport. */
export function httpEngineBlockers(view: HttpEngineView | null): string[] {
  return httpEngineBlockerDetails(view).map((b) => b.text);
}

/** Structured reasons why the selected engine cannot run analysis. All
 * applicable blockers are returned at once; an unknown status is never
 * reported as an authentication failure. For the HTTP transport the caller
 * passes its HttpEngineView (null when unconfigured) and local CLI checks are
 * skipped entirely. */
export function engineBlockers(
  status: EngineSetupStatus | undefined,
  providerId: ProviderId,
  httpView?: HttpEngineView | null,
): EngineBlocker[] {
  if (providerId === "openai-compatible")
    return httpEngineBlockerDetails(httpView ?? null);
  if (!status)
    return [
      {
        code: "status-unknown",
        text: "엔진 상태를 아직 확인하지 못했습니다. 인증 실패로 단정하지 않습니다.",
      },
    ];
  const engine = status.engines.find((e) => e.providerId === providerId);
  if (!engine)
    return [
      {
        code: "engine-missing",
        text: "선택한 엔진이 검색 결과에 없습니다. 엔진 설정에서 다시 검색하세요.",
      },
    ];
  if (engine.ready) return [];
  const reasons: EngineBlocker[] = [];
  if (!engine.installed)
    reasons.push({
      code: "not-installed",
      text: "지원하는 로컬 CLI 설치를 찾지 못했습니다.",
    });
  else {
    if (!engine.capabilities.supported)
      reasons.push({
        code: "unsupported-version",
        text:
          "미검토 또는 지원되지 않는 CLI 버전입니다" +
          (engine.capabilities.missing.length
            ? ` (누락: ${engine.capabilities.missing.join(", ")})`
            : ""),
      });
    if (!engine.isolation.available || !engine.isolation.runtimeVerified)
      reasons.push({
        code: "isolation",
        text:
          "격리 실행이 불가능합니다" +
          (engine.isolation.blocker ? ` (${engine.isolation.blocker})` : ""),
      });
    const auth = engine.authentication.status;
    if (auth === "not_configured")
      if (engine.localAuth === "available")
        reasons.push({
          code: "auth-reuse-consent",
          text: "로컬 인증 파일 재사용 동의가 필요합니다.",
        });
      else if (engine.localAuth === "missing")
        reasons.push({
          code: "auth-file-missing",
          text: "로컬 인증 파일이 없습니다. CLI에서 로그인 후 다시 검색하세요.",
        });
      else if (engine.localAuth === "unsupported")
        reasons.push({
          code: "auth-manual",
          text: "수동 인증 설정(setup token 또는 고급 서버 인증)이 필요합니다.",
        });
      else
        reasons.push({
          code: "auth-not_configured",
          text: "인증이 설정되지 않았습니다.",
        });
    else if (auth === "not_authenticated")
      reasons.push({
        code: "auth-not_authenticated",
        text: "인증되지 않은 상태입니다.",
      });
    else if (auth !== "authenticated")
      reasons.push({
        code: "auth-" + auth,
        text: "인증 상태를 확인하지 못했습니다. 실패로 단정하지 않습니다.",
      });
  }
  if (!reasons.length)
    reasons.push({
      code: "other",
      text: "준비 조건을 충족하지 못했습니다. 엔진 설정에서 상세를 확인하세요.",
    });
  return reasons;
}

/** Same model-id rule the server enforces on /api/live/run
 * (src/server/live-api.ts). Duplicated here so this module stays importable
 * without server code. */
export const MODEL_ID_PATTERN = /^[-a-zA-Z0-9_.:/]{1,120}$/;

/** Why the explicit PR analysis run button stays disabled. For the HTTP
 * transport pass its HttpEngineView (null when unconfigured): the model then
 * comes from the saved config and no manual model input is required. */
export function runBlockers(input: {
  busy: boolean;
  model: string;
  consent: boolean;
  engineReady: boolean;
  httpView?: HttpEngineView | null;
}): string[] {
  const out: string[] = [];
  if (input.busy) out.push("다른 작업이 진행 중입니다");
  if (input.httpView === undefined) {
    if (!input.model.trim()) out.push("모델 ID를 입력하세요 (필수)");
    else if (!MODEL_ID_PATTERN.test(input.model))
      out.push(
        "모델 ID 형식이 올바르지 않습니다 (영문·숫자·-_.:/ 1–120자, 공백 불가)",
      );
  } else if (input.httpView && !MODEL_ID_PATTERN.test(input.httpView.model))
    out.push(
      "저장된 엔진 설정의 모델 ID 형식이 올바르지 않습니다. 엔진 설정에서 수정하세요",
    );
  if (!input.consent) out.push("제공자 전송 동의가 필요합니다");
  if (!input.engineReady) out.push("선택한 엔진이 아직 준비되지 않았습니다");
  return out;
}

/** Why the selected-range code question stays disabled. */
export function codeQuestionBlockers(input: {
  runBlockers: string[];
  fileSelected: boolean;
  rangeSelected: boolean;
  alternateComparison: boolean;
  hasContent: boolean;
}): string[] {
  const out = [...input.runBlockers];
  if (!input.fileSelected) out.push("파일을 먼저 선택하세요");
  if (input.fileSelected && !input.rangeSelected)
    out.push("라인 범위를 선택하세요");
  if (input.alternateComparison)
    out.push("추가 부모 비교 중 · 코드 Q&A는 첫 부모 비교만 지원합니다");
  if (input.fileSelected && !input.hasContent)
    out.push("선택 side에 내용이 없습니다");
  return out;
}
