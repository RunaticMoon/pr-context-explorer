// Shared AI contract surface for browser and server bundles. Runtime imports
// of node modules or server code are forbidden here; AIErrorCode is a
// type-only import so it is erased at compile time.
import type { AIErrorCode } from "./server/ai/errors.ts";

export type LocalProviderId = "codex" | "claude";
export type ProviderId = LocalProviderId | "openai-compatible";

export function isLocalProviderId(value: unknown): value is LocalProviderId {
  return value === "codex" || value === "claude";
}

export type ResponseMode = "json_schema" | "json_object" | "prompt_json";
export type TokenLimitField = "max_completion_tokens" | "max_tokens";

export type HttpEngineVerification =
  | "not_checked"
  | "checking"
  | "verified"
  | "failed";

/** Public DTO for the HTTP engine; never carries credentials. */
export interface HttpEngineView {
  providerId: "openai-compatible";
  transport: "http";
  /** Random public identifier, safe to expose. */
  configId: string;
  revision: number;
  /** URL.host including port, excluding path. */
  host: string;
  model: string;
  hasApiKey: boolean;
  verification: HttpEngineVerification;
  blockers: AIErrorCode[];
  ready: boolean;
}

export const VALIDATION_REASON_CODES = [
  "evidence_outside_context",
  "phase_outside_context",
  "file_outside_context",
  "revision_mismatch",
  "duplicate_reference",
  "statement_evidence_required",
  "inference_rationale_required",
  "unknown_limitation_required",
  "execution_claim_forbidden",
  "task_id_mismatch",
  "tour_id_mismatch",
  "runner_identity_mismatch",
  "audit_reference_invalid",
  "output_schema_mismatch",
  "validation_failed",
] as const;
export type ValidationReasonCode = (typeof VALIDATION_REASON_CODES)[number];

export interface SchemaDiagnostic {
  /** Ajv keyword allowlist entry only. */
  keyword: string;
  /** Canonical property names only; array positions are "*". */
  instancePath: string;
}

export interface FailureDetail {
  code: AIErrorCode | "validation_failed" | "unknown";
  reasonCode?: ValidationReasonCode;
  schemaErrors?: SchemaDiagnostic[];
}

/** Public projection of the server-side ProviderCallBudget. */
export interface ProviderCallBudgetView {
  used: number;
  limit: number;
}

export const HTTP_LIMITS = {
  requestBytes: 1024 * 1024,
  schemaBytes: 64 * 1024,
  responseBytes: 4 * 1024 * 1024,
  errorBodyBytes: 64 * 1024,
  defaultMaxOutputTokens: 8192,
  maxOutputTokens: 32768,
  maxAttemptsPerStage: 4,
  maxRetries: 2,
  stageDeadlineMs: 120_000,
  pipelineDeadlineMs: 900_000,
  retryAfterCapMs: 30_000,
  verifyDeadlineMs: 15_000,
  verifyMaxOutputTokens: 128,
  apiKeyMaxBytes: 8192,
  planTtlMs: 600_000,
} as const;

export function httpMaxProviderCalls(
  maxCalls: number,
  logicalSteps: number,
): number {
  return Math.min(maxCalls, 4 * logicalSteps);
}

export interface LogicalStepInput {
  chunks: number;
  kind: "pr" | "code";
  audit: boolean;
}

export function logicalStepCount({
  chunks,
  kind,
  audit,
}: LogicalStepInput): number {
  return (
    chunks +
    (chunks > 0 ? (kind === "pr" ? 2 : 1) : 0) +
    (chunks > 0 && audit ? 1 : 0)
  );
}
