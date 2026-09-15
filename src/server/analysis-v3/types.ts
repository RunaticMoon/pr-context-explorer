import type { Evidence, Edge, Hunk } from "../git.ts";
import type { LiveSnapshot, SourceEvidence } from "../live-git.ts";
export type { LiveSnapshot, SourceEvidence, Evidence };
export type Scope =
  | { kind: "pr" }
  | {
      kind: "code";
      commitSha: string;
      fileId: string;
      side: "old" | "new";
      lineStart: number;
      lineEnd: number;
      question: string;
    };
export type AnalysisStatus = "complete" | "partial" | "insufficient_context";
export type Omission = {
  target: string;
  reason: string;
  purpose: string;
  category: "omitted" | "unavailable";
};
export type ContextCode = {
  evidence: Evidence;
  contentRef: string;
  origin:
    | "changed_hunk"
    | "changed_file"
    | "direct_import"
    | "selection"
    | "pr_baseline";
};
export type ContextHunk = Hunk & { originalId: string };
export type ContextBundle = {
  snapshotId: string;
  headSha: string;
  scope: Scope;
  sourceHashes: { prMetadataHash: string; jiraSnapshotHashes: string[] };
  phases: {
    sha: string;
    parents: string[];
    comparisonFromSha: string | null;
    comparisons: { fromSha: string; toSha: string; policy: string }[];
  }[];
  code: ContextCode[];
  blobs: Record<string, string>;
  sources: SourceEvidence[];
  sourceRoles: Record<string, "explicit_acceptance_criteria" | "source_text">;
  hunks: ContextHunk[];
  edges: (Edge & { revisionSha: string })[];
};
export type PipelineBudgets = {
  maxChunks: number;
  maxChunkBytes: number;
  maxTotalContextBytes: number;
  maxSynthesisBytes: number;
  maxOutputBytes: number;
  linesPerWindow: number;
  maxCalls: number;
  callTimeoutMs: number;
  totalTimeoutMs: number;
};
export type ContextChunk = {
  taskId: string;
  kind: "file" | "source";
  context: ContextBundle;
  contextHash: string;
};
export type ContextPlan = {
  version: string;
  snapshotId: string;
  scope: Scope;
  chunks: ContextChunk[];
  omissions: Omission[];
  commitOrder: string[];
  budgets: PipelineBudgets;
  discovered: number;
  retrieved: number;
  selectedEvidenceIds: string[];
};
export type GroundedStatement = {
  text: string;
  kind: "observed" | "inferred" | "unknown";
  evidenceIds: string[];
  confidence: "high" | "medium" | "low";
  rationale: string;
  limitation: string;
};

