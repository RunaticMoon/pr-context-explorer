// Request validation and the connection-check verifier for the
// OpenAI-compatible HTTP engine setup actions (C5). The router in
// live-api.ts wires these into /api/engines/setup; this module owns only
// body validation, fixed-phrase error projection, and the verify probe.
// API keys are deleted from the request object before returning and never
// appear in responses, error text, or logs.
import {
  HTTP_LIMITS,
  type HttpEngineView,
  type TokenLimitField,
} from "../ai-contract.ts";
import { AIError, type AIErrorCode } from "./ai/errors.ts";
import {
  buildChatBody,
  classifyHttpFailure,
  parseSuccess,
} from "./ai/http-codec.ts";
import { postCompletion } from "./ai/http-transport.ts";
import type {
  HttpAttemptResult,
  HttpChatMessage,
  HttpRuntimeConfig,
} from "./ai/types.ts";
import type { HttpEngineSetup, HttpVerifier } from "./http-engine-setup.ts";

const HTTP_ENGINE_ACTIONS = [
  "configure-http",
  "verify-http",
  "forget-http",
] as const;

const SETUP_ERROR = "http engine setup failed";

export type HttpEngineActionResult = {
  status: number;
  body: { http: HttpEngineView | null } | { error: string; code?: AIErrorCode };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isInt = (value: unknown): value is number => Number.isInteger(value);

/** Every key must be listed and every required key must be present. */
function keysMatch(
  body: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(body);
  return (
    keys.every((k) => required.includes(k) || optional.includes(k)) &&
    required.every((k) => keys.includes(k))
  );
}

function failed(code: AIErrorCode): HttpEngineActionResult {
  return { status: 400, body: { error: SETUP_ERROR, code } };
}

/** True when the request body names one of the HTTP engine setup actions. */
export function isHttpEngineAction(body: unknown): boolean {
  if (!isRecord(body)) return false;
  return (HTTP_ENGINE_ACTIONS as readonly unknown[]).includes(body.action);
}

/** Validates and dispatches one HTTP engine setup action. The `apiKey`
 * property is removed from `body` in all outcomes; responses and errors
 * carry a fixed phrase plus a sanitized code only. */
export async function handleHttpEngineAction(
  setup: HttpEngineSetup,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<HttpEngineActionResult> {
  try {
    if (!isRecord(body)) return failed("invalid_request");
    let view: HttpEngineView | null;
    if (body.action === "configure-http") {
      if (
        !keysMatch(
          body,
          ["action", "providerId", "baseUrl", "model"],
          ["apiKey", "configId", "expectedRevision"],
        ) ||
        body.providerId !== "openai-compatible" ||
        typeof body.baseUrl !== "string" ||
        typeof body.model !== "string" ||
        (body.apiKey !== undefined && typeof body.apiKey !== "string") ||
        (body.configId !== undefined && typeof body.configId !== "string") ||
        (body.expectedRevision !== undefined && !isInt(body.expectedRevision))
      )
        return failed("invalid_request");
      view = setup.configure({
        providerId: "openai-compatible",
        baseUrl: body.baseUrl,
        model: body.model,
        ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
        ...(body.configId !== undefined ? { configId: body.configId } : {}),
        ...(body.expectedRevision !== undefined
          ? { expectedRevision: body.expectedRevision }
          : {}),
      });
    } else if (body.action === "verify-http") {
      if (
        !keysMatch(body, ["action", "configId", "revision", "consent"], []) ||
        typeof body.configId !== "string" ||
        !isInt(body.revision) ||
        body.consent !== true
      )
        return failed("invalid_request");
      view = await setup.verify(
        { configId: body.configId, revision: body.revision, consent: true },
        signal,
      );
    } else if (body.action === "forget-http") {
      if (
        !keysMatch(body, ["action", "configId", "revision"], []) ||
        typeof body.configId !== "string" ||
        !isInt(body.revision)
      )
        return failed("invalid_request");
      view = setup.forget({ configId: body.configId, revision: body.revision });
    } else {
      return failed("invalid_request");
    }
    return { status: 200, body: { http: view } };
  } catch (error) {
    if (error instanceof AIError) return failed(error.code);
    return { status: 500, body: { error: SETUP_ERROR } };
  } finally {
    if (isRecord(body)) delete body.apiKey;
  }
}

const VERIFY_SYSTEM_PROMPT =
  "You are a connectivity check for an OpenAI-compatible chat endpoint. " +
  'Reply with exactly the JSON object {"ok":true} and no other text.';
const VERIFY_USER_PROMPT = 'Return {"ok":true}.';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AIError("cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AIError("cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Connection check for the HTTP engine: one small source-free JSON
 * completion, `prompt_json` mode, 128 output tokens, at most 4 total
 * attempts (≤2 retries on 429/5xx) inside the verify deadline. The
 * `max_completion_tokens` → `max_tokens` fallback runs once and only on an
 * explicit parameter rejection. The API key is re-read through
 * `getApiKey()` on every attempt. Success requires a 2xx whose assistant
 * content parses to a JSON object; `/models` probes never prove
 * readiness. */
export function createHttpVerifier(deps?: {
  post?: typeof postCompletion;
}): HttpVerifier {
  const post = deps?.post ?? postCompletion;
  return async (runtime: HttpRuntimeConfig, signal) => {
    const url = `${runtime.baseUrl}/chat/completions`;
    const deadlineAt = Date.now() + HTTP_LIMITS.verifyDeadlineMs;
    const messages: HttpChatMessage[] = [
      { role: "system", content: VERIFY_SYSTEM_PROMPT },
      { role: "user", content: VERIFY_USER_PROMPT },
    ];
    let tokenLimitField: TokenLimitField = "max_completion_tokens";
    let attempts = 0;
    let retries = 0;
    for (;;) {
      if (signal.aborted) throw new AIError("cancelled");
      if (attempts >= HTTP_LIMITS.maxAttemptsPerStage)
        throw new AIError("provider_failed");
      attempts += 1;
      const apiKey = runtime.getApiKey();
      let result: HttpAttemptResult;
      try {
        result = await post(
          {
            url,
            model: runtime.model,
            messages,
            responseMode: "prompt_json",
            tokenLimitField,
            maxOutputTokens: HTTP_LIMITS.verifyMaxOutputTokens,
            deadlineAt,
            apiKey,
            body: buildChatBody({
              model: runtime.model,
              system: VERIFY_SYSTEM_PROMPT,
              user: VERIFY_USER_PROMPT,
              responseMode: "prompt_json",
              tokenLimitField,
              maxOutputTokens: HTTP_LIMITS.verifyMaxOutputTokens,
            }),
          },
          signal,
        );
      } catch (error) {
        if (error instanceof AIError) throw error;
        throw new AIError("provider_failed");
      }
      if (result.status >= 200 && result.status < 300) {
        const parsed = parseSuccess(result.bodyText, { apiKey });
        if (typeof parsed.output !== "object" || parsed.output === null)
          throw new AIError("provider_failed");
        return;
      }
      const failure = classifyHttpFailure(result.status, result.bodyText);
      if (
        failure.unsupported === "max_completion_tokens" &&
        tokenLimitField === "max_completion_tokens" &&
        attempts < HTTP_LIMITS.maxAttemptsPerStage
      ) {
        tokenLimitField = "max_tokens";
        continue;
      }
      const remaining = deadlineAt - Date.now();
      if (
        failure.retryable &&
        retries < HTTP_LIMITS.maxRetries &&
        attempts < HTTP_LIMITS.maxAttemptsPerStage
      ) {
        const wait =
          result.retryAfterMs ??
          500 * 2 ** retries + Math.floor(Math.random() * 250);
        if (wait <= HTTP_LIMITS.retryAfterCapMs && wait <= remaining) {
          retries += 1;
          await sleep(wait, signal);
          continue;
        }
      }
      throw new AIError(failure.code);
    }
  };
}
