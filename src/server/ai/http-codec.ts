// Pure request/response codec for the OpenAI-compatible HTTP engine. No
// network access lives here: bodies are built and response texts are parsed
// or classified as data, so the transport and runner own all I/O policy.
// Nothing in this file may retain provider-supplied model/identity strings,
// raw error text, or credential material.

import {
  HTTP_LIMITS,
  type ResponseMode,
  type TokenLimitField,
} from "../../ai-contract.ts";
import { AIError, type AIErrorCode } from "./errors.ts";

type JsonObject = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const DEFAULT_SCHEMA_NAME = "analysis_result";

const SCHEMA_CONTRACT_GUIDANCE =
  "Respond with exactly one JSON value that conforms to the JSON Schema " +
  "below. Return the JSON value only: no markdown fences, no commentary, " +
  "no text before or after it.";

/**
 * Appends the schema contract guidance and the canonical schema text to a
 * trusted system prompt. Every response mode carries this guidance so the
 * provider contract never depends on response_format support alone.
 */
export function systemPromptWithSchema(
  trustedPrompt: string,
  canonicalSchema: object,
): string {
  let schemaJson: string;
  try {
    schemaJson = JSON.stringify(canonicalSchema);
  } catch {
    throw new AIError("schema_invalid");
  }
  return `${trustedPrompt}\n\n${SCHEMA_CONTRACT_GUIDANCE}\n\n${schemaJson}`;
}

/**
 * Serializes one chat completions request body. The body carries exactly
 * `model`, `messages`, `stream:false`, a single token-limit field, and —
 * when the mode calls for it — `response_format`. `tools`, `tool_choice`,
 * `functions` and `function_call` are never emitted. A provider schema over
 * the byte cap fails as `input_limit` before serialization.
 */
export function buildChatBody(input: {
  model: string;
  system: string;
  user: string;
  responseMode: ResponseMode;
  tokenLimitField: TokenLimitField;
  maxOutputTokens: number;
  providerSchema?: object;
  schemaName?: string;
}): string {
  if (input.providerSchema !== undefined) {
    let schemaBytes: number;
    try {
      schemaBytes = Buffer.byteLength(
        JSON.stringify(input.providerSchema),
        "utf8",
      );
    } catch {
      throw new AIError("schema_invalid");
    }
    if (schemaBytes > HTTP_LIMITS.schemaBytes) throw new AIError("input_limit");
  }

  const body: JsonObject = {
    model: input.model,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    stream: false,
    [input.tokenLimitField]: input.maxOutputTokens,
  };

  if (input.responseMode === "json_schema") {
    if (input.providerSchema === undefined)
      throw new AIError("invalid_request");
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: input.schemaName ?? DEFAULT_SCHEMA_NAME,
        strict: true,
        schema: input.providerSchema,
      },
    };
  } else if (input.responseMode === "json_object") {
    body.response_format = { type: "json_object" };
  }
  // prompt_json sends no response_format; the schema contract lives in the
  // system prompt for every mode.

  try {
    return JSON.stringify(body);
  } catch {
    throw new AIError("invalid_request");
  }
}

export type ParsedCompletion = {
  output: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
};

/**
 * Parses a successful chat completion body. The single choice's assistant
 * `content` is JSON-parsed verbatim — code fences, surrounding prose, or
 * partial extraction are never repaired and fail as `invalid_json`. Any
 * tool-call field or refusal fails the whole completion, and a provider
 * echo of the API key discards the result. Provider model/id strings are
 * not preserved; usage is projected to numeric token counts only.
 */
export function parseSuccess(
  bodyText: string,
  opts: { apiKey: string },
): ParsedCompletion {
  let envelope: unknown;
  try {
    envelope = JSON.parse(bodyText);
  } catch {
    throw new AIError("invalid_envelope");
  }
  if (!isRecord(envelope)) throw new AIError("invalid_envelope");
  const choices = envelope.choices;
  if (!Array.isArray(choices) || choices.length !== 1)
    throw new AIError("invalid_envelope");
  const message = isRecord(choices[0]) ? choices[0].message : undefined;
  if (!isRecord(message)) throw new AIError("invalid_envelope");
  if (message.tool_calls != null || message.function_call != null)
    throw new AIError("tool_use_forbidden");
  if (message.refusal != null) throw new AIError("provider_failed");
  const content = message.content;
  if (typeof content !== "string") throw new AIError("invalid_envelope");
  if (opts.apiKey.length > 0 && content.includes(opts.apiKey))
    throw new AIError("provider_failed");
  let output: unknown;
  try {
    output = JSON.parse(content);
  } catch {
    throw new AIError("invalid_json");
  }
  const result: ParsedCompletion = { output };
  const usage = envelope.usage;
  if (isRecord(usage)) {
    const projected: NonNullable<ParsedCompletion["usage"]> = {};
    if (Number.isFinite(usage.prompt_tokens))
      projected.inputTokens = usage.prompt_tokens as number;
    if (Number.isFinite(usage.completion_tokens))
      projected.outputTokens = usage.completion_tokens as number;
    if (
      projected.inputTokens !== undefined ||
      projected.outputTokens !== undefined
    )
      result.usage = projected;
  }
  return result;
}

