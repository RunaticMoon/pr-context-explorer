import React from "react";
import type { CommitReview } from "./commit-review";
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
  readIds: string[];
  buttons: EvidenceButtons;
  onChooseFile: (fileId: string) => void;
  onChooseStep: (stepId: string) => void;
  /** First step of the fixed head tour when this commit is not head and has no own steps. */
  headTour: { sha: string; stepId: string } | null;
  /** True while viewing a non-first-parent comparison; first-parent statuses must not be presented as that comparison. */
  alternateComparison: boolean;
};
export function CommitReviewPanel({
  review,
  position,
  analysis,
  readIds,
  buttons,
  onChooseFile,
  onChooseStep,
  headTour,
  alternateComparison,
}: CommitReviewPanelProps): React.ReactElement {
  const read = new Set(readIds);
  const fileById = new Map(review.files.map((f) => [f.id, f]));
  return (
    <section
      className="commit-review-panel"
      data-testid="commit-review"
      aria-label="선택 커밋 리뷰"
    >
      <div className="commit-review-panel-header">
        <p className="commit-review-panel-position">
          {position
            ? `커밋 ${position.index} / ${position.total}`
            : "Baseline · 비교 기준"}
        </p>
        <h3 className="commit-review-panel-subject">{review.subject}</h3>
        <p className="commit-review-panel-shas">
          <code>{review.sha.slice(0, 12)}</code>
          {" · 비교 기준 "}
          {review.comparisonFromSha ? (
            <code>{review.comparisonFromSha.slice(0, 12)}</code>
          ) : (
            "root"
          )}
        </p>
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
      <div className="commit-review-panel-summary">
        <h4>AI 요약</h4>
        {review.summary ? (
          <>
            <Grounded value={review.summary.title} buttons={buttons} />
            <div className="commit-review-panel-summary-grid">
              <Grounded
                label="변경 전"
                value={review.summary.before}
                buttons={buttons}
              />
              <Grounded
                label="변경 내용"
                value={review.summary.changes}
                buttons={buttons}
              />
              <Grounded
                label="이유"
                value={review.summary.why}
                buttons={buttons}
              />
            </div>
            <Grounded
              label="한계"
              value={review.summary.limitationsOfPhase}
              buttons={buttons}
            />
          </>
        ) : (
          <p className="commit-review-panel-muted">
            {analysis === "none"
              ? "분석 미실행 · Git 원문만 표시"
              : "이 커밋의 AI 요약 없음 · Git 원문만 표시"}
          </p>
        )}
      </div>
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
      <div className="commit-review-panel-files">
        {position === null ? (
          <p className="commit-review-panel-muted">
            비교 기준 · 변경 통계 없음
          </p>
        ) : (
          <>
            <h4>
              변경 파일 {review.files.length} · hunk {review.hunkCount}
            </h4>
            {review.files.length === 0 ? (
              <p className="commit-review-panel-muted">
                첫 부모 대비 변경 파일 없음
              </p>
            ) : (
              <ul className="commit-review-panel-file-list">
                {review.files.map((file) => (
                  <li key={file.id}>
                    <button
                      type="button"
                      className="commit-review-panel-file"
                      onClick={() => onChooseFile(file.id)}
                    >
                      <span className="commit-review-panel-path">
                        {file.pathLabel}
                      </span>
                      <span
                        className={`commit-review-panel-status commit-review-panel-status-${file.status}`}
                      >
                        {file.status}
                      </span>
                      {file.notes.length > 0 && (
                        <small className="commit-review-panel-notes">
                          {file.notes.join(" · ")}
                        </small>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      {analysis !== "none" && (
        <div className="commit-review-panel-steps">
          <h4>투어 단계</h4>
          {review.steps.length > 0 ? (
            <>
              <p>
                이 커밋의 투어 단계 {review.readCount}/{review.steps.length}{" "}
                읽음
              </p>
              <ul className="commit-review-panel-step-list">
                {review.steps.map((step) => (
                  <li key={step.id}>
                    <button
                      type="button"
                      onClick={() => onChooseStep(step.id)}
                    >
                      {step.title}
                      {read.has(step.id) ? " ✓" : ""}
                    </button>
                  </li>
                ))}
              </ul>
            </>
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
    </section>
  );
}
