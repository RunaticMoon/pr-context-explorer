import React from "react";
import type { CommitReview } from "./commit-review";
import type { EvidenceButtons } from "./live-grounded";

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
export function CommitReviewPanel(
  _props: CommitReviewPanelProps,
): React.ReactElement {
  throw new Error("not implemented");
}
