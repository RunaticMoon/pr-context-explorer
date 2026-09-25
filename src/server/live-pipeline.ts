import { readFileSync, readdirSync } from "node:fs";
import { cacheKey, type LocalStore } from "./store.ts";
import type { Connection } from "./github.ts";
import {
  HTTP_LIMITS,
  httpMaxProviderCalls,
  logicalStepCount,
  type ProviderId,
} from "../ai-contract.ts";
import {
  createCallBudget,
  type ProviderCallBudget,
} from "./ai/call-budget.ts";
import {
  planContext,
  validateV3Output,
  validateAuditOutput,
  validateCodeEvidence,
  trustedPrompt,
  chunkOutputSchema,
  synthesisOutputSchema,
  tourOutputSchema,
  auditOutputSchema,
  v3OutputSchema,
  PROMPT_VERSION,
  PLAN_VERSION,
  type PipelineOptions,
  type PipelineResult,
  type PipelineCache,
  type Omission,
  type Scope,
  type LiveSnapshot,
} from "./analysis-v3/index.ts";

export type RunPolicy = { audit: boolean; allowHistoricalSteps: boolean };
export type SavedAnalysis = PipelineResult & {
  scope: Scope;
  cacheKey: string;
  policy: RunPolicy;
  cacheExpiresAt: number;
};
// Only trusted, app-owned adapter code is fingerprinted; never engine credentials.
const adapterFingerprint = cacheKey(
  readdirSync(new URL("./ai/", import.meta.url))
    .filter((n) => /\.(?:ts|js|cjs)$/.test(n))
    .sort()
    .map((n) => [
      n,
      readFileSync(new URL("./ai/" + n, import.meta.url), "utf8"),
    ]),
);
export const runtimeVersions = {
  prompt: PROMPT_VERSION,
  schema: "3",
  planner: PLAN_VERSION,
  engineFingerprint: adapterFingerprint,
};
const schemas = [
  chunkOutputSchema,
  synthesisOutputSchema,
  tourOutputSchema,
  auditOutputSchema,
  v3OutputSchema,
];
const prompts = ["chunk", "synthesis", "tour", "audit"].map((stage) =>
  trustedPrompt(stage as any),
);

