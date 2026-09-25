import {
  VALIDATION_REASON_CODES,
  type FailureDetail,
  type SchemaDiagnostic,
  type ValidationReasonCode,
} from "../../ai-contract.ts";

export type AIErrorCode =
  | "managed_policy_unsupported"
  | "cancelled"
  | "timeout"
  | "inactivity_timeout"
  | "output_limit"
  | "input_limit"
  | "invalid_request"
  | "spawn_failed"
  | "callback_failed"
  | "cli_missing"
  | "unsupported_cli"
  | "sandbox_unavailable"
  | "auth_required"
  | "auth_invalid"
  | "quota_exceeded"
  | "rate_limited"
  | "model_unavailable"
  | "provider_unavailable"
  | "provider_failed"
  | "invalid_json"
  | "invalid_envelope"
  | "schema_invalid"
  | "schema_mismatch"
  | "tool_use_forbidden"
  | "network_denied";
const messages: Record<AIErrorCode, string> = {
  managed_policy_unsupported:
    "A local managed policy is present; this adapter cannot preserve it and refuses to omit it.",
  cancelled: "Analysis cancelled.",
  timeout: "Analysis exceeded its full deadline.",
  inactivity_timeout: "CLI output inactivity deadline exceeded.",
  output_limit: "CLI output exceeded the configured byte or event limit.",
  input_limit:
    "Input exceeds the configured limit; caller must explicitly chunk it.",
  invalid_request: "Invalid analysis configuration or request.",
  spawn_failed: "The CLI process could not start.",
  callback_failed: "The progress consumer failed.",
  cli_missing: "A supported native CLI executable was not found.",
  unsupported_cli:
    "CLI version or required safety capabilities are not verified.",
  sandbox_unavailable:
    "OS isolation is unavailable or failed its runtime probe; execution is blocked.",
  auth_required: "No authorized engine credential was supplied.",
  auth_invalid: "Engine authentication failed or expired.",
  quota_exceeded: "Engine billing or quota limit reached.",
  rate_limited: "Engine rate limit reached.",
  model_unavailable: "The selected model is unavailable.",
  provider_unavailable: "The selected provider is unavailable.",
  provider_failed: "The CLI reported a failed analysis.",
  invalid_json: "The CLI returned malformed JSON.",
  invalid_envelope: "The CLI event sequence or final envelope is invalid.",
  schema_invalid: "The caller supplied an unsupported or invalid JSON Schema.",
  schema_mismatch: "The analysis did not match the supplied JSON Schema.",
  tool_use_forbidden:
    "The CLI attempted a tool operation outside the analysis policy.",
  network_denied: "The egress policy rejected a destination.",
};
const REASON_CODES: ReadonlySet<string> = new Set(VALIDATION_REASON_CODES);
const DETAIL_CODES: ReadonlySet<string> = new Set([
  ...Object.keys(messages),
  "validation_failed",
  "unknown",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sanitizeSchemaErrors = (value: unknown): SchemaDiagnostic[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const out: SchemaDiagnostic[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { keyword, instancePath } = entry;
    if (typeof keyword !== "string" || typeof instancePath !== "string")
      continue;
    out.push({ keyword, instancePath: instancePath.slice(0, 160) });
    if (out.length >= 8) break;
  }
  return out.length ? out : undefined;
};

/** Projects an untrusted detail down to code, reasonCode and schemaErrors. */
const sanitizeDetail = (
  value: unknown,
  fallback: AIErrorCode,
): FailureDetail | undefined => {
  if (!isRecord(value)) return undefined;
  const detail: FailureDetail = {
    code:
      typeof value.code === "string" && DETAIL_CODES.has(value.code)
        ? (value.code as FailureDetail["code"])
        : fallback,
  };
  if (
    typeof value.reasonCode === "string" &&
    REASON_CODES.has(value.reasonCode)
  )
    detail.reasonCode = value.reasonCode as ValidationReasonCode;
  const schemaErrors = sanitizeSchemaErrors(value.schemaErrors);
  if (schemaErrors) detail.schemaErrors = schemaErrors;
  return detail;
};

/** Never include provider text, source text, credentials or raw OS errors here. */
export class AIError extends Error {
  /** Sanitized structural failure detail; carries no message/params/values. */
  public readonly detail?: FailureDetail;
  constructor(
    public readonly code: AIErrorCode,
    detail?: FailureDetail | { detail?: FailureDetail },
  ) {
    super(messages[code]);
    this.name = "AIError";
    const raw = isRecord(detail) && "detail" in detail ? detail.detail : detail;
    const clean = sanitizeDetail(raw, code);
    if (clean) this.detail = clean;
  }
}
