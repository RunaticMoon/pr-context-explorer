// Runner for the OpenAI-compatible HTTP engine (C3/C4). This module owns the
// per-stage deadline, format/token-field negotiation, bounded retries and the
// support cache; single bounded POSTs live in http-transport.ts and request/
// response shaping plus failure classification live in http-codec.ts. The API
// key is pulled from the runtime's getApiKey() closure at each attempt and
// handed straight to the transport/codec — it is never stored in cache
// entries, metadata, events, or error text.

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  HTTP_LIMITS,
  type ResponseMode,
  type TokenLimitField,
} from "../../ai-contract.ts";
import type { ProviderCallBudget } from "./call-budget.ts";
import { safeSchemaErrors } from "./diagnostics.ts";
import { AIError, type AIErrorCode } from "./errors.ts";
import { compileOutputSchema, emitEvent } from "./events.ts";
import {
  buildChatBody,
  classifyHttpFailure,
  parseSuccess,
  systemPromptWithSchema,
} from "./http-codec.ts";
import { postCompletion } from "./http-transport.ts";
import { stripProviderNulls, toStrictProviderSchema } from "./strict-schema.ts";
import type {
  AnalysisRequest,
  AnalysisResult,
  HttpAnalysisMetadata,
  HttpRuntimeConfig,
} from "./types.ts";

export type HttpAnalysisRequest = Omit<
  AnalysisRequest,
  "providerId" | "config"
> & { providerId: "openai-compatible" };

type SupportedCombination = {
  responseMode: ResponseMode;
  tokenLimitField: TokenLimitField;
};

/** Negotiated (responseMode, tokenLimitField) per
 * (configId, revision, model, canonical schema digest). Holds no credential
 * material — the digest covers only the caller-supplied schema. */
const supportCache = new Map<string, SupportedCombination>();

/** Test hook: forgets every negotiated combination. */
export function resetHttpSupportCache(): void {
  supportCache.clear();
}

const RESPONSE_MODE_ORDER: readonly ResponseMode[] = [
  "json_schema",
  "json_object",
  "prompt_json",
];

const RETRY_BACKOFF_MS = [500, 1000] as const;
const JITTER_MS = 50;

function supportCacheKey(
  runtime: HttpRuntimeConfig,
  schema: object,
): string | undefined {
  try {
    const digest = createHash("sha256")
      .update(JSON.stringify(schema))
      .digest("hex");
    return `${runtime.configId}\n${runtime.revision}\n${runtime.model}\n${digest}`;
  } catch {
    return undefined;
  }
}

/** The mode to try after a clearly identified response_format rejection.
 * A rejected `json_object` field skips straight to prompt_json; anything
 * else advances one step from the mode that was sent. */
function nextResponseMode(
  current: ResponseMode,
  unsupported: "response_format" | "json_schema" | "json_object",
): ResponseMode | undefined {
  if (unsupported === "json_object")
    return current === "prompt_json" ? undefined : "prompt_json";
  const index = RESPONSE_MODE_ORDER.indexOf(current);
  return index >= 0 && index < RESPONSE_MODE_ORDER.length - 1
    ? RESPONSE_MODE_ORDER[index + 1]
    : undefined;
}

/** Cancellable retry backoff; abort rejects with `cancelled`. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AIError("cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal.aborted) {
      clearTimeout(timer);
      reject(new AIError("cancelled"));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs one analysis stage against an OpenAI-compatible chat completions
 * endpoint. At most HTTP_LIMITS.maxAttemptsPerStage transmissions are made,
 * counting format/token-field fallbacks, and at most maxRetries of those are
 * retryable-failure retries. The call budget is charged synchronously just
 * before each transmission. Successful combinations are cached so later calls
 * start at the last working format. Canonical Ajv validation is the final
 * output judge in every mode. All non-AIError exceptions leave as
 * `provider_failed`.
 */