export function parseScope(value: any): Scope {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("analysis scope required");
  const keys =
    value.kind === "pr"
      ? ["kind"]
      : [
          "kind",
          "commitSha",
          "fileId",
          "side",
          "lineStart",
          "lineEnd",
          "question",
        ];
  if (
    !["pr", "code"].includes(value.kind) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw Error("invalid scope fields");
  if (
    value.kind === "code" &&
    (!/^[a-f0-9]{40}$/.test(value.commitSha) ||
      typeof value.fileId !== "string" ||
      !["old", "new"].includes(value.side) ||
      !Number.isInteger(value.lineStart) ||
      !Number.isInteger(value.lineEnd) ||
      typeof value.question !== "string" ||
      value.question.length > 2000)
  )
    throw Error("invalid selected code scope");
  return structuredClone(value);
}
/** Public, credential-free engine descriptor for planning and cache identity. */
export type PlanEngine = {
  transport: "cli" | "http";
  providerId: ProviderId;
  model: string;
  host?: string;
  configId?: string;
  revision?: number;
  maxOutputTokens?: number;
};
// Project only non-secret identity fields; engine credentials never enter
// plans or cache keys.
function publicEngine(engine: PlanEngine) {
  const view: {
    transport: "cli" | "http";
    providerId: ProviderId;
    model: string;
    host?: string;
    configId?: string;
    revision?: number;
  } = {
    transport: engine.transport,
    providerId: engine.providerId,
    model: engine.model,
  };
  if (engine.host !== undefined) view.host = engine.host;
  if (engine.configId !== undefined) view.configId = engine.configId;
  if (engine.revision !== undefined) view.revision = engine.revision;
  return view;
}
export function analysisIdentity(
  s: LiveSnapshot,
  connection: Connection,
  scope: Scope,
  providerId: string,
  model: string,
  policy: RunPolicy,
  versions: PipelineOptions["versions"] = {},
  engine?: PlanEngine,
) {
  const plan = planContext(s, scope);
  return cacheKey({
    connection,
    snapshot: s.snapshotId,
    account: s.accountContextId,
    repository: s.repositoryId,
    pr: s.prNumber,
    base: s.baseSha,
    head: s.headSha,
    prMetadata: s.prMetadataHash,
    jira: s.jiraSnapshotHashes,
    parser: s.coverage.parser,
    scope,
    providerId,
    model,
    policy,
    versions: { ...runtimeVersions, ...versions },
    schemas,
    prompts,
    plan,
    ...(engine?.transport === "http" ? { engine: publicEngine(engine) } : {}),
  });
}
export function localPipelineCache(
  store: LocalStore,
  connection: Connection,
  bypass = false,
): PipelineCache {
  const key = (pipelineKey: string) => {
    if (!/^v3:[a-f0-9]{64}$/.test(pipelineKey))
      throw Error("invalid pipeline cache key");
    return cacheKey({ namespace: "grounded-v3", connection, pipelineKey });
  };
  return {
    ttlMs: Math.min(store.retentionMs, 600000),
    bypass,
    get: (k) => store.get("chunk", key(k)),
    set: (k, entry) => {
      store.put("chunk", key(k), entry);
    },
  };
}
export function validatePipelineResult(
  value: unknown,
  s: LiveSnapshot,
  scope: Scope,
  policy: RunPolicy,
): asserts value is PipelineResult {
  const r = value as PipelineResult;
  if (
    !r ||
    r.output?.schemaVersion !== "3" ||
    r.processStatus !== "succeeded" ||
    !r.validationContext ||
    cacheKey(r.validationContext.scope) !== cacheKey(scope) ||
    r.deterministicValidation?.status !== "passed" ||
    r.deterministicValidation.semanticSupportVerified !== false ||
    r.metadata?.fallbackUsed !== false
  )
    throw Error("invalid pipeline result envelope");
  const plan = planContext(s, scope);
  const permitted = new Map(
    plan.chunks.flatMap((c) =>
      c.context.code.map((x) => [x.evidence.id, x.evidence] as const),
    ),
  );
  for (const e of [
    ...r.evidence,
    ...r.selectionEvidence,
    ...r.validationContext.code.map((x) => x.evidence),
  ]) {
    validateCodeEvidence(e, s);
    if (cacheKey(permitted.get(e.id) || null) !== cacheKey(e))
      throw Error("projected evidence outside planned scope");
  }
  validateV3Output(r.output, s, r.validationContext, {
    allowHistoricalSteps: policy.allowHistoricalSteps,
    omissions: [...r.coverage.omitted, ...r.coverage.unavailable],
  });
  if (
    r.coverage.targetTestsExecuted !== false ||
    r.coverage.externalCIQueried !== false
  )
    throw Error("invented execution evidence");
  if (!policy.audit && r.semanticAudit.status !== "not_performed")
    throw Error("unrequested semantic audit");
  if (policy.audit && !["performed", "failed"].includes(r.semanticAudit.status))
    throw Error("requested audit not accounted for");
  if (r.semanticAudit.status === "performed") {
    if (
      !r.metadata.stages.some(
        (x) => x.stage === "audit" && x.status === "validated",
      )
    )
      throw Error("audit lacks validated stage");
    validateAuditOutput(r.semanticAudit.output, r.output, r.validationContext);
  }
}
export type TransmissionPlan = {
  snapshotId: string;
  scope: Scope;
  plannedChunks: number;
  maxProviderCalls: number;
  auditCalls: number;
  serializedChunkBytes: number;
  maxStageBytes: number;
  omissions: Omission[];
  note: string;
  logicalSteps?: number;
  maxOutputTokensPerCall?: number;
  totalOutputTokenReservation?: number;
  inputByteLimit?: number;
  engine?: ReturnType<typeof publicEngine>;
};
export function transmissionPlan(
  s: LiveSnapshot,
  scope: Scope,
  audit: boolean,
  engine?: PlanEngine,
): TransmissionPlan {
  const p = planContext(s, scope);
  const plan = {
    snapshotId: s.snapshotId,
    scope,
    plannedChunks: p.chunks.length,
    maxProviderCalls: Math.min(
      p.budgets.maxCalls,
      p.chunks.length +
        (p.chunks.length ? (scope.kind === "pr" ? 2 : 1) : 0) +
        (audit ? 1 : 0),
    ),
    auditCalls: audit ? 1 : 0,
    serializedChunkBytes: p.chunks.reduce(
      (n, c) => n + Buffer.byteLength(JSON.stringify(c.context)),
      0,
    ),
    maxStageBytes: p.budgets.maxSynthesisBytes,
    omissions: p.omissions,
    note: "Upper bound, not token price. Validated cache hits may reduce calls; synthesis/tour/audit can retransmit selected evidence. No model call from planning.",
  };
  if (engine?.transport !== "http") return plan;
  if (
    typeof engine.providerId !== "string" ||
    typeof engine.model !== "string"
  )
    throw Error("invalid HTTP engine descriptor");
  if (
    engine.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(engine.maxOutputTokens) || engine.maxOutputTokens < 1)
  )
    throw Error("invalid engine maxOutputTokens");
  const logicalSteps = logicalStepCount({
      chunks: p.chunks.length,
      kind: scope.kind,
      audit,
    }),
    maxProviderCalls = httpMaxProviderCalls(p.budgets.maxCalls, logicalSteps),
    maxOutputTokensPerCall = Math.min(
      engine.maxOutputTokens ?? HTTP_LIMITS.defaultMaxOutputTokens,
      HTTP_LIMITS.maxOutputTokens,
    );
  return {
    ...plan,
    logicalSteps,
    maxProviderCalls,
    maxOutputTokensPerCall,
    totalOutputTokenReservation: maxProviderCalls * maxOutputTokensPerCall,
    inputByteLimit: p.budgets.maxSynthesisBytes,
    engine: publicEngine(engine),
  };
}
/** Build the per-run HTTP call budget from a transmission plan. */
export function createPlanBudget(plan: {
  maxProviderCalls: number;
  maxOutputTokensPerCall?: number;
  totalOutputTokenReservation?: number;
}): ProviderCallBudget {
  const maxOutputTokensPerCall =
      plan.maxOutputTokensPerCall ?? HTTP_LIMITS.defaultMaxOutputTokens,
    totalOutputTokenLimit =
      plan.totalOutputTokenReservation ??
      plan.maxProviderCalls * maxOutputTokensPerCall;
  return createCallBudget({
    maxCalls: plan.maxProviderCalls,
    maxOutputTokensPerCall,
    // A zero-step plan still constructs: every reserve() rejects on the call cap.
    totalOutputTokenLimit: Math.max(1, totalOutputTokenLimit),
  });
}
