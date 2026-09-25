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
export function CommitTimeline(_props: CommitTimelineProps): React.ReactElement {
  throw new Error("not implemented");
}
