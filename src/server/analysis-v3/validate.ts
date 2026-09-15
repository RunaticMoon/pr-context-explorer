import type {
  ContextBundle,
  LiveSnapshot,
  Scope,
  GroundedStatement,
  V3Output,
  SynthesisOutput,
  ChunkOutput,
  TourOutput,
  ValidationOptions,
  CodeExplanation,
  Tour,
} from "./types.ts";
import { emptyContext } from "./plan.ts";
import {
  bytes,
  sourceRole,
  unique,
  validateContextBundle,
} from "./evidence.ts";
import { requireValid, validateGroundedStatement } from "./schema.ts";
import { schemaChecks } from "./output-schema.ts";
/** Pure union. Callers must impose their own byte cap; runPipeline uses bounded assembly. */
export function mergeContexts(
  s: LiveSnapshot,
  scope: Scope,
  contexts: ContextBundle[],
): ContextBundle {
  const c = emptyContext(s, scope);
  for (const x of contexts) {
    for (const key of ["code", "sources", "phases", "hunks", "edges"] as const)
      for (const value of x[key]) {
        const id =
          key === "code"
            ? (value as ContextBundle["code"][number]).evidence.id
            : key === "phases"
              ? (value as ContextBundle["phases"][number]).sha
              : (value as { id: string }).id;
        const items = c[key] as any[];
        if (
          !items.some(
            (v) =>
              (key === "code"
                ? v.evidence.id
                : key === "phases"
                  ? v.sha
                  : v.id) === id,
          )
        )
          items.push(structuredClone(value));
      }
    Object.assign(c.blobs, x.blobs);
    Object.assign(c.sourceRoles, x.sourceRoles);
  }
  return c;
}
export function collectStatements(
  value: unknown,
  pointer = "",
): { pointer: string; statement: GroundedStatement }[] {
  if (!value || typeof value !== "object") return [];
  if ("text" in value && "kind" in value && "evidenceIds" in value)
    return [{ pointer, statement: value as GroundedStatement }];
  return Object.entries(value).flatMap(([key, v]) =>
    collectStatements(
      v,
      pointer + "/" + key.replace(/~/g, "~0").replace(/\//g, "~1"),
    ),
  );
}
export function referencedEvidenceIds(value: unknown): string[] {
  return [
    ...new Set(
      collectStatements(value).flatMap((x) => x.statement.evidenceIds),
    ),
  ];
}
export function validateStage(
  value: unknown,
  kind: keyof typeof schemaChecks,
  s: LiveSnapshot,
  c: ContextBundle,
  options: ValidationOptions = {},
): void {
  requireValid(
    bytes(value) <= (options.maxOutputBytes || 180000),
    "output byte limit",
  );
  const check = schemaChecks[kind];
  requireValid(check(value), "output schema: " + JSON.stringify(check.errors));
  validateContextBundle(c, s);
  const a = value as V3Output & ChunkOutput;
  requireValid(a.snapshotId === s.snapshotId, "snapshot mismatch");
  requireValid(
    a.analysisStatus === "complete" ||
      a.limitations.length ||
      a.missingContext.length,
    "partial/insufficient context requires limitation",
  );
  if (options.omissions?.length)
    requireValid(
      a.analysisStatus !== "complete",
      "omitted context cannot be complete",
    );
  const code = new Map(c.code.map((x) => [x.evidence.id, x.evidence])),
    sources = new Map(c.sources.map((x) => [x.id, x]));
  const allowed = new Set([...code.keys(), ...sources.keys()]);
  const refs = (ids: string[]) => {
    unique(ids, "reference IDs");
    requireValid(
      ids.every((id) => allowed.has(id)),
      "evidence outside transmitted context",
    );
  };
  const phase = (sha: string) => {
    const p = [s.baseline, ...s.phases].find((p) => p.sha === sha);
    requireValid(
      p && c.phases.some((p) => p.sha === sha),
      "phase outside transmitted context",
    );
    return p;
  };
  const comparison = (sha: string, from: string | null) => {
    const p = phase(sha);
    requireValid(
      from === p.comparisonFromSha ||
        p.parentComparisons.some((x) => x.fromSha === from && x.toSha === sha),
      "revision comparison",
    );
  };
  const files = (ids: string[], sha?: string) => {
    unique(ids, "file references");
    for (const id of ids)
      requireValid(
        c.code.some(
          (x) =>
            x.evidence.fileId === id && (!sha || x.evidence.commitSha === sha),
        ),
        "file outside transmitted context/revision",
      );
  };
  const scoped = (
    ids: string[],
    sha: string,
    fileIds: string[],
    from?: string | null,
  ) => {
    refs(ids);
    for (const id of ids) {
      const e = code.get(id);
      if (e)
        requireValid(
          e.commitSha === sha &&
            fileIds.includes(e.fileId) &&
            (from === undefined || e.comparisonFromSha === from),
          "evidence target revision/file/comparison",
        );
      const source = sources.get(id);
      if (source?.sourceKind === "commit")
        requireValid(source.commitSha === sha, "source commit revision");
    }
  };
  const graph = (ids: string[], sha: string, fileIds: string[]) => {
    unique(ids, "graph references");
    for (const id of ids)
      requireValid(
        c.edges.some(
          (e) =>
            e.id === id &&
            e.revisionSha === sha &&
            (fileIds.includes(e.source) || fileIds.includes(e.target)),
        ),
        "graph outside transmitted revision/files",
      );
  };
  const hunks = (
    ids: string[],
    sha: string,
    from: string | null,
    fileIds: string[],
  ) => {
    unique(ids, "hunk references");
    for (const id of ids) {
      const h = c.hunks.find((h) => h.id === id);
      requireValid(
        h &&
          h.newSha === sha &&
          h.oldSha === from &&
          phase(sha).files.some(
            (f) =>
              fileIds.includes(f.id) &&
              (f.path === h.newPath || f.oldPath === h.oldPath),
          ),
        "hunk outside transmitted revision/comparison/files",
      );
    }
  };
  const statements = collectStatements(value);
  for (const { statement } of statements)
    validateGroundedStatement(statement, allowed);
  const synth =
    kind === "synthesis" || kind === "output"
      ? (value as SynthesisOutput)
      : undefined;
  const requirements = new Map(synth?.requirements.map((r) => [r.id, r]) || []);
  const requirementRefs = (ids: string[]) => {
    unique(ids, "requirement references");
    requireValid(
      ids.every((id) => requirements.has(id)),
      "unknown requirement ID",
    );
  };
  if (synth) {
    unique(
      synth.requirements.map((r) => r.id),
      "requirement IDs",
    );
    unique(
      synth.changeGroups.map((g) => g.id),
      "change group IDs",
    );
    unique(
      synth.phaseSummaries.map((p) => p.commitSha + ":" + p.comparisonFromSha),
      "phase summary IDs",
    );
    unique(
      synth.discrepancies.map((d) => d.id),
      "discrepancy IDs",
    );
    unique(
      synth.inferredEdgeSuggestions.map((e) => e.id),
      "inferred graph IDs",
    );
    for (const x of synth.inferredEdgeSuggestions) {
      requireValid(
        !c.edges.some((e) => e.id === x.id),
        "inferred edge collides with static graph",
      );
      files(
        [x.fromFileId, x.toFileId].filter((x, i, a) => a.indexOf(x) === i),
        x.revisionSha,
      );
      requireValid(
        x.explanation.kind === "inferred" || x.explanation.kind === "unknown",
        "inferred edge cannot be observed/static",
      );
      scoped(x.explanation.evidenceIds, x.revisionSha, [
        x.fromFileId,
        x.toFileId,
      ]);
    }
    for (const r of synth.requirements) {
      refs(r.sourceEvidenceIds);
      requireValid(
        r.sourceEvidenceIds.every((id) => sources.has(id)),
        "requirement source references",
      );
      requireValid(
        r.sourceEvidenceIds.every((id) =>
          r.statement.evidenceIds.includes(id),
        ) || r.statement.kind === "unknown",
        "requirement statement source proof",
      );
      if (r.sourceRole === "explicit_acceptance_criteria")
        requireValid(
          r.sourceEvidenceIds.every(
            (id) =>
              sourceRole(sources.get(id)!, s) ===
              "explicit_acceptance_criteria",
          ),
          "explicit acceptance criteria require mapped AC source",
        );
      if (r.sourceRole === "interpretation_proposal")
        requireValid(
          r.statement.kind !== "observed",
          "requirement interpretation cannot be observed",
        );
    }
    for (const d of synth.discrepancies) {
      requirementRefs(d.requirementIds);
      refs(d.sourceEvidenceIds);
      refs(d.codeEvidenceIds);
      requireValid(
        d.sourceEvidenceIds.every((id) => sources.has(id)) &&
          d.codeEvidenceIds.every((id) => code.has(id)),
        "discrepancy conflicting source/code sides",
      );
      requireValid(
        d.explanation.kind === "unknown" ||
          [...d.sourceEvidenceIds, ...d.codeEvidenceIds].every((id) =>
            d.explanation.evidenceIds.includes(id),
          ),
        "discrepancy explanation requires both conflicting IDs",
      );
    }
    for (const r of synth.requirementMappings) {
      requirementRefs([r.requirementId]);
      refs(r.evidenceIds);
      refs(r.testEvidenceIds);
      files(r.fileIds);
      r.commitShas.forEach(phase);
      for (const id of [...r.evidenceIds, ...r.testEvidenceIds]) {
        const e = code.get(id);
        if (e)
          requireValid(
            r.fileIds.includes(e.fileId) && r.commitShas.includes(e.commitSha),
            "mapping evidence target",
          );
      }
      requireValid(
        r.testEvidenceIds.every((id) => code.has(id)),
        "test source evidence",
      );
      if (
        ["supported_by_code", "partial_support", "contradicted"].includes(
          r.status,
        )
      ) {
        requireValid(
          r.evidenceIds.some((id) => code.has(id)) &&
            requirements
              .get(r.requirementId)!
              .sourceEvidenceIds.some((id) => r.evidenceIds.includes(id)),
          "requirement code and source support",
        );
        requireValid(
          r.explanation.kind !== "unknown",
          "supported mapping explanation unknown",
        );
      }
      if (r.status === "contradicted")
        requireValid(
          synth.discrepancies.some(
            (d) =>
              d.requirementIds.includes(r.requirementId) &&
              d.codeEvidenceIds.some((id) => r.evidenceIds.includes(id)) &&
              d.sourceEvidenceIds.some((id) => r.evidenceIds.includes(id)),
          ),
          "contradicted mapping requires discrepancy",
        );
    }
    for (const x of synth.changeGroups) {
      files(x.fileIds);
      x.commitShas.forEach(phase);
      refs(x.evidenceIds);
    }
    for (const x of synth.phaseSummaries) {
      comparison(x.commitSha, x.comparisonFromSha);
      files(x.focusFileIds, x.commitSha);
      graph(x.focusGraphEdgeIds, x.commitSha, x.focusFileIds);
      hunks(x.focusHunkIds, x.commitSha, x.comparisonFromSha, x.focusFileIds);
      for (const { statement } of collectStatements(x))
        scoped(
          statement.evidenceIds,
          x.commitSha,
          x.focusFileIds,
          x.comparisonFromSha,
        );
    }
    requireValid(
      synth.overview.statedIntent.kind === "unknown" ||
        synth.overview.statedIntent.evidenceIds.some((id) => sources.has(id)),
      "stated intent requires original source",
    );
    requireValid(
      synth.overview.inferredIntent.kind !== "observed",
      "inferred intent cannot be observed",
    );
  }
  const explain = (x: CodeExplanation) => {
    comparison(x.targetRevisionSha, x.comparisonFromSha);
    files([x.fileId], x.targetRevisionSha);
    scoped(
      x.selectedEvidenceIds,
      x.targetRevisionSha,
      [x.fileId],
      x.comparisonFromSha,
    );
    requireValid(
      x.selectedEvidenceIds.every((id) => code.has(id)),
      "code selected evidence",
    );
    for (const field of [
      "roleInPR",
      "responsibility",
      "inputsOutputs",
      "behavior",
      "beforeAfter",
      "sideEffects",
      "errorHandling",
      "answerToQuestion",
    ] as const)
      scoped(
        x[field].evidenceIds,
        x.targetRevisionSha,
        [x.fileId],
        x.comparisonFromSha,
      );
    for (const r of x.relationships) {
      if (r.kind === "static_graph")
        graph([r.referenceId], x.targetRevisionSha, [x.fileId]);
      else
        requireValid(
          synth?.inferredEdgeSuggestions.some(
            (e) =>
              e.id === r.referenceId &&
              e.revisionSha === x.targetRevisionSha &&
              [e.fromFileId, e.toFileId].includes(x.fileId),
          ),
          "unknown inferred relationship",
        );
    }
    for (const r of x.requirementLinks) requirementRefs([r.requirementId]);
    refs(x.testEvidenceIds);
    requireValid(
      x.testEvidenceIds.every((id) => code.has(id)),
      "test evidence must be code, not test execution",
    );
    for (const next of x.nextReadingSuggestions) {
      files([next.fileId], next.targetRevisionSha);
      scoped(next.evidenceIds, next.targetRevisionSha, [next.fileId]);
      requireValid(
        next.evidenceIds.some((id) => code.has(id)),
        "next reading code proof",
      );
    }
  };
  if (kind !== "tour") {
    unique(
      a.codeExplanations.map((x) => x.id),
      "code explanation IDs",
    );
    a.codeExplanations.forEach(explain);
  }
  const tour =
    kind === "tour" || kind === "output"
      ? (value as TourOutput).tour
      : undefined;
  if (tour) {
    requireValid(tour.tourRevisionSha === s.headSha, "head tour revision");
    unique(
      tour.steps.map((x) => x.id),
      "step IDs",
    );
    unique(
      tour.storyEdges.map((e) => e.id),
      "story edge IDs",
    );
    const order = new Map(tour.steps.map((x, i) => [x.id, i]));
    for (const x of tour.steps) {
      comparison(x.targetRevisionSha, x.comparisonFromSha);
      if (!x.historical)
        requireValid(
          x.targetRevisionSha === s.headSha,
          "default step must target head",
        );
      else {
        requireValid(
          options.allowHistoricalSteps,
          "historical steps require explicit opt-in",
        );
        requireValid(
          x.targetRevisionSha !== s.headSha &&
            x.historicalReason.kind !== "unknown",
          "historical explanation/evidence",
        );
      }
      files(x.focusFileIds, x.targetRevisionSha);
      scoped(
        x.focusEvidenceIds,
        x.targetRevisionSha,
        x.focusFileIds,
        x.comparisonFromSha,
      );
      requireValid(
        x.focusEvidenceIds.every((id) => code.has(id)),
        "tour code proof",
      );
      if (!x.historical) {
        // focusEvidenceIds[0] is the primary navigation target. commitSha
        // alone denotes the comparison owner, not where old-side code lives.
        const primary = code.get(x.focusEvidenceIds[0]);
        requireValid(
          primary?.side === "new" && primary.revisionSha === s.headSha,
          "primary reading evidence must be live head/new code",
        );
        requireValid(
          x.focusEvidenceIds.every(
            (id) =>
              code.get(id)!.side !== "old" ||
              x.beforeAfter.evidenceIds.includes(id),
          ),
          "old reading evidence must be secondary before/after comparison",
        );
      }
      requireValid(
        x.focusFileIds.every((id) =>
          x.focusEvidenceIds.some((e) => code.get(e)?.fileId === id),
        ),
        "tour file needs own code evidence",
      );
      graph(x.focusGraphEdgeIds, x.targetRevisionSha, x.focusFileIds);
      hunks(
        x.focusHunkIds,
        x.targetRevisionSha,
        x.comparisonFromSha,
        x.focusFileIds,
      );
      if (kind === "output") requirementRefs(x.requirementIds);
      for (const { statement } of collectStatements(x))
        scoped(
          statement.evidenceIds,
          x.targetRevisionSha,
          x.focusFileIds,
          x.comparisonFromSha,
        );
      unique(x.prerequisiteStepIds, "prerequisite IDs");
      for (const id of x.prerequisiteStepIds)
        requireValid(
          order.has(id) && order.get(id)! < order.get(x.id)!,
          "prerequisite cycle/order/unknown",
        );
    }
    for (const e of tour.storyEdges)
      requireValid(
        order.has(e.fromStepId) &&
          order.has(e.toStepId) &&
          order.get(e.fromStepId)! < order.get(e.toStepId)!,
        "story cycle/order/unknown",
      );
    if (tour.steps.length)
      requireValid(
        tour.steps.at(-1)!.targetRevisionSha === s.headSha,
        "historical tour must return to head",
      );
    if (c.scope.kind === "pr" && a.analysisStatus === "complete")
      requireValid(
        tour.steps.length && tour.steps.some((x) => !x.historical),
        "complete PR requires grounded head tour",
      );
  }
}
export function validateV3Output(
  value: unknown,
  s: LiveSnapshot,
  context: ContextBundle,
  options: ValidationOptions = {},
): asserts value is V3Output {
  validateStage(value, "output", s, context, options);
}
