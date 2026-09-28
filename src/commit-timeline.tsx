import React from "react";
import type { CommitFileChange } from "./commit-review";

// CONTRACT (conductor-owned): implement body only; keep the exported names and prop shapes.
export type TimelineCommit = {
  sha: string;
  /** Exact accessible name. Existing E2E depends on "Baseline (비교 기준)" and "Phase N". */
  label: string;
  subject?: string;
  baseline?: boolean;
  /** Omitted for the baseline card. steps/read are omitted when no analysis exists. */
  stats?: {
    changedFiles: number;
    hunks: number;
    partial?: boolean;
    steps?: number;
    read?: number;
  };
};
export type CommitTimelineProps = {
  commits: TimelineCommit[];
  selectedSha: string;
  onSelect: (sha: string) => void;
  /** 선택 커밋의 첫 부모 기준 변경 파일(읽기 순서). Baseline이면 []. */
  selectedFiles: CommitFileChange[];
  selectedFileId: string | null;
  onChooseFile: (fileId: string) => void;
  /** 선택 커밋 파일 목록 아래에 렌더링할 선택적 slot(문맥 파일 검색 등). */
  fileTools?: React.ReactNode;
};

/** Last path segment stays bold; the directory prefix is dimmed. */
function PathLabel({ label }: { label: string }): React.ReactElement {
  const split = label.lastIndexOf("/");
  if (split < 0) {
    return (
      <span className="commit-timeline-file-path">
        <b>{label}</b>
      </span>
    );
  }
  return (
    <span className="commit-timeline-file-path">
      <span className="commit-timeline-file-dir">
        {label.slice(0, split + 1)}
      </span>
      <b>{label.slice(split + 1)}</b>
    </span>
  );
}

export function CommitTimeline(props: CommitTimelineProps): React.ReactElement {
  const {
    commits,
    selectedSha,
    onSelect,
    selectedFiles,
    selectedFileId,
    onChooseFile,
    fileTools,
  } = props;
  const railRef = React.useRef<HTMLDivElement | null>(null);
  const selectedCommitRef = React.useRef<HTMLButtonElement | null>(null);
  const selectedFileRef = React.useRef<HTMLButtonElement | null>(null);
  const selectedIndex = commits.findIndex((c) => c.sha === selectedSha);
  const selected = selectedIndex >= 0 ? commits[selectedIndex] : undefined;
  const realCommits = commits.filter((c) => !c.baseline);
  const numberBySha = new Map<string, number>();
  realCommits.forEach((c, index) => numberBySha.set(c.sha, index + 1));
  const prev = selectedIndex > 0 ? commits[selectedIndex - 1] : undefined;
  const next =
    selectedIndex >= 0 && selectedIndex < commits.length - 1
      ? commits[selectedIndex + 1]
      : undefined;

  React.useEffect(() => {
    const rail = railRef.current;
    const target = selectedFileRef.current ?? selectedCommitRef.current;
    if (!rail || !target) return;
    const railRect = rail.getBoundingClientRect?.();
    const targetRect = target.getBoundingClientRect?.();
    if (!railRect || !targetRect) return;
    if (targetRect.top < railRect.top) {
      rail.scrollTop += targetRect.top - railRect.top;
    } else if (targetRect.bottom > railRect.bottom) {
      rail.scrollTop += targetRect.bottom - railRect.bottom;
    }
  }, [selectedSha, selectedFileId]);

  return (
    <nav className="commit-timeline" aria-label="커밋 흐름">
      <div className="commit-timeline-header">
        <span className="commit-timeline-title">커밋 흐름</span>
        <span className="commit-timeline-controls">
          <button
            type="button"
            disabled={!prev}
            onClick={() => prev && onSelect(prev.sha)}
          >
            이전 커밋
          </button>
          <button
            type="button"
            disabled={!next}
            onClick={() => next && onSelect(next.sha)}
          >
            다음 커밋
          </button>
        </span>
      </div>
      <div className="commit-timeline-rail" ref={railRef}>
        <ol className="commit-timeline-list">
          {commits.map((commit) => {
            const isSelected = commit.sha === selectedSha;
            const stats = commit.baseline ? undefined : commit.stats;
            const statsText = stats
              ? `파일 ${stats.changedFiles} · hunk ${stats.hunks}` +
                (stats.partial ? " · 부분 diff" : "") +
                (stats.steps ? ` · 투어 ${stats.read ?? 0}/${stats.steps}` : "")
              : undefined;
            const statsId = `commit-timeline-stats-${commit.sha}`;
            const badge = commit.baseline
              ? "B"
              : String(numberBySha.get(commit.sha) ?? "");
            return (
              <li
                key={commit.sha}
                className={
                  "commit-timeline-item" +
                  (isSelected ? " commit-timeline-item-selected" : "")
                }
              >
                <button
                  type="button"
                  className="commit-timeline-commit"
                  aria-label={commit.label}
                  aria-pressed={isSelected}
                  aria-describedby={statsText ? statsId : undefined}
                  ref={isSelected ? selectedCommitRef : undefined}
                  onClick={() => onSelect(commit.sha)}
                >
                  <span className="commit-timeline-badge" aria-hidden="true">
                    {badge}
                  </span>
                  <span className="commit-timeline-commit-main">
                    {commit.subject ? (
                      <span
                        className="commit-timeline-subject"
                        title={commit.subject}
                      >
                        {commit.subject}
                      </span>
                    ) : null}
                    <code className="commit-timeline-sha">
                      {commit.sha.slice(0, 7)}
                    </code>
                    {statsText ? (
                      <span className="commit-timeline-stats" id={statsId}>
                        {statsText}
                      </span>
                    ) : null}
                  </span>
                </button>
                {isSelected ? (
                  <>
                    <ul className="commit-timeline-files">
                      {selectedFiles.map((file) => {
                        const active = file.id === selectedFileId;
                        return (
                          <li key={file.id}>
                            <button
                              type="button"
                              className="commit-timeline-file"
                              aria-current={active ? "true" : undefined}
                              ref={active ? selectedFileRef : undefined}
                              onClick={() => onChooseFile(file.id)}
                            >
                              <span
                                className={
                                  "commit-timeline-file-status" +
                                  ` commit-timeline-file-status-${file.status}`
                                }
                              >
                                {file.status}
                              </span>
                              <PathLabel label={file.pathLabel} />
                              {file.notes.length ? (
                                <span className="commit-timeline-file-notes">
                                  {file.notes.join(" · ")}
                                </span>
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                      {!selectedFiles.length && !commit.baseline ? (
                        <li className="commit-timeline-empty">
                          변경 파일 없음
                        </li>
                      ) : null}
                    </ul>
                    {fileTools ? (
                      <div className="commit-timeline-file-tools">
                        {fileTools}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
      <p className="commit-timeline-note">
        Git 위상 순서 · 변경 비교는 실제 첫 부모 기준
      </p>
    </nav>
  );
}
