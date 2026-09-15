import { performance } from "node:perf_hooks";
import type {
  AuditOutput,
  CacheEntry,
  ChunkOutput,
  ContextBundle,
  ContextChunk,
  ContextPlan,
  GroundedStatement,
  Omission,
  PipelineCoverage,
  PipelineOptions,
  PipelineResult,
  PipelineStage,
  RunnerMetadata,
  StageContext,
  StageRecord,
  SynthesisOutput,
  Tour,
  TourOutput,
  V3Output,
} from "./types.ts";
import { bytes, digest } from "./evidence.ts";
import { emptyContext, planContext, PLAN_VERSION } from "./plan.ts";
import {
  chunkOutputSchema,
  synthesisOutputSchema,
  tourOutputSchema,
} from "./output-schema.ts";
import { requireValid } from "./schema.ts";
import {
  mergeContexts,
  referencedEvidenceIds,
  validateStage,
  validateV3Output,
} from "./validate.ts";
import { PROMPT_VERSION, trustedPrompt } from "./prompt.ts";
import {
  auditOutputSchema,
  validateAuditOutput,
  applySemanticAudit,
} from "./audit.ts";
import type { SemanticAudit } from "./types.ts";
export class PipelineError extends Error {
  semanticAudit?: SemanticAudit;
  constructor(
    public code: string,
    public processStatus: "failed" | "cancelled",
    public coverage: PipelineCoverage | null = null,
    public stages: StageRecord[] = [],
  ) {
    super(code);
    this.name = "PipelineError";
  }
}
const unknown = (text: string): GroundedStatement => ({
  text,
  kind: "unknown",
  evidenceIds: [],
  confidence: "low",
  rationale: "",
  limitation: text,
});
function emptyTour(s: PipelineOptions["snapshot"], tourId: string): Tour {
  return {
    tourId,
    tourRevisionSha: s.headSha,
    title: unknown("추천 읽기 경로를 생성하지 않았다."),
    rationale: unknown(
      "근거가 부족하거나 선택 코드 작업으로 투어를 요청하지 않았다.",
    ),
    summary: unknown("투어 미수행은 코드 안전성 판단이 아니다."),
    steps: [],
    storyEdges: [],
  };
}
function withoutInference(
  s: PipelineOptions["snapshot"],
  missing: string,
): V3Output {
  return {
    schemaVersion: "3",
    snapshotId: s.snapshotId,
    analysisStatus: "insufficient_context",
    limitations: [unknown(missing)],
    missingContext: [],
    overview: Object.fromEntries(
      [
        "oneLiner",
        "problem",
        "statedIntent",
        "inferredIntent",
        "previousBehavior",
        "newBehavior",
        "strategy",
        "nonGoals",
      ].map((k) => [k, unknown(missing)]),
    ) as SynthesisOutput["overview"],
    changeGroups: [],
    phaseSummaries: [],
    requirements: [],
    requirementMappings: [],
    codeExplanations: [],
    discrepancies: [],
    inferredEdgeSuggestions: [],
    reviewQuestions: [],
    tour: emptyTour(s, "tour:not-generated:" + s.snapshotId),
  };
}
function applyOmissions<
  T extends {
    analysisStatus: string;
    limitations: GroundedStatement[];
    missingContext: V3Output["missingContext"];
  },
