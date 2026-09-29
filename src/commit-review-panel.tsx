import React from "react";
import type { CommitReview, PhaseSummary } from "./commit-review";
import type { EvidenceButtons } from "./live-grounded";
import { Grounded } from "./live-grounded";

// CONTRACT (conductor-owned): implement body only; keep the exported names and prop shapes.
export type ReviewStep = { id: string; revisionSha: string; title: string };
export type CommitReviewPanelProps = {
  review: CommitReview<ReviewStep>;
  /** null = baseline (comparison base, no change stats). */
  position: { index: number; total: number } | null;
  /** Whether a PR analysis result exists, and which schema. */
  analysis: "none" | "v2" | "v3";
  buttons: EvidenceButtons;
  /** 요약·변화 묶음 안의 파일 링크용 */
  onChooseFile: (fileId: string) => void;
  onChooseStep: (stepId: string) => void;
  /** First step of the fixed head tour when this commit is not head and has no own steps. */
  headTour: { sha: string; stepId: string } | null;
  /** True while viewing a non-first-parent comparison; first-parent statuses must not be presented as that comparison. */
  alternateComparison: boolean;
  /** Currently selected comparison base (first parent or an added parent). */
  comparisonSha: string | null;
  /** AI summary written against `comparisonSha`; may differ from `review.summary`, which is always the first-parent summary. */
  comparisonSummary?: PhaseSummary;
  /** 전체 SHA·부모·비교 정책·선택 근거 위치 등(비교 정보 disclosure 안에 렌더). */
  provenance?: React.ReactNode;
  /** Git 원문 메시지 블록(커밋 상세 disclosure 안에 렌더). */
  gitMessage?: React.ReactNode;
};
export function CommitReviewPanel({
  review,
  position,
  analysis,
  buttons,
  onChooseFile,
  onChooseStep,
  headTour,
  alternateComparison,
  comparisonSha,
  comparisonSummary,
  provenance,
  gitMessage,
}: CommitReviewPanelProps): React.ReactElement {
  const fileById = new Map(review.files.map((f) => [f.id, f]));
  // Only the selected comparison's summary may be presented as this commit's
  // review; the first-parent summary is folded away in its own details below.
  const activeSummary = alternateComparison
    ? comparisonSummary
    : review.summary;
  const missingNotice = alternateComparison
    ? "이 비교 기준의 AI 요약 없음"
    : "이 커밋의 AI 요약 없음 · Git 원문만 표시";
  const summaryBody = (summary: PhaseSummary) => (
    <>
      <Grounded value={summary.title} buttons={buttons} />
      <div className="commit-review-panel-summary-grid">
        <Grounded
          label="변경 전"
          value={summary.before}
          buttons={buttons}
        />
        <Grounded
          label="변경 내용"
          value={summary.changes}
          buttons={buttons}
        />
        <Grounded label="이유" value={summary.why} buttons={buttons} />
      </div>
      <Grounded
        label="한계"
        value={summary.limitationsOfPhase}
        buttons={buttons}
      />
      {(summary.focusFileIds.length > 0 ||
        summary.focusGraphEdgeIds.length > 0 ||
        summary.focusHunkIds.length > 0) && (
        <p className="commit-review-panel-muted">
          강조 파일{" "}
          {summary.focusFileIds.length
            ? summary.focusFileIds.map((id, i) => {
                const file = fileById.get(id);
                return (
                  <React.Fragment key={id}>
                    {i > 0 && ", "}
                    {file ? (
                      <button
                        type="button"
                        onClick={() => onChooseFile(id)}
                      >
                        {file.pathLabel}
                      </button>
                    ) : (
                      <code title="첫 부모 기준 변경 파일 목록에 없음">
                        {id}
                      </code>
                    )}
                  </React.Fragment>
                );
              })
            : "없음"}
          {" · edge "}
          {summary.focusGraphEdgeIds.join(", ") || "없음"}
          {" · hunk "}
          {summary.focusHunkIds.join(", ") || "없음"}
        </p>
      )}
    </>
  );
  return (
    <section
      className="commit-review-panel"
      data-testid="commit-review"
      aria-label="선택 커밋 리뷰"
    >
      <div className="commit-review-panel-header">
        <div className="commit-review-panel-headline">
          <p className="commit-review-panel-position">
            {position
              ? `커밋 ${position.index} / ${position.total}`
              : "Baseline · 비교 기준"}
          </p>
          <h3 className="commit-review-panel-subject">{review.subject}</h3>
          <code className="commit-review-panel-sha">
            {review.sha.slice(0, 12)}
          </code>
          {position !== null && (
            <span className="commit-review-panel-stats">
              파일 {review.files.length} · hunk {review.hunkCount}
            </span>
          )}
          {analysis !== "none" && review.steps.length > 0 && (
            <span className="commit-review-panel-stats">
              투어 {review.readCount}/{review.steps.length}
            </span>
          )}
        </div>
        <div
          className="commit-review-panel-summary-line"
          title={activeSummary ? activeSummary.title.text : undefined}
        >
          {activeSummary ? (
            <Grounded value={activeSummary.title} buttons={buttons} />
          ) : (
            <p className="commit-review-panel-muted">
              {analysis === "none"
                ? "분석 미실행 · Git 원문만 표시"
                : missingNotice}
            </p>
          )}
        </div>
        {alternateComparison && review.summary && !comparisonSummary && (
          <details className="commit-review-panel-first-parent">
            <summary>
              첫 부모 기준 요약{" "}
              {review.comparisonFromSha && (
                <code>{review.comparisonFromSha.slice(0, 12)}</code>
              )}
            </summary>
            {summaryBody(review.summary)}
          </details>
        )}
        {alternateComparison && (
          <p className="commit-review-panel-warning" role="status">
            추가 부모 비교 중 · 아래 파일 상태는 첫 부모 기준입니다
          </p>
        )}
        {review.comparisonPartial && (
          <p className="commit-review-panel-warning" role="status">
            부분 diff · 일부 변경만 캡처되었을 수 있습니다
          </p>
        )}
      </div>
      <details className="commit-review-panel-details">
        <summary>커밋 상세</summary>
        {activeSummary && summaryBody(activeSummary)}
        {review.groups.length > 0 && (
          <div className="commit-review-panel-groups">
            <h4>변화 묶음</h4>
            {review.groups.map(({ group, fileIds, shared }) => (
              <article key={group.id} className="commit-review-panel-group">
                {shared && (
                  <span className="commit-review-panel-badge">
                    여러 커밋에 걸친 묶음
                  </span>
                )}
                <Grounded
                  label="변화 묶음"
                  value={group.title}
                  buttons={buttons}
                />
                <Grounded
                  label="변경 목적"
                  value={group.purpose}
                  buttons={buttons}
                />
                {buttons(group.evidenceIds)}
                <p className="commit-review-panel-group-files">
                  {fileIds.map((id) => {
                    const file = fileById.get(id);
                    return file ? (
                      <button
                        key={id}
                        type="button"
                        onClick={() => onChooseFile(id)}
                      >
                        {file.pathLabel}
                      </button>
                    ) : null;
                  })}
                </p>
              </article>
            ))}
          </div>
        )}
        {gitMessage}
        {analysis !== "none" && (
          <div className="commit-review-panel-steps">
            <h4>투어 단계</h4>
            {review.steps.length > 0 ? (
              <ul className="commit-review-panel-step-list">
                {review.steps.map((step) => (
                  <li key={step.id}>
                    <button
                      type="button"
                      onClick={() => onChooseStep(step.id)}
                    >
                      {step.title}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <>
                <p className="commit-review-panel-muted">
                  이 revision의 투어 단계 없음
                </p>
                {headTour && (
                  <button
                    type="button"
                    onClick={() => onChooseStep(headTour.stepId)}
                  >
                    고정 head 투어 열기 · {headTour.sha.slice(0, 8)}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </details>
      <details className="commit-review-panel-provenance">
        <summary>비교 정보</summary>
        <p className="commit-review-panel-shas">
          <code>{review.sha.slice(0, 12)}</code>
          {" · 비교 기준 "}
          {alternateComparison ? (
            <>
              {comparisonSha ? (
                <code>{comparisonSha.slice(0, 12)}</code>
              ) : (
                "root"
              )}
              {" · 파일 상태는 첫 부모 "}
              {review.comparisonFromSha ? (
                <code>{review.comparisonFromSha.slice(0, 12)}</code>
              ) : (
                "root"
              )}
              {" 기준"}
            </>
          ) : review.comparisonFromSha ? (
            <code>{review.comparisonFromSha.slice(0, 12)}</code>
          ) : (
            "root"
          )}
        </p>
        {provenance}
      </details>
    </section>
  );
}
