import type { Comparison, LiveFile, LivePhase } from "./server/live-git";

export type ComparisonScope = "commit" | "cumulative" | "final";
export const comparisonScopeLabels: Record<ComparisonScope, string> = {
  commit: "이 커밋의 변경",
  cumulative: "여기까지 누적",
  final: "최종 PR 변경",
};

/** Project a pinned after-tree onto an exact Git comparison. Never borrow
 * first-parent statuses, tombstones or old content for a different base. */
export function projectPhaseComparison(
  phase: LivePhase,
  before: LivePhase | undefined,
  comparison: Comparison,
): LivePhase {
  if (comparison.toSha !== phase.sha) throw Error("comparison target mismatch");
  if (before && before.sha !== comparison.fromSha)
    throw Error("comparison base mismatch");
  if (!comparison.changes) throw Error("comparison file metadata unavailable");
  const changes = new Map(comparison.changes.map((c) => [c.path, c]));
  const beforeFiles = new Map(
    before?.files.filter((f) => f.status !== "deleted").map((f) => [f.path, f]),
  );
  const files: LiveFile[] = phase.files
    .filter((f) => f.status !== "deleted")
    .map((f) => {
      const change = changes.get(f.path);
      const oldPath = change ? change.oldPath : f.path;
      const old = oldPath ? beforeFiles.get(oldPath) : undefined;
      return {
        ...f,
        status: change?.status || "unchanged",
        oldPath,
        oldBlobSha: old?.blobSha || null,
        oldContent: old?.retrieved ? old.content : null,
        renameEvidence: change?.rename || null,
        ...(oldPath && !old
          ? {
              omission: [f.omission, "비교 기준의 원문 미확보"]
                .filter(Boolean)
                .join(" · "),
            }
          : {}),
      };
    });
  for (const change of comparison.changes) {
    if (change.status !== "deleted") continue;
    const old = beforeFiles.get(change.oldPath || change.path);
    // An uncollected parent tree has no authoritative blob/content. Keep the
    // deletion navigable with an explicit omission instead of reusing head.
    const prior = old || phase.files.find((f) => f.path === change.path);
    files.push({
      id: prior?.id || `deleted:${comparison.fromSha}:${change.path}`,
      path: change.path,
      blobSha: old?.blobSha || "",
      content: "",
      status: "deleted",
      oldPath: change.oldPath,
      oldBlobSha: old?.blobSha || null,
      oldContent: old?.retrieved ? old.content : null,
      retrieved: old?.retrieved || false,
      omission: old?.omission || (!old ? "비교 기준의 원문 미확보" : undefined),
      mode: old?.mode || "",
      size: old?.size || 0,
      lineage: old?.lineage || "path",
      renameEvidence: null,
    });
  }
  // A delete/re-add can retire an ID that is still live at another path.
  const ids = new Set<string>();
  for (const file of files) {
    if (ids.has(file.id))
      file.id = `deleted:${comparison.fromSha}:${file.path}`;
    ids.add(file.id);
  }
  return {
    ...phase,
    comparisonFromSha: comparison.fromSha,
    comparisonPolicy: comparison.policy,
    files,
    diff: comparison.diff,
    hunks: comparison.hunks,
    parentComparisons: [comparison],
  };
}

/** Keys include snapshot identity; old asynchronous responses never match a
 * newer selection even when the same path or commit exists in both PRs. */
export function comparisonKey(
  snapshotId: string,
  from: string | null,
  to: string,
) {
  return `${snapshotId}:${from || "none"}:${to}`;
}
