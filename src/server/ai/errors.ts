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
/** Never include provider text, source text, credentials or raw OS errors here. */
export class AIError extends Error {
  constructor(public readonly code: AIErrorCode) {
    super(messages[code]);
    this.name = "AIError";
  }
}
