import type { LivePhase, LiveFile } from "../live-git.ts";
import type {
  ContextBundle,
  ContextChunk,
  ContextPlan,
  Evidence,
  LiveSnapshot,
  Omission,
  PipelineBudgets,
  Scope,
  ContextCode,
} from "./types.ts";
import {
  bytes,
  digest,
  linesOf,
  validateCodeEvidence,
  validateSnapshotEvidence,
  sourceRole,
} from "./evidence.ts";
import { requireValid } from "./schema.ts";
export const PLAN_VERSION = "v3-plan-1";
export const DEFAULT_BUDGETS: PipelineBudgets = {
  maxChunks: 48,
  maxChunkBytes: 32000,
  maxTotalContextBytes: 1200000,
  maxSynthesisBytes: 180000,
  maxOutputBytes: 180000,
  linesPerWindow: 100,
  maxCalls: 52,
  callTimeoutMs: 120000,
  totalTimeoutMs: 900000,
};
export function resolveBudgets(
  options: Partial<PipelineBudgets> = {},
): PipelineBudgets {
  const b = { ...DEFAULT_BUDGETS, ...options };
  for (const [key, value] of Object.entries(b))
    requireValid(
      Number.isSafeInteger(value) &&
        value > 0 &&
        value <= DEFAULT_BUDGETS[key as keyof PipelineBudgets] * 4,
      "invalid finite budget: " + key,
    );
  return b;
}
export function emptyContext(s: LiveSnapshot, scope: Scope): ContextBundle {
  return {
    snapshotId: s.snapshotId,
    headSha: s.headSha,
    scope,
    sourceHashes: {
      prMetadataHash: s.prMetadataHash,
      jiraSnapshotHashes: [...s.jiraSnapshotHashes],
    },
    phases: [],
    code: [],
    blobs: {},
    sources: [],
    sourceRoles: {},
    hunks: [],
    edges: [],
  };
}
function addPhase(c: ContextBundle, p: LivePhase) {
  if (!c.phases.some((x) => x.sha === p.sha))
    c.phases.push({
      sha: p.sha,
      parents: [...p.parents],
      comparisonFromSha: p.comparisonFromSha,
      comparisons: p.parentComparisons.map((x) => ({
        fromSha: x.fromSha,
        toSha: x.toSha,
        policy: x.policy,
      })),
    });
}
function addCode(
  c: ContextBundle,
  e: Evidence,
  origin: ContextCode["origin"],
  s: LiveSnapshot,
) {
  if (c.code.some((x) => x.evidence.id === e.id)) return;
  const content = validateCodeEvidence(e, s),
    contentRef = digest(content);
  c.blobs[contentRef] = content;
  c.code.push({ evidence: { ...e }, contentRef, origin });
  addPhase(
    c,
    [s.baseline, ...s.phases].find((p) => p.sha === e.commitSha)!,
  );
}
function rangeEvidence(e: Evidence, start: number, end: number): Evidence {
  if (start === e.lineStart && end === e.lineEnd) return { ...e };
  const value = { ...e, lineStart: start, lineEnd: end };
  return {
    ...value,
    id: "v3-range:" + digest(JSON.stringify(value)).slice(0, 32),
  };
}
export function planContext(
  s: LiveSnapshot,
  scope: Scope,
  options: Partial<PipelineBudgets> = {},
): ContextPlan {
  validateSnapshotEvidence(s);
  const budgets = resolveBudgets(options),
    chunks: ContextChunk[] = [],
    omissions: Omission[] = [];
  const omit = (
    target: string,
    reason: string,
    category: Omission["category"] = "omitted",
    purpose = "bounded analysis context",
  ) => omissions.push({ target, reason, category, purpose });
  for (const x of s.coverage.omitted) omit(x, "snapshot_omitted");
  for (const x of s.coverage.unavailable)
    omit(x, "snapshot_unavailable", "unavailable");
  if (!s.coverage.complete && !omissions.length)
    omit("snapshot", "snapshot_incomplete", "unavailable");
  let total = 0;
  const submit = (
    context: ContextBundle,
    kind: ContextChunk["kind"],
    target: string,
  ) => {
    const size = bytes(context);
    if (size > budgets.maxChunkBytes) {
      omit(target, "chunk_byte_limit");
      return;
    }
    if (chunks.length >= budgets.maxChunks) {
      omit(target, "chunk_limit");
      return;
    }
    if (size + total > budgets.maxTotalContextBytes) {
      omit(target, "total_context_byte_limit");
      return;
    }
    const contextHash = digest(JSON.stringify(context));
    if (chunks.some((c) => c.contextHash === contextHash)) return;
    chunks.push({
      taskId: "chunk:" + contextHash.slice(0, 32),
      kind,
      context,
      contextHash,
    });
    total += size;
  };
  if (scope.kind === "code") {
    requireValid(
      typeof scope.question === "string" && scope.question.length <= 2000,
      "code question size",
    );
    requireValid(
      Number.isInteger(scope.lineStart) &&
        Number.isInteger(scope.lineEnd) &&
        scope.lineStart >= 1 &&
        scope.lineEnd >= scope.lineStart &&
        scope.lineEnd - scope.lineStart < 500,
      "selected code range",
    );
    const proof = s.evidence.find(
      (e) =>
        e.commitSha === scope.commitSha &&
        e.fileId === scope.fileId &&
        e.side === scope.side &&
        e.lineStart <= scope.lineStart &&
        e.lineEnd >= scope.lineEnd,
    );
    requireValid(proof, "selected code evidence unavailable");
    const c = emptyContext(s, scope);
    addCode(
      c,
      rangeEvidence(proof, scope.lineStart, scope.lineEnd),
      "selection",
      s,
    );
    submit(c, "file", "selection");
  } else {
    const ordered = [...s.phases].sort(
      (a, b) => Number(b.sha === s.headSha) - Number(a.sha === s.headSha),
    );
    // relatedFileIds may include collector-expanded unchanged imports. Derive
    // actual change priority from file state and real parent comparisons instead.
    const phaseChanged = (p: LivePhase, f: LiveFile) =>
      f.status !== "unchanged" ||
      p.parentComparisons.some((c) =>
        c.hunks.some(
          (h) =>
            h.newPath === f.path ||
            (h.oldPath !== null && h.oldPath === f.oldPath),
        ),
      );
    const changedIds = new Set(
      s.phases.flatMap((p) =>
        p.files.filter((f) => phaseChanged(p, f)).map((f) => f.id),
      ),
    );
    const changed: { p: LivePhase; f: LiveFile }[] = [];
    for (const p of ordered)
      for (const f of p.files)
        if (phaseChanged(p, f) || (p.sha === s.headSha && changedIds.has(f.id)))
          changed.push({ p, f });
    const processed = new Set<string>();
    const processFile = (
      p: LivePhase,
      f: LiveFile,
      origin: ContextCode["origin"],
    ) => {
      const key = p.sha + ":" + f.id;
      if (processed.has(key)) return;
      processed.add(key);
      const available = s.evidence.filter(
        (e) => e.commitSha === p.sha && e.fileId === f.id,
      );
      if (!available.length) {
        omit(key, f.omission || "code_not_retrieved", "unavailable");
        return;
      }
      // Hunk windows first, then bounded whole-file windows. Never let unrelated tree order consume the budget.
      const windows: { evidence: Evidence; origin: ContextCode["origin"] }[] =
        [];
      const seenRanges = new Set<string>();
      const enqueue = (
        e: Evidence,
        start: number,
        end: number,
        why: ContextCode["origin"],
      ) => {
        for (let line = start; line <= end; line += budgets.linesPerWindow) {
          const last = Math.min(line + budgets.linesPerWindow - 1, end),
            key = e.side + ":" + line + ":" + last;
          if (!seenRanges.has(key)) {
            windows.push({
              evidence: rangeEvidence(e, line, last),
              origin: why,
            });
            seenRanges.add(key);
          }
        }
      };
      for (const side of ["new", "old"] as const) {
        const e = available
          .filter((e) => e.side === side)
          .sort(
            (a, b) => b.lineEnd - b.lineStart - (a.lineEnd - a.lineStart),
          )[0];
        if (!e) continue;
        if (origin !== "direct_import")
          for (const h of p.hunks) {
            if ((side === "new" ? h.newPath : h.oldPath) !== e.path) continue;
            const start = side === "new" ? h.newStart : h.oldStart,
              count = side === "new" ? h.newCount : h.oldCount;
            if (count > 0)
              enqueue(
                e,
                Math.max(e.lineStart, start),
                Math.min(e.lineEnd, start + count - 1),
                "changed_hunk",
              );
          }
        enqueue(e, e.lineStart, e.lineEnd, origin);
      }
      for (const window of windows) {
        const c = emptyContext(s, scope);
        addCode(c, window.evidence, window.origin, s);
        for (const edge of p.edges.filter((edge) => edge.source === f.id)) {
          const proof = available.find((e) => e.id === edge.evidenceId);
          if (
            proof &&
            proof.side === window.evidence.side &&
            proof.lineStart >= window.evidence.lineStart &&
            proof.lineEnd <= window.evidence.lineEnd
          ) {
            const candidate = structuredClone(c);
            addCode(candidate, proof, window.origin, s);
            candidate.edges.push({ ...edge, revisionSha: p.sha });
            if (bytes(candidate) <= budgets.maxChunkBytes)
              Object.assign(c, candidate);
            else omit(edge.id, "edge_byte_limit");
          }
        }
        for (const h of p.hunks)
          if (h.newPath === f.path || h.oldPath === f.oldPath) {
            const hunk = {
              ...h,
              originalId: h.id,
              id: "v3-hunk:" + digest(JSON.stringify(h)).slice(0, 32),
            };
            const candidate = { ...c, hunks: [...c.hunks, hunk] };
            if (bytes(candidate) <= budgets.maxChunkBytes) c.hunks.push(hunk);
            else omit(hunk.id, "hunk_byte_limit");
          }
        submit(c, "file", key + ":" + window.evidence.id);
      }
      for (const comparison of p.parentComparisons)
        if (
          comparison.fromSha !== p.comparisonFromSha &&
          comparison.hunks.some(
            (h) => h.newPath === f.path || h.oldPath === f.oldPath,
          )
        ) {
          // These hunks are actual captured second-parent data; old blobs can only come from already captured trees.
          const c = emptyContext(s, scope);
          addPhase(c, p);
          for (const h of comparison.hunks.filter(
            (h) => h.newPath === f.path || h.oldPath === f.oldPath,
          )) {
            c.hunks.push({
              ...h,
              originalId: h.id,
              id: "v3-hunk:" + digest(JSON.stringify(h)).slice(0, 32),
            });
            for (const side of ["new", "old"] as const) {
              const file =
                side === "new"
                  ? f
                  : [s.baseline, ...s.phases]
                      .find((p) => p.sha === comparison.fromSha)
                      ?.files.find(
                        (f) => f.path === h.oldPath && f.status !== "deleted",
                      );
              const start = side === "new" ? h.newStart : h.oldStart,
                count = side === "new" ? h.newCount : h.oldCount;
              if (!count) continue;
              if (
                !file?.retrieved ||
                (side === "new" && f.status === "deleted")
              ) {
                omit(
                  comparison.fromSha + ":" + h.id + ":" + side,
                  "parent_tree_unavailable",
                  "unavailable",
                );
                continue;
              }
              const e: Evidence = {
                id: "",
                snapshotId: s.snapshotId,
                commitSha: p.sha,
                comparisonFromSha: comparison.fromSha,
                revisionSha: side === "new" ? p.sha : comparison.fromSha,
                fileId: f.id,
                path: file.path,
                blobSha: file.blobSha,
                side,
                lineStart: start,
                lineEnd: start + count - 1,
                contentHash: digest(file.content),
              };
              e.id = "v3-parent:" + digest(JSON.stringify(e)).slice(0, 32);
              addCode(c, e, "changed_hunk", s);
            }
          }
          if (c.code.length)
            submit(c, "file", p.sha + ":" + comparison.fromSha + ":" + f.id);
          else
            omit(
              p.sha + ":" + comparison.fromSha + ":" + f.id,
              "parent_code_unavailable",
              "unavailable",
            );
          if (comparison.partial)
            omit(p.sha + ":" + comparison.fromSha, "parent_diff_partial");
        }
    };
    for (const { p, f } of changed) processFile(p, f, "changed_file");
    for (const f of s.baseline.files)
      if (changedIds.has(f.id)) processFile(s.baseline, f, "pr_baseline");
    // Strict one-hop; import cycles do not recurse and already changed targets are deduplicated.
    for (const { p, f } of changed)
      for (const edge of p.edges.filter((e) => e.source === f.id)) {
        const dependency = p.files.find(
          (f) => f.id === edge.target && f.status !== "deleted",
        );
        if (dependency) processFile(p, dependency, "direct_import");
      }
  }
  for (const source of s.sourceEvidence)
    if (
      scope.kind === "pr" ||
      source.sourceKind !== "commit" ||
      source.commitSha === scope.commitSha
    ) {
      const c = emptyContext(s, scope);
      c.sources.push({ ...source });
      c.sourceRoles[source.id] = sourceRole(source, s);
      if (source.commitSha) {
        const p = [s.baseline, ...s.phases].find(
          (p) => p.sha === source.commitSha,
        );
        if (p) addPhase(c, p);
      }
      submit(c, "source", source.id);
    }
  return {
    version: PLAN_VERSION,
    snapshotId: s.snapshotId,
    scope,
    chunks,
    omissions,
    commitOrder: s.phases.map((p) => p.sha),
    budgets,
    discovered:
      chunks.length +
      omissions.filter(
        (o) =>
          o.reason === "chunk_limit" ||
          o.reason === "chunk_byte_limit" ||
          o.reason === "total_context_byte_limit",
      ).length,
    retrieved: chunks.length,
    selectedEvidenceIds: [
      ...new Set(
        chunks.flatMap((c) => [
          ...c.context.code.map((x) => x.evidence.id),
          ...c.context.sources.map((e) => e.id),
        ]),
      ),
    ],
  };
}
