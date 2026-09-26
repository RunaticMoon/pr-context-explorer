import React from "react";

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
};
export function CommitTimeline(props: CommitTimelineProps): React.ReactElement {
  const { commits, selectedSha, onSelect } = props;
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const selectedRef = React.useRef<HTMLButtonElement | null>(null);
  const selectedIndex = commits.findIndex((c) => c.sha === selectedSha);
  const selected = selectedIndex >= 0 ? commits[selectedIndex] : undefined;
  const realCommits = commits.filter((c) => !c.baseline);
  const commitNumber =
    selected && !selected.baseline
      ? realCommits.findIndex((c) => c.sha === selectedSha) + 1
      : 0;
  const prev = selectedIndex > 0 ? commits[selectedIndex - 1] : undefined;
  const next =
    selectedIndex >= 0 && selectedIndex < commits.length - 1
      ? commits[selectedIndex + 1]
      : undefined;

  React.useEffect(() => {
    const track = trackRef.current;
    const card = selectedRef.current;
    if (!track || !card) return;
    const trackRect = track.getBoundingClientRect?.();
    const cardRect = card.getBoundingClientRect?.();
    if (!trackRect || !cardRect) return;
    if (cardRect.left < trackRect.left) {
      track.scrollLeft += cardRect.left - trackRect.left;
    } else if (cardRect.right > trackRect.right) {
      track.scrollLeft += cardRect.right - trackRect.right;
    }
  }, [selectedSha]);

  return (
    <nav className="commit-timeline" aria-label="커밋 흐름">
      <div className="commit-timeline-header">
        <span className="commit-timeline-position">
          {selected?.baseline
            ? "Baseline · 비교 기준"
            : `커밋 ${commitNumber} / ${realCommits.length}`}
        </span>
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
      <div className="commit-timeline-track" ref={trackRef}>
        {commits.map((commit, index) => {
          const stats = commit.baseline ? undefined : commit.stats;
          const statsText = stats
            ? `파일 ${stats.changedFiles} · hunk ${stats.hunks}` +
              (stats.partial ? " · 부분 diff" : "") +
              (stats.steps ? ` · 투어 ${stats.read ?? 0}/${stats.steps}` : "")
            : undefined;
          const statsId = `commit-timeline-stats-${commit.sha}`;
          return (
            <React.Fragment key={commit.sha}>
              {index > 0 && (
                <span className="commit-link" aria-hidden="true">
                  →
                </span>
              )}
              <button
                type="button"
                className="commit-timeline-card"
                aria-label={commit.label}
                aria-pressed={commit.sha === selectedSha}
                aria-describedby={statsText ? statsId : undefined}
                ref={commit.sha === selectedSha ? selectedRef : undefined}
                onClick={() => onSelect(commit.sha)}
              >
                <b>{commit.label}</b>
                {commit.subject ? (
                  <span className="commit-timeline-subject">
                    {commit.subject}
                  </span>
                ) : null}
                <code>{commit.sha.slice(0, 8)}</code>
                {statsText ? (
                  <span className="commit-timeline-stats" id={statsId}>
                    {statsText}
                  </span>
                ) : null}
              </button>
            </React.Fragment>
          );
        })}
      </div>
      <p className="commit-timeline-note">
        Git 위상 순서 · 변경 비교는 실제 첫 부모 기준
      </p>
    </nav>
  );
}