export type Question = {
  kind: "question";
  question: GroundedStatement;
  reason: GroundedStatement;
};
export type MissingContext = {
  target: string;
  reason: GroundedStatement;
  purpose: GroundedStatement;
};
export type Envelope = {
  schemaVersion: "3";
  snapshotId: string;
  analysisStatus: AnalysisStatus;
  limitations: GroundedStatement[];
  missingContext: MissingContext[];
};
export type Requirement = {
  id: string;
  sourceRole:
    | "explicit_acceptance_criteria"
    | "extracted_requirement"
    | "interpretation_proposal";
  sourceEvidenceIds: string[];
  statement: GroundedStatement;
};
export type RequirementMapping = {
  requirementId: string;
  status:
    | "supported_by_code"
    | "partial_support"
    | "not_demonstrated"
    | "contradicted"
    | "unknown";
  explanation: GroundedStatement;
  commitShas: string[];
  fileIds: string[];
  evidenceIds: string[];
  testEvidenceIds: string[];
};
export type InferredEdgeSuggestion = {
  id: string;
  fromFileId: string;
  toFileId: string;
  revisionSha: string;
  relationType:
    | "import_usage"
    | "possible_call"
    | "data_flow"
    | "test_relation"
    | "configuration_impact";
  evidenceSource: "inferred";
  explanation: GroundedStatement;
};
export type Discrepancy = {
  id: string;
  requirementIds: string[];
  sourceEvidenceIds: string[];
  codeEvidenceIds: string[];
  explanation: GroundedStatement;
  resolution: GroundedStatement;
};
export type NextReadingSuggestion = {
  fileId: string;
  targetRevisionSha: string;
  evidenceIds: string[];
  reason: GroundedStatement;
};
export type CodeExplanation = {
  id: string;
  fileId: string;
  targetRevisionSha: string;
  comparisonFromSha: string | null;
  selectedEvidenceIds: string[];
  contextKind: "changed_code" | "unchanged_context" | "selected_range";
  roleInPR: GroundedStatement;
  responsibility: GroundedStatement;
  inputsOutputs: GroundedStatement;
  behavior: GroundedStatement;
  beforeAfter: GroundedStatement;
  sideEffects: GroundedStatement;
  errorHandling: GroundedStatement;
  answerToQuestion: GroundedStatement;
  relationships: {
    kind: "static_graph" | "inferred_suggestion";
    referenceId: string;
    explanation: GroundedStatement;
  }[];
  requirementLinks: { requirementId: string; explanation: GroundedStatement }[];
  testEvidenceIds: string[];
  reviewQuestions: Question[];
  nextReadingSuggestions: NextReadingSuggestion[];
};
export type TourStep = {
  id: string;
  title: GroundedStatement;
  targetRevisionSha: string;
  comparisonFromSha: string | null;
  historical: boolean;
  historicalReason: GroundedStatement;
  prerequisiteStepIds: string[];
  whyNow: GroundedStatement;
  previousConnection: GroundedStatement;
  explanation: GroundedStatement;
  beforeAfter: GroundedStatement;
  relationToGoal: GroundedStatement;
  focusFileIds: string[];
  focusHunkIds: string[];
  focusEvidenceIds: string[];
  focusGraphEdgeIds: string[];
  requirementIds: string[];
  checkpointQuestions: Question[];
  nextTransition: GroundedStatement;
};
export type StoryEdge = {
  id: string;
  fromStepId: string;
  toStepId: string;
  relation: "next_reading";
  reason: GroundedStatement;
};
export type Tour = {
  tourId: string;
  tourRevisionSha: string;
  title: GroundedStatement;
  rationale: GroundedStatement;
  summary: GroundedStatement;
  steps: TourStep[];
  storyEdges: StoryEdge[];
};
export type SynthesisOutput = Envelope & {
  overview: Record<
    | "oneLiner"
    | "problem"
    | "statedIntent"
    | "inferredIntent"
    | "previousBehavior"
    | "newBehavior"
    | "strategy"
    | "nonGoals",
    GroundedStatement
  >;
  changeGroups: {
    id: string;
    title: GroundedStatement;
    purpose: GroundedStatement;
    fileIds: string[];
    commitShas: string[];
    evidenceIds: string[];
  }[];
  phaseSummaries: {
    commitSha: string;
    comparisonFromSha: string | null;
    title: GroundedStatement;
    before: GroundedStatement;
    changes: GroundedStatement;
    why: GroundedStatement;
    limitationsOfPhase: GroundedStatement;
    focusFileIds: string[];
    focusGraphEdgeIds: string[];
    focusHunkIds: string[];
  }[];
  requirements: Requirement[];
  requirementMappings: RequirementMapping[];
  codeExplanations: CodeExplanation[];
  discrepancies: Discrepancy[];
  inferredEdgeSuggestions: InferredEdgeSuggestion[];
  reviewQuestions: Question[];
};
export type V3Output = SynthesisOutput & { tour: Tour };
export type ChunkOutput = Envelope & {
  taskId: string;
  summary: GroundedStatement;
  findings: GroundedStatement[];
  codeExplanations: CodeExplanation[];
};
export type TourOutput = Envelope & { tour: Tour };
export type ValidationOptions = {
  allowHistoricalSteps?: boolean;
  maxOutputBytes?: number;
  omissions?: Omission[];
};

