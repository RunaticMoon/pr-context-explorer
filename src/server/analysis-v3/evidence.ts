import { createHash } from "node:crypto";
import type {
  Evidence,
  LiveSnapshot,
  SourceEvidence,
  ContextBundle,
} from "./types.ts";
import { requireValid } from "./schema.ts";
export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
export const linesOf = (text: string) => text.replace(/\n$/, "").split("\n");
export function unique(ids: string[], label: string): void {
  requireValid(ids.length === new Set(ids).size, "duplicate " + label);
}
export function validateCodeEvidence(e: Evidence, s: LiveSnapshot): string {
  const p = [s.baseline, ...s.phases].find((p) => p.sha === e.commitSha);
  requireValid(e.snapshotId === s.snapshotId && p, "evidence snapshot/commit");
  requireValid(e.side === "old" || e.side === "new", "evidence side");
  requireValid(
    e.comparisonFromSha === p.comparisonFromSha ||
      p.parentComparisons.some(
        (c) => c.fromSha === e.comparisonFromSha && c.toSha === p.sha,
      ),
    "evidence comparison",
  );
  requireValid(
    e.revisionSha === (e.side === "old" ? e.comparisonFromSha : p.sha),
    "evidence revision",
  );
  const f = p.files.find((f) => f.id === e.fileId);
  requireValid(f, "evidence file");
  let content: string | null;
  if (e.side === "new") {
    requireValid(
      f.status !== "deleted" &&
        f.retrieved &&
        e.path === f.path &&
        e.blobSha === f.blobSha,
      "evidence new path/blob/existence",
    );
    content = f.content;
  } else if (e.comparisonFromSha === p.comparisonFromSha) {
    requireValid(
      e.path === f.oldPath && e.blobSha === f.oldBlobSha,
      "evidence old path/blob",
    );
    content = f.oldContent;
  } else {
    const old = [s.baseline, ...s.phases]
      .find((p) => p.sha === e.revisionSha)
      ?.files.find(
        (f) =>
          f.path === e.path &&
          f.blobSha === e.blobSha &&
          f.status !== "deleted" &&
          f.retrieved,
      );
    content = old?.content ?? null;
    requireValid(
      p.parentComparisons.some(
        (c) =>
          c.fromSha === e.revisionSha &&
          c.hunks.some(
            (h) =>
              h.oldPath === e.path &&
              (h.newPath === f.path || f.status === "deleted"),
          ),
      ),
      "parent evidence mapping",
    );
  }
  requireValid(
    content !== null && digest(content) === e.contentHash,
    "evidence content hash/unavailable",
  );
  requireValid(
    Number.isInteger(e.lineStart) &&
      Number.isInteger(e.lineEnd) &&
      e.lineStart >= 1 &&
      e.lineEnd >= e.lineStart &&
      e.lineEnd <= linesOf(content).length,
    "evidence range",
  );
  const original = s.evidence.find((x) => x.id === e.id);
  const identity = original
    ? JSON.stringify(original) === JSON.stringify(e)
    : e.id.startsWith("v3-range:")
      ? s.evidence.some((x) => {
          if (
            x.commitSha !== e.commitSha ||
            x.fileId !== e.fileId ||
            x.side !== e.side ||
            x.lineStart > e.lineStart ||
            x.lineEnd < e.lineEnd
          )
            return false;
          const range = { ...x, lineStart: e.lineStart, lineEnd: e.lineEnd };
          const canonical = {
            ...range,
            id: "v3-range:" + digest(JSON.stringify(range)).slice(0, 32),
          };
          // Bind every supplied immutable field to the canonical range, not
          // just its ID/range/phase. Two valid merge parents are not fungible.
          // Compare values independently of JSON/cache property insertion order.
          return (
            Object.keys(e).length === Object.keys(canonical).length &&
            Object.entries(canonical).every(
              ([key, value]) => e[key as keyof Evidence] === value,
            )
          );
        })
      : e.id.startsWith("v3-parent:") &&
        e.comparisonFromSha !== p.comparisonFromSha &&
        e.id ===
          "v3-parent:" + digest(JSON.stringify({ ...e, id: "" })).slice(0, 32);
  requireValid(
    identity,
    "evidence identity is not an original or derived proof",
  );
  return linesOf(content)
    .slice(e.lineStart - 1, e.lineEnd)
    .join("\n");
}
export function sourceRole(
  e: SourceEvidence,
  s: LiveSnapshot,
): "explicit_acceptance_criteria" | "source_text" {
  if (e.sourceKind !== "jira") return "source_text";
  const issue = s.jiraData?.batch.items
    .flatMap((i) => (i.result.state === "captured" ? [i.result.snapshot] : []))
    .find(
      (j) =>
        j.captureHash === e.version &&
        j.identity.host === e.host &&
        j.identity.issueId === e.issueId &&
        j.identity.issueKey === e.issueKey,
    );
  return issue?.acceptanceCriteria.some(
    (c) => c.document.pointer === e.fieldPath,
  )
    ? "explicit_acceptance_criteria"
    : "source_text";
}
export function validateSourceEvidence(
  e: SourceEvidence,
  s: LiveSnapshot,
): void {
  requireValid(
    e.snapshotId === s.snapshotId && e.contentHash === digest(e.text),
    "source hash/snapshot",
  );
  requireValid(
    e.id && e.sourceId && e.version && e.fieldPath.startsWith("/"),
    "source identity/version",
  );
  if (e.sourceKind === "pr")
    requireValid(
      e.version === s.prMetadataHash &&
        e.sourceId === s.pr.url &&
        ((e.fieldPath === "/body" && e.text === s.pr.body) ||
          (e.fieldPath === "/title" && e.text === s.pr.title)),
      "source PR field/version/identity",
    );
  else if (e.sourceKind === "commit") {
    const p = [s.baseline, ...s.phases].find((p) => p.sha === e.commitSha);
    requireValid(
      p &&
        e.sourceId === p.sha &&
        e.fieldPath === "/message" &&
        e.version === p.sha &&
        e.text === p.message,
      "source commit",
    );
  } else if (e.sourceKind === "jira") {
    const issue = s.jiraData?.batch.items
      .flatMap((i) =>
        i.result.state === "captured" ? [i.result.snapshot] : [],
      )
      .find(
        (j) =>
          j.captureHash === e.version &&
          j.identity.host === e.host &&
          j.identity.issueId === e.issueId &&
          j.identity.issueKey === e.issueKey,
      );
    const doc =
      issue &&
      [
        issue.title,
        issue.description,
        ...issue.acceptanceCriteria.map((c) => c.document),
      ].find((d) => d.pointer === e.fieldPath);
    requireValid(
      issue &&
        doc &&
        doc.text === e.text &&
        issue.webUrl === e.sourceId &&
        issue.fetchedAt === e.fetchedAt &&
        (issue.updatedAt || undefined) === e.updatedAt &&
        s.jiraSnapshotHashes.includes(e.version),
      "Jira source version/field/content",
    );
  } else throw Error("source kind");
}
export function validateSnapshotEvidence(s: LiveSnapshot): void {
  unique([s.baseline.sha, ...s.phases.map((p) => p.sha)], "phase IDs");
  unique(
    [...s.evidence.map((e) => e.id), ...s.sourceEvidence.map((e) => e.id)],
    "evidence IDs",
  );
  for (const p of [s.baseline, ...s.phases]) {
    unique(
      p.files.map((f) => f.id),
      "file IDs",
    );
    unique(
      p.edges.map((e) => e.id),
      "graph IDs",
    );
    for (const e of p.edges)
      requireValid(
        e.type === "import" &&
          e.provenance === "typescript-ast" &&
          p.files.some((f) => f.id === e.source && f.status !== "deleted") &&
          p.files.some((f) => f.id === e.target && f.status !== "deleted") &&
          s.evidence.some(
            (x) =>
              x.id === e.evidenceId &&
              x.fileId === e.source &&
              x.commitSha === p.sha &&
              x.side === "new",
          ),
        "static graph provenance/references",
      );
  }
  for (const e of s.evidence) validateCodeEvidence(e, s);
  for (const e of s.sourceEvidence) validateSourceEvidence(e, s);
}
export function validateContextBundle(c: ContextBundle, s: LiveSnapshot): void {
  requireValid(
    c.snapshotId === s.snapshotId && c.headSha === s.headSha,
    "context snapshot",
  );
  requireValid(
    c.sourceHashes.prMetadataHash === s.prMetadataHash &&
      JSON.stringify(c.sourceHashes.jiraSnapshotHashes) ===
        JSON.stringify(s.jiraSnapshotHashes),
    "context source hashes",
  );
  unique(
    c.phases.map((p) => p.sha),
    "context phase IDs",
  );
  unique(
    c.hunks.map((h) => h.id),
    "context hunk IDs",
  );
  unique(
    c.edges.map((e) => e.id),
    "context graph IDs",
  );
  for (const p of c.phases) {
    const original = [s.baseline, ...s.phases].find((x) => x.sha === p.sha);
    requireValid(
      original &&
        JSON.stringify(p) ===
          JSON.stringify({
            sha: original.sha,
            parents: original.parents,
            comparisonFromSha: original.comparisonFromSha,
            comparisons: original.parentComparisons.map((x) => ({
              fromSha: x.fromSha,
              toSha: x.toSha,
              policy: x.policy,
            })),
          }),
      "context phase metadata",
    );
  }
  for (const h of c.hunks) {
    const { id, originalId, ...raw } = h;
    const p = [s.baseline, ...s.phases].find((p) => p.sha === h.newSha);
    const original =
      p &&
      [...p.hunks, ...p.parentComparisons.flatMap((c) => c.hunks)].find(
        (x) => JSON.stringify(x) === JSON.stringify({ id: originalId, ...raw }),
      );
    // Compare canonical fields rather than object insertion order across JSON cache round-trips.
    const candidates = p && [
      ...p.hunks,
      ...p.parentComparisons.flatMap((c) => c.hunks),
    ];
    const actual =
      original ||
      candidates?.find(
        (x) =>
          x.id === originalId &&
          Object.entries(raw).every(([k, v]) => (x as any)[k] === v),
      );
    requireValid(
      actual && id === "v3-hunk:" + digest(JSON.stringify(actual)).slice(0, 32),
      "context hunk proof",
    );
  }
  requireValid(
    Object.keys(c.blobs).every((key) =>
      c.code.some((x) => x.contentRef === key),
    ),
    "unreferenced context blob",
  );
  unique(
    [...c.code.map((x) => x.evidence.id), ...c.sources.map((e) => e.id)],
    "context evidence IDs",
  );
  for (const x of c.code) {
    const text = validateCodeEvidence(x.evidence, s);
    requireValid(
      c.blobs[x.contentRef] === text && digest(text) === x.contentRef,
      "context content proof",
    );
  }
  requireValid(
    Object.keys(c.sourceRoles).length === c.sources.length &&
      c.sources.every((e) => c.sourceRoles[e.id] === sourceRole(e, s)),
    "context source roles",
  );
  for (const e of c.sources) {
    validateSourceEvidence(e, s);
    requireValid(
      s.sourceEvidence.some((x) => JSON.stringify(x) === JSON.stringify(e)),
      "source not supplied by snapshot",
    );
  }
  for (const e of c.edges)
    requireValid(
      [s.baseline, ...s.phases]
        .find((p) => p.sha === e.revisionSha)
        ?.edges.some(
          (x) =>
            x.id === e.id &&
            x.source === e.source &&
            x.target === e.target &&
            x.evidenceId === e.evidenceId &&
            x.type === e.type &&
            x.provenance === e.provenance,
        ) && c.code.some((x) => x.evidence.id === e.evidenceId),
      "context graph proof",
    );
}
