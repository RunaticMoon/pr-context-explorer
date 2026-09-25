import type { EngineSetupStatus } from "./server/engine-setup.ts";
import type { ProviderId } from "./server/ai/events.ts";
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

/** Structured reasons why the selected local engine cannot run analysis. All
 * applicable blockers are returned at once; an unknown status is never
 * reported as an authentication failure. */
export function engineBlockers(
  status: EngineSetupStatus | undefined,
  providerId: ProviderId,
): EngineBlocker[] {
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

/** Why the explicit PR analysis run button stays disabled. */
export function runBlockers(input: {
  busy: boolean;
  model: string;
  consent: boolean;
  engineReady: boolean;
}): string[] {
  const out: string[] = [];
  if (input.busy) out.push("다른 작업이 진행 중입니다");
  if (!input.model.trim()) out.push("모델 ID를 입력하세요 (필수)");
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