export type HttpFailureClass = {
  code: AIErrorCode;
  retryable: boolean;
  /** Request field the provider explicitly rejected, when identified. */
  unsupported?:
    "response_format" | "json_schema" | "json_object" | "max_completion_tokens";
};

type UnsupportedField = NonNullable<HttpFailureClass["unsupported"]>;

const UNSUPPORTED_CODES = new Set([
  "unsupported_parameter",
  "unsupported_param",
  "unsupported_value",
]);
const UNSUPPORTED_HINT =
  /unsupported|not support|unknown param|unrecognized param/i;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const mentionsQuota = (value: string | undefined): boolean =>
  value !== undefined && value.toLowerCase().includes("quota");

/** Extracts the structured error fields from an OpenAI-style error body.
 * Provider `message`/`error` text is read only to confirm an explicit
 * param-level rejection or a missing-model 404; it is never copied into
 * the returned classification. */
function errorFields(bodyText: string): {
  code?: string;
  type?: string;
  param?: string;
  message?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const error = isRecord(parsed.error) ? parsed.error : parsed;
  return {
    code: asString(error.code),
    type: asString(error.type),
    param: asString(error.param),
    // Ollama-style bodies carry the provider text as a bare `error` string.
    message: asString(error.message) ?? asString(parsed.error),
  };
}

/** Maps a provider `param` value to the request field it names. Only param
 * may nominate a field — message text alone never produces `unsupported`. */
function unsupportedField(
  param: string | undefined,
): UnsupportedField | undefined {
  if (param === undefined) return undefined;
  const p = param.toLowerCase();
  if (p === "max_completion_tokens" || p.startsWith("max_completion_tokens."))
    return "max_completion_tokens";
  if (
    p !== "json_schema" &&
    p !== "json_object" &&
    p !== "response_format" &&
    !p.startsWith("response_format.")
  )
    return undefined;
  if (p.includes("json_schema")) return "json_schema";
  if (p.includes("json_object")) return "json_object";
  return "response_format";
}

const hasInvalidMarker = (
  code: string | undefined,
  type: string | undefined,
): boolean =>
  (code !== undefined && code.toLowerCase().includes("invalid")) ||
  (type !== undefined && type.toLowerCase().includes("invalid"));

/** A single error field must tie "model" to an absence signal before a 404
 * can be read as a missing model; a bare routing 404 is not enough. */
const indicatesMissingModel = (value: string | undefined): boolean =>
  value !== undefined &&
  /model/i.test(value) &&
  /not.?found|does not exist|unknown/i.test(value);

/**
 * Classifies a non-2xx HTTP response into a fixed failure code using the
 * status and structured error fields only. Message text can confirm a
 * param-level rejection but can never nominate one, so a generic 400 that
 * merely mentions "response_format" stays `provider_failed`. The returned
 * value carries no provider text.
 */
export function classifyHttpFailure(
  status: number,
  bodyText: string,
): HttpFailureClass {
  const error = errorFields(bodyText);

  if (status === 401 || status === 403)
    return { code: "auth_invalid", retryable: false };
  if (status === 429) {
    const quota =
      error.code === "insufficient_quota" ||
      mentionsQuota(error.code) ||
      mentionsQuota(error.type);
    return quota
      ? { code: "quota_exceeded", retryable: false }
      : { code: "rate_limited", retryable: true };
  }
  if (error.code === "model_not_found")
    return { code: "model_unavailable", retryable: false };
  if (status === 404)
    // A 404 without a missing-model signal is a routing/base-URL problem,
    // not a model problem — still not retryable.
    return indicatesMissingModel(error.code) ||
      indicatesMissingModel(error.type) ||
      indicatesMissingModel(error.message)
      ? { code: "model_unavailable", retryable: false }
      : { code: "provider_unavailable", retryable: false };
  if (status === 413) return { code: "input_limit", retryable: false };
  if (status >= 500 && status <= 599)
    return { code: "provider_unavailable", retryable: true };

  if (status === 400 || status === 422) {
    // An explicit schema rejection is not a fallback signal: the field is
    // supported, the submitted schema itself was refused.
    if (
      error.code === "invalid_json_schema" ||
      (error.param !== undefined &&
        /^response_format\.json_schema(\.|$)/i.test(error.param) &&
        hasInvalidMarker(error.code, error.type))
    )
      return { code: "schema_invalid", retryable: false };

    const field = unsupportedField(error.param);
    if (field !== undefined) {
      const message = error.message?.toLowerCase();
      const names =
        field === "max_completion_tokens"
          ? ["max_completion_tokens"]
          : ["response_format", "json_schema", "json_object"];
      const codeSaysUnsupported =
        error.code !== undefined && UNSUPPORTED_CODES.has(error.code);
      const messageSaysUnsupported =
        message !== undefined &&
        UNSUPPORTED_HINT.test(message) &&
        names.some((name) => message.includes(name));
      if (codeSaysUnsupported || messageSaysUnsupported)
        return {
          code: "provider_failed",
          retryable: false,
          unsupported: field,
        };
    }
    return { code: "provider_failed", retryable: false };
  }

  return { code: "provider_failed", retryable: false };
}