export type PipelineStage = "chunk" | "synthesis" | "tour" | "audit";
export type StageContext = {
  bundle: ContextBundle;
  task: {
    taskId: string;
    kind: PipelineStage;
    tourRevisionSha: string;
    tourId?: string;
    allowHistoricalSteps: boolean;
    commitOrder: string[];
  };
  summaries: { taskId: string; output: ChunkOutput }[];
  candidate?: SynthesisOutput | V3Output;
  omissions: { total: number; items: Omission[] };
  executionEvidence: { targetTestsExecuted: false; externalCIQueried: false };
};
export type RunnerMetadata = {
  providerId?: string;
  model?: string;
  fallbackUsed?: boolean;
  [key: string]: unknown;
};
export type RunnerRequest = {
  stage: PipelineStage;
  taskId: string;
  providerId: "codex" | "claude";
  model: string;
  schema: object;
  context: StageContext;
  trustedPrompt: string;
  signal: AbortSignal;
  onEvent: (event: unknown) => void;
};
export type PipelineRunner = (
  request: RunnerRequest,
) => Promise<{ output: unknown; metadata: RunnerMetadata }>;
export type CacheEntry = {
  cacheVersion: "3";
  key: string;
  createdAt: number;
  expiresAt: number;
  output: unknown;
  metadata: RunnerMetadata;
};
export type PipelineCache = {
  get: (key: string) => unknown | Promise<unknown>;
  set: (key: string, entry: CacheEntry) => void | Promise<void>;
  ttlMs?: number;
  bypass?: boolean;
};
export type PipelineEvent = {
  type:
    | "started"
    | "validated"
    | "cache_hit"
    | "cache_rejected"
    | "cache_unavailable"
    | "failed"
    | "completed"
    | "runner_event";
  stage?: PipelineStage;
  taskId?: string;
  event?: unknown;
};
export type PipelineCoverage = {
  unit: "analysis_tasks";
  discovered: number;
  retrieved: number;
  plannedChunks: number;
  analyzedChunks: number;
  failedChunks: number;
  notStartedChunks: number;
  synthesizedChunkIds: string[];
  citedEvidenceIds: string[];
  transmittedEvidenceIds: string[];
  currentRunTransmittedEvidenceIds: string[];
  omitted: Omission[];
  unavailable: Omission[];
  snapshotCoverage: LiveSnapshot["coverage"];
  targetTestsExecuted: false;
  externalCIQueried: false;
};
export type StageRecord = {
  stage: PipelineStage;
  taskId: string;
  cacheKey: string;
  contextHash: string;
  cacheHit: boolean;
  status: "validated" | "failed";
  metadata: RunnerMetadata | null;
};
export type PipelineOptions = {
  snapshot: LiveSnapshot;
  providerId: "codex" | "claude";
  model: string;
  scope: Scope;
  runner: PipelineRunner;
  signal?: AbortSignal;
  onEvent?: (event: PipelineEvent) => void;
  cache?: PipelineCache;
  audit?: { enabled: boolean; failurePolicy?: "fail" | "downgrade" };
  budgets?: Partial<PipelineBudgets>;
  allowHistoricalSteps?: boolean;
  versions?: {
    prompt?: string;
    schema?: string;
    parser?: string;
    planner?: string;
    engineFingerprint?: string;
  };
};
export type PipelineResult = {
  validationContext: ContextBundle;
  output: V3Output;
  processStatus: "succeeded";
  metadata: {
    providerId: string;
    model: string;
    stages: StageRecord[];
    fallbackUsed: false;
    startedAt: string;
    finishedAt: string;
  };
  deterministicValidation: {
    status: "passed";
    scope: "schema-and-transmitted-evidence-references";
    semanticSupportVerified: false;
  };
  semanticAudit: SemanticAudit;
  coverage: PipelineCoverage;
  selectionEvidence: Evidence[];
  evidence: Evidence[];
  commitOrder: string[];
};

export type AuditIssue = {
  targetJsonPointer: string;
  category:
    | "unsupported_claim"
    | "wrong_revision"
    | "source_code_conflict"
    | "static_promotion"
    | "execution_claim"
    | "overclaim"
    | "other";
  severity: "low" | "medium" | "high";
  reason: GroundedStatement;
  evidenceIds: string[];
  action: "reject" | "downgrade" | "needs_context";
};
export type AuditOutput = {
  schemaVersion: "3";
  snapshotId: string;
  assessedJsonPointers: string[];
  issues: AuditIssue[];
  unableToVerify: { targetJsonPointer: string; reason: GroundedStatement }[];
  scopeSummary: GroundedStatement;
};
export type SemanticAudit = {
  status: "not_performed" | "performed" | "failed" | "rejected";
  output?: AuditOutput;
  failureCode?: string;
  originalCandidateHash?: string;
  dispositions?: {
    targetJsonPointer: string;
    action: AuditIssue["action"];
    original: GroundedStatement;
  }[];
};