export async function runHttpAnalysis(
  request: HttpAnalysisRequest,
  runtime: HttpRuntimeConfig,
  budget: ProviderCallBudget,
): Promise<AnalysisResult> {
  try {
    if (request.signal?.aborted) throw new AIError("cancelled");
    if (
      request.providerId !== "openai-compatible" ||
      runtime.providerId !== "openai-compatible" ||
      request.model !== runtime.model ||
      typeof request.trustedPrompt !== "string" ||
      request.trustedPrompt.length === 0 ||
      request.context === undefined ||
      !request.schema ||
      typeof request.schema !== "object" ||
      Array.isArray(request.schema) ||
      typeof runtime.baseUrl !== "string" ||
      runtime.baseUrl.length === 0
    )
      throw new AIError("invalid_request");
    const maxOutputTokens = runtime.maxOutputTokens;
    if (
      !Number.isSafeInteger(maxOutputTokens) ||
      maxOutputTokens < 1 ||
      maxOutputTokens > HTTP_LIMITS.maxOutputTokens
    )
      throw new AIError("invalid_request");

    const validate = compileOutputSchema(request.schema);
    const system = systemPromptWithSchema(
      request.trustedPrompt,
      request.schema,
    );
    let user: string;
    try {
      user = JSON.stringify(request.context);
    } catch {
      throw new AIError("invalid_request");
    }
    // The stored base URL is the full prefix; only the endpoint suffix is
    // appended (no "/v1" is ever inserted).
    const url = `${runtime.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const deadlineAt = Date.now() + HTTP_LIMITS.stageDeadlineMs;
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const signal = request.signal ?? new AbortController().signal;

    const cacheKey = supportCacheKey(runtime, request.schema);
    const cached =
      cacheKey === undefined ? undefined : supportCache.get(cacheKey);
    let responseMode: ResponseMode = cached?.responseMode ?? "json_schema";
    let tokenLimitField: TokenLimitField =
      cached?.tokenLimitField ?? "max_completion_tokens";
    let providerSchema: object | undefined;
    let formatFallbackUsed = false;
    let attempts = 0;
    let retries = 0;
    let lastCode: AIErrorCode = "provider_failed";

    emitEvent(request.onEvent, { type: "status", phase: "preparing" });
    emitEvent(request.onEvent, { type: "status", phase: "running" });

    for (;;) {
      if (attempts >= HTTP_LIMITS.maxAttemptsPerStage)
        throw new AIError(lastCode);
      attempts += 1;
      const body = buildChatBody({
        model: runtime.model,
        system,
        user,
        responseMode,
        tokenLimitField,
        maxOutputTokens,
        ...(responseMode === "json_schema"
          ? {
              providerSchema: (providerSchema ??= toStrictProviderSchema(
                request.schema,
              )),
            }
          : {}),
      });
      // The call budget is charged synchronously, just before transmission.
      budget.reserve(maxOutputTokens);
      const result = await postCompletion(
        {
          url,
          model: runtime.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          responseMode,
          tokenLimitField,
          maxOutputTokens,
          schema: request.schema,
          deadlineAt,
          apiKey: runtime.getApiKey(),
          body,
        },
        signal,
      );

      if (result.status >= 200 && result.status < 300) {
        emitEvent(request.onEvent, { type: "status", phase: "validating" });
        const parsed = parseSuccess(result.bodyText, {
          apiKey: runtime.getApiKey(),
        });
        // Strict mode forces optional properties to arrive as null; restore
        // canonical shape before canonical validation, in every mode.
        const output = stripProviderNulls(parsed.output, request.schema);
        if (!validate(output))
          throw new AIError("schema_mismatch", {
            code: "schema_mismatch",
            reasonCode: "output_schema_mismatch",
            schemaErrors: safeSchemaErrors(validate.errors, request.schema),
          });
        if (cacheKey !== undefined)
          supportCache.set(cacheKey, { responseMode, tokenLimitField });
        const usage: Record<string, number> = {};
        if (parsed.usage)
          for (const [key, value] of Object.entries(parsed.usage))
            if (typeof value === "number" && Number.isFinite(value))
              usage[key] = value;
        emitEvent(request.onEvent, { type: "status", phase: "completed" });
        const metadata: HttpAnalysisMetadata = {
          transport: "http",
          providerId: "openai-compatible",
          model: runtime.model,
          host: runtime.host,
          configId: runtime.configId,
          revision: runtime.revision,
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Math.round(performance.now() - started),
          usage,
          isolation: "not-applicable",
          responseMode,
          formatFallbackUsed,
          attempts,
          schemaValidated: true,
          referenceValidation: "caller-required",
          fallbackUsed: false,
          parserVersion: "1",
        };
        return { output, metadata };
      }

      const failure = classifyHttpFailure(result.status, result.bodyText);
      lastCode = failure.code;

      // Format/token-field fallback only when a 400/422 clearly identifies a
      // rejected request field. The token limit field is never dropped — it
      // only degrades from max_completion_tokens to max_tokens once.
      if (
        (result.status === 400 || result.status === 422) &&
        failure.unsupported !== undefined
      ) {
        if (failure.unsupported === "max_completion_tokens") {
          if (tokenLimitField !== "max_completion_tokens")
            throw new AIError(failure.code);
          tokenLimitField = "max_tokens";
        } else {
          const next = nextResponseMode(responseMode, failure.unsupported);
          if (next === undefined) throw new AIError(failure.code);
          responseMode = next;
        }
        formatFallbackUsed = true;
        emitEvent(request.onEvent, { type: "progress", phase: "retrying" });
        continue;
      }

      if (failure.retryable) {
        if (retries >= HTTP_LIMITS.maxRetries) throw new AIError(failure.code);
        let waitMs: number;
        if (result.retryAfterMs !== undefined) {
          if (result.retryAfterMs > HTTP_LIMITS.retryAfterCapMs)
            throw new AIError(failure.code);
          waitMs = result.retryAfterMs;
        } else {
          waitMs =
            RETRY_BACKOFF_MS[Math.min(retries, RETRY_BACKOFF_MS.length - 1)] +
            Math.floor(Math.random() * JITTER_MS);
        }
        if (waitMs > deadlineAt - Date.now()) throw new AIError(failure.code);
        retries += 1;
        emitEvent(request.onEvent, { type: "progress", phase: "retrying" });
        await wait(waitMs, signal);
        continue;
      }

      throw new AIError(failure.code);
    }
  } catch (error) {
    if (request.signal?.aborted) throw new AIError("cancelled");
    throw error instanceof AIError ? error : new AIError("provider_failed");
  }
}