>(a: T, omissions: Omission[]): T {
  if (!omissions.length) return a;
  if (a.analysisStatus === "complete") a.analysisStatus = "partial";
  a.limitations.push(
    unknown(
      `분석 문맥 누락 ${omissions.length}건. 전체 목록은 coverage에 보존된다.`,
    ),
  );
  for (const x of omissions.slice(0, 30))
    a.missingContext.push({
      target: x.target.slice(0, 512),
      reason: unknown(x.reason),
      purpose: unknown(x.purpose),
    });
  // Provider limits remain bounded; original model omissions are never erased.
  return a;
}
export function pipelineCacheKey(
  options: Pick<
    PipelineOptions,
    "snapshot" | "providerId" | "model" | "versions"
  >,
  stage: PipelineStage,
  schema: object,
  context: StageContext,
  prompt = trustedPrompt(stage),
): string {
  const s = options.snapshot;
  return (
    "v3:" +
    digest(
      JSON.stringify({
        stage,
        snapshotId: s.snapshotId,
        connectionId: s.connectionId,
        accountContextId: s.accountContextId,
        repositoryId: s.repositoryId,
        prNumber: s.prNumber,
        baseSha: s.baseSha,
        headSha: s.headSha,
        prMetadataHash: s.prMetadataHash,
        jiraSnapshotHashes: s.jiraSnapshotHashes,
        sourceHashes: s.sourceEvidence.map((e) => [
          e.id,
          e.contentHash,
          e.version,
        ]),
        parser: s.coverage.parser,
        providerId: options.providerId,
        model: options.model,
        versions: {
          prompt: PROMPT_VERSION,
          schema: "3",
          parser: "v3-parser-1",
          planner: PLAN_VERSION,
          ...options.versions,
        },
        promptHash: digest(prompt),
        schemaHash: digest(JSON.stringify(schema)),
        contextHash: digest(JSON.stringify(context)),
      }),
    )
  );
}
export async function runPipeline(
  options: PipelineOptions,
): Promise<PipelineResult> {
  requireValid(
    ["codex", "claude"].includes(options.providerId) &&
      /^[-a-zA-Z0-9_.:/]{1,120}$/.test(options.model) &&
      typeof options.runner === "function",
    "explicit provider/model and trusted server runner required",
  );
  if (options.signal?.aborted)
    throw new PipelineError("cancelled", "cancelled");
  const startedAt = new Date().toISOString(),
    started = performance.now(),
    s = options.snapshot;
  const plan = planContext(s, options.scope, options.budgets),
    omissions = [...plan.omissions],
    stages: StageRecord[] = [],
    completed: { chunk: ContextChunk; output: ChunkOutput }[] = [];
  const transmitted = new Set<string>(),
    currentTransmitted = new Set<string>();
  const accountContext = (context: StageContext, current: boolean) => {
    for (const id of [
      ...context.bundle.code.map((x) => x.evidence.id),
      ...context.bundle.sources.map((e) => e.id),
    ]) {
      transmitted.add(id);
      if (current) currentTransmitted.add(id);
    }
  };
  const coverage: PipelineCoverage = {
    unit: "analysis_tasks",
    discovered: plan.discovered,
    retrieved: plan.retrieved,
    plannedChunks: plan.chunks.length,
    analyzedChunks: 0,
    failedChunks: 0,
    notStartedChunks: plan.chunks.length,
    synthesizedChunkIds: [],
    citedEvidenceIds: [],
    transmittedEvidenceIds: [],
    currentRunTransmittedEvidenceIds: [],
    omitted: [],
    unavailable: [],
    snapshotCoverage: structuredClone(s.coverage),
    targetTestsExecuted: false,
    externalCIQueried: false,
  };
  const refresh = () => {
    coverage.transmittedEvidenceIds = [...transmitted];
    coverage.currentRunTransmittedEvidenceIds = [...currentTransmitted];
    coverage.analyzedChunks = stages.filter(
      (x) => x.stage === "chunk" && x.status === "validated",
    ).length;
    coverage.failedChunks = stages.filter(
      (x) => x.stage === "chunk" && x.status === "failed",
    ).length;
    coverage.notStartedChunks = plan.chunks.filter(
      (c) => !stages.some((x) => x.taskId === c.taskId),
    ).length;
    coverage.omitted = omissions.filter((o) => o.category === "omitted");
    coverage.unavailable = omissions.filter(
      (o) => o.category === "unavailable",
    );
  };
  const emit = (e: Parameters<NonNullable<PipelineOptions["onEvent"]>>[0]) => {
    try {
      options.onEvent?.(e);
    } catch {
      /* UI observers cannot change validation or execution */
    }
  };
  const ensure = () => {
    if (options.signal?.aborted) {
      refresh();
      throw new PipelineError("cancelled", "cancelled", coverage, stages);
    }
    if (performance.now() - started >= plan.budgets.totalTimeoutMs) {
      refresh();
      throw new PipelineError("pipeline_timeout", "failed", coverage, stages);
    }
  };
  let calls = 0;
  const bounded = async <T>(
    fn: (signal: AbortSignal) => Promise<T> | T,
  ): Promise<T> => {
    ensure();
    const ctrl = new AbortController(),
      callStarted = performance.now(),
      remaining = plan.budgets.totalTimeoutMs - (callStarted - started);
    const timeout = Math.min(plan.budgets.callTimeoutMs, remaining),
      deadline = callStarted + timeout,
      timer = setTimeout(() => ctrl.abort(), timeout);
    const onAbort = () => ctrl.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const ensureCall = () => {
      // A synchronous callback or microtask chain can starve the timer. Check
      // elapsed time on both resolution and rejection, and notify the runner.
      if (options.signal?.aborted || performance.now() >= deadline)
        ctrl.abort();
      ensure(); // Cancellation and the total deadline take precedence.
      if (ctrl.signal.aborted) {
        refresh();
        throw new PipelineError("call_timeout", "failed", coverage, stages);
      }
    };
    let rejectAbort: () => void = () => {};
    try {
      const interrupted = new Promise<never>((_, reject) => {
        rejectAbort = () =>
          reject(
            new PipelineError(
              options.signal?.aborted ? "cancelled" : "call_timeout",
              options.signal?.aborted ? "cancelled" : "failed",
              coverage,
              stages,
            ),
          );
        ctrl.signal.addEventListener("abort", rejectAbort, { once: true });
      });
      const value = await Promise.race([
        Promise.resolve().then(() => fn(ctrl.signal)),
        interrupted,
      ]);
      ensureCall();
      return value;
    } catch (error) {
      ensureCall();
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      ctrl.signal.removeEventListener("abort", rejectAbort);
    }
  };
  const packet = (
    bundle: ContextBundle,
    stage: PipelineStage,
    taskId: string,
  ): StageContext => ({
    bundle,
    task: {
      taskId,
      kind: stage,
      tourRevisionSha: s.headSha,
      allowHistoricalSteps: !!options.allowHistoricalSteps,
      commitOrder:
        stage === "chunk"
          ? bundle.phases
              .filter((p) => p.sha !== s.baseline.sha)
              .map((p) => p.sha)
          : plan.commitOrder,
    },
    summaries: [],
    omissions: {
      total: stage === "chunk" ? 0 : omissions.length,
      items: stage === "chunk" ? [] : omissions.slice(0, 30),
    },
    executionEvidence: { targetTestsExecuted: false, externalCIQueried: false },
  });
  const invoke = async (
    stage: PipelineStage,
    taskId: string,
    context: StageContext,
    schema: object,
  ): Promise<any> => {
    ensure();
    const limit =
      stage === "chunk"
        ? plan.budgets.maxChunkBytes + 8000
        : plan.budgets.maxSynthesisBytes;
    requireValid(bytes(context) <= limit, "stage context byte limit");
    const key = pipelineCacheKey(options, stage, schema, context),
      record: StageRecord = {
        stage,
        taskId,
        cacheKey: key,
        contextHash: digest(JSON.stringify(context)),
        cacheHit: false,
        status: "failed",
        metadata: null,
      };
    const validate = (value: unknown) => {
      if (stage === "audit") {
        requireValid(context.candidate, "audit candidate");
        validateAuditOutput(
          value,
          context.candidate as V3Output,
          context.bundle,
        );
      } else
        validateStage(value, stage, s, context.bundle, {
          allowHistoricalSteps: options.allowHistoricalSteps,
          maxOutputBytes:
            stage === "chunk"
              ? Math.min(plan.budgets.maxOutputBytes, 32000)
              : plan.budgets.maxOutputBytes,
        });
      if (stage === "chunk")
        requireValid(
          (value as ChunkOutput).taskId === taskId,
          "chunk taskId mismatch",
        );
      if (stage === "tour") {
        requireValid(
          (value as TourOutput).tour.tourId === context.task.tourId,
          "tourId mismatch",
        );
        requireValid(context.candidate, "tour synthesis candidate");
        validateV3Output(
          { ...context.candidate, tour: (value as TourOutput).tour },
          s,
          context.bundle,
          {
            allowHistoricalSteps: options.allowHistoricalSteps,
            maxOutputBytes: plan.budgets.maxOutputBytes,
          },
        );
      }
    };
    const validateMetadata = (m: RunnerMetadata) =>
      requireValid(
        m &&
          typeof m === "object" &&
          (!m.providerId || m.providerId === options.providerId) &&
          (!m.model || m.model === options.model) &&
          m.fallbackUsed !== true,
        "runner engine mismatch/fallback forbidden",
      );
    if (options.cache && !options.cache.bypass) {
      let stored: unknown;
      try {
        stored = await bounded(() => options.cache!.get(key));
      } catch {
        ensure();
        emit({ type: "cache_unavailable", stage, taskId });
      }
      if (stored)
        try {
          const entry = stored as CacheEntry;
          requireValid(
            entry.cacheVersion === "3" &&
              entry.key === key &&
              Number.isFinite(entry.expiresAt) &&
              entry.expiresAt > Date.now() &&
              entry.createdAt <= Date.now(),
            "cache identity/expiry",
          );
          validate(entry.output);
          validateMetadata(entry.metadata);
          accountContext(context, false);
          record.cacheHit = true;
          record.status = "validated";
          record.metadata = structuredClone(entry.metadata);
          stages.push(record);
          emit({ type: "cache_hit", stage, taskId });
          return structuredClone(entry.output);
        } catch {
          emit({ type: "cache_rejected", stage, taskId });
        }
    }
    if (calls >= plan.budgets.maxCalls)
      throw new PipelineError(
        "call_budget_exhausted",
        "failed",
        coverage,
        stages,
      );
    calls++;
    accountContext(context, true);
    emit({ type: "started", stage, taskId });
    try {
      const result = await bounded((signal) =>
        options.runner({
          stage,
          taskId,
          providerId: options.providerId,
          model: options.model,
          schema,
          context: structuredClone(context),
          trustedPrompt: trustedPrompt(stage),
          signal,
          onEvent: (event) =>
            emit({ type: "runner_event", stage, taskId, event }),
        }),
      );
      validate(result.output);
      validateMetadata(result.metadata);
      record.status = "validated";
      record.metadata = structuredClone(result.metadata);
      stages.push(record);
      emit({ type: "validated", stage, taskId });
      if (options.cache) {
        const ttl = options.cache.ttlMs ?? 600000;
        requireValid(
          Number.isSafeInteger(ttl) && ttl > 0 && ttl <= 86400000,
          "cache TTL must be finite <= 24h",
        );
        const entry: CacheEntry = {
          cacheVersion: "3",
          key,
          createdAt: Date.now(),
          expiresAt: Date.now() + ttl,
          output: structuredClone(result.output),
          metadata: structuredClone(result.metadata),
        };
        try {
          await bounded(() => options.cache!.set(key, entry));
        } catch {
          ensure();
          emit({ type: "cache_unavailable", stage, taskId });
        }
      }
      return structuredClone(result.output);
    } catch (error) {
      if (!stages.includes(record)) stages.push(record);
      emit({ type: "failed", stage, taskId });
      ensure();
      throw error;
    }
  };
  const omission = (target: string, reason: string) =>
    omissions.push({
      target,
      reason,
      category: "omitted",
      purpose: "grounded synthesis and head reading tour",
    });
  for (const chunk of plan.chunks) {
    ensure();
    try {
      const output = await invoke(
        "chunk",
        chunk.taskId,
        packet(chunk.context, "chunk", chunk.taskId),
        chunkOutputSchema,
      );
      completed.push({ chunk, output });
      coverage.analyzedChunks++;
      if (output.analysisStatus !== "complete")
        omission(chunk.taskId, "chunk_" + output.analysisStatus);
    } catch (error) {
      ensure();
      if (
        error instanceof PipelineError &&
        error.code === "call_budget_exhausted"
      ) {
        for (const pending of plan.chunks.filter(
          (c) => !stages.some((x) => x.taskId === c.taskId),
        ))
          omission(pending.taskId, "not_started_call_budget");
        break;
      }
      coverage.failedChunks++;
      omission(chunk.taskId, "chunk_failed");
    }
  }
  let bundle = emptyContext(s, options.scope),
    output: V3Output;
  if (!completed.length) {
    refresh();
    if (coverage.failedChunks)
      throw new PipelineError("all_chunks_failed", "failed", coverage, stages);
    output = withoutInference(
      s,
      "전송 가능한 원문 근거가 없어 분석 엔진을 호출하지 않았다.",
    );
    applyOmissions(output, omissions);
  } else {
    let synthesisContext = packet(
      bundle,
      "synthesis",
      "synthesis:" + s.snapshotId,
    );
    for (const { chunk, output: summary } of completed) {
      const next = mergeContexts(s, options.scope, [bundle, chunk.context]);
      const candidate = {
        ...synthesisContext,
        bundle: next,
        summaries: [
          ...synthesisContext.summaries,
          { taskId: chunk.taskId, output: summary },
        ],
      };
      if (bytes(candidate) <= plan.budgets.maxSynthesisBytes - 12000) {
        bundle = next;
        synthesisContext = candidate;
        coverage.synthesizedChunkIds.push(chunk.taskId);
      } else omission(chunk.taskId, "synthesis_byte_limit");
    }
    synthesisContext.omissions = {
      total: omissions.length,
      items: omissions.slice(0, 30),
    };
    if (!synthesisContext.summaries.length) {
      output = withoutInference(
        s,
        "통합 예산 안에 근거와 검증된 요약을 함께 전달할 수 없다.",
      );
      applyOmissions(output, omissions);
    } else {
      let synthesis: SynthesisOutput;
      try {
        synthesis = await invoke(
          "synthesis",
          synthesisContext.task.taskId,
          synthesisContext,
          synthesisOutputSchema,
        );
      } catch {
        ensure();
        refresh();
        throw new PipelineError("synthesis_failed", "failed", coverage, stages);
      }
      applyOmissions(synthesis, omissions);
      let tour = emptyTour(s, "tour:not-generated:" + s.snapshotId);
      if (
        options.scope.kind === "pr" &&
        bundle.code.some(
          (x) =>
            x.evidence.commitSha === s.headSha && x.evidence.side === "new",
        )
      ) {
        const taskId =
          "tour:" +
          digest(
            JSON.stringify({
              synthesis,
              provider: options.providerId,
              model: options.model,
              versions: options.versions,
              prompt: trustedPrompt("tour"),
            }),
          ).slice(0, 32);
        const context = {
          ...packet(bundle, "tour", taskId),
          candidate: synthesis,
        };
        context.task.tourId = taskId;
        if (bytes(context) <= plan.budgets.maxSynthesisBytes) {
          try {
            const result: TourOutput = await invoke(
              "tour",
              taskId,
              context,
              tourOutputSchema,
            );
            tour = result.tour;
            if (
              result.analysisStatus !== "complete" &&
              (synthesis.analysisStatus === "complete" ||
                result.analysisStatus === "insufficient_context")
            )
              synthesis.analysisStatus = result.analysisStatus;
            synthesis.limitations.push(...result.limitations);
            synthesis.missingContext.push(...result.missingContext);
          } catch {
            ensure();
            omission(taskId, "tour_failed");
            applyOmissions(synthesis, [omissions.at(-1)!]);
          }
        } else {
          omission(taskId, "tour_byte_limit");
          applyOmissions(synthesis, [omissions.at(-1)!]);
        }
      } else if (options.scope.kind === "pr") {
        omission("tour", "head_code_unavailable");
        applyOmissions(synthesis, [omissions.at(-1)!]);
      }
      output = { ...synthesis, tour };
    }
  }
  ensure();
  refresh();
  validateV3Output(output, s, bundle, {
    allowHistoricalSteps: options.allowHistoricalSteps,
    maxOutputBytes: plan.budgets.maxOutputBytes,
    omissions,
  });
  let semanticAudit: SemanticAudit = { status: "not_performed" };
  if (options.audit?.enabled) {
    const context = {
      ...packet(bundle, "audit", "audit:" + s.snapshotId),
      candidate: output,
    };
    let audit: AuditOutput | undefined;
    // Only acquisition/schema failures may use the optional soft-failure policy.
    try {
      requireValid(
        bundle.code.length || bundle.sources.length,
        "audit original evidence unavailable",
      );
      audit = await invoke(
        "audit",
        context.task.taskId,
        context,
        auditOutputSchema,
      );
    } catch {
      ensure();
      semanticAudit = {
        status: "failed",
        failureCode: "semantic_audit_failed",
      };
      if (options.audit.failurePolicy === "fail") {
        const failure = new PipelineError(
          "semantic_audit_failed",
          "failed",
          coverage,
          stages,
        );
        failure.semanticAudit = semanticAudit;
        throw failure;
      }
      if (output.analysisStatus === "complete")
        output.analysisStatus = "partial";
      output.limitations.push(
        unknown(
          "선택적 의미 점검이 실패했다. 설명의 의미적 지지는 확인되지 않았다.",
        ),
      );
    }
    if (audit) {
      // A valid audit has disputed claims: never fall back to the candidate if
      // its transformations violate a structural invariant (e.g. history).
      semanticAudit = { status: "performed", output: audit };
      try {
        const applied = applySemanticAudit(output, audit);
        semanticAudit = applied.semanticAudit;
        if (semanticAudit.status === "rejected") {
          const error = new PipelineError(
            "semantic_audit_rejected",
            "failed",
            coverage,
            stages,
          );
          error.semanticAudit = semanticAudit;
          throw error;
        }
        validateV3Output(applied.output, s, bundle, {
          allowHistoricalSteps: options.allowHistoricalSteps,
          maxOutputBytes: plan.budgets.maxOutputBytes,
          omissions,
        });
        output = applied.output;
      } catch (error) {
        ensure();
        if (
          error instanceof PipelineError &&
          error.code === "semantic_audit_rejected"
        )
          throw error;
        const failure = new PipelineError(
          "final_validation_failed",
          "failed",
          coverage,
          stages,
        );
        failure.semanticAudit = {
          ...semanticAudit,
          status: "failed",
          failureCode: "final_validation_failed",
        };
        throw failure;
      }
    }
  }
  try {
    validateV3Output(output, s, bundle, {
      allowHistoricalSteps: options.allowHistoricalSteps,
      maxOutputBytes: plan.budgets.maxOutputBytes,
      omissions,
    });
  } catch {
    const error = new PipelineError(
      "final_validation_failed",
      "failed",
      coverage,
      stages,
    );
    error.semanticAudit = semanticAudit;
    throw error;
  }
  coverage.citedEvidenceIds = referencedEvidenceIds(output);
  refresh();
  emit({ type: "completed" });
  const evidence = [
    ...new Map(
      [
        ...plan.chunks.flatMap((c) => c.context.code.map((x) => x.evidence)),
        ...bundle.code.map((x) => x.evidence),
      ].map((e) => [e.id, e]),
    ).values(),
  ];
  return {
    validationContext: bundle,
    output,
    processStatus: "succeeded",
    metadata: {
      providerId: options.providerId,
      model: options.model,
      stages,
      fallbackUsed: false,
      startedAt,
      finishedAt: new Date().toISOString(),
    },
    deterministicValidation: {
      status: "passed",
      scope: "schema-and-transmitted-evidence-references",
      semanticSupportVerified: false,
    },
    semanticAudit,
    coverage,
    selectionEvidence:
      options.scope.kind === "code"
        ? evidence.filter((e) =>
            plan.chunks.some((c) =>
              c.context.code.some(
                (x) => x.origin === "selection" && x.evidence.id === e.id,
              ),
            ),
          )
        : [],
    evidence,
    commitOrder: plan.commitOrder,
  };
}
