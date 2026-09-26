import { HTTP_LIMITS } from "../../ai-contract.ts";
import { AIError } from "./errors.ts";
import type { HttpAttemptInput, HttpAttemptResult } from "./types.ts";

/** Parses a Retry-After header (integer seconds or HTTP-date). Returns
 * milliseconds until retry, or undefined for missing/invalid/past values. */
export function parseRetryAfter(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  let ms: number;
  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    ms = at - Date.now();
  }
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/** One bounded POST to a chat completions URL. No retries and no format
 * negotiation happen here; status classification is the caller's job.
 * Every failure leaves this function as an AIError carrying only a fixed
 * code — never the URL, the key, or provider/OS error text. */
export async function postCompletion(
  input: HttpAttemptInput & {
    apiKey: string;
    /** Already-serialized request JSON. */
    body: string;
  },
  signal: AbortSignal,
): Promise<HttpAttemptResult> {
  if (signal.aborted) throw new AIError("cancelled");
  if (Buffer.byteLength(input.body, "utf8") > HTTP_LIMITS.requestBytes)
    throw new AIError("input_limit");
  const remaining = input.deadlineAt - Date.now();
  if (!(remaining > 0)) throw new AIError("timeout");

  const combined = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
  const abortError = () =>
    new AIError(signal.aborted ? "cancelled" : "timeout");

  let response: Response;
  try {
    response = await fetch(input.url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey}`,
        accept: "application/json",
      },
      body: input.body,
      signal: combined,
    });
  } catch (error) {
    if (error instanceof AIError) throw error;
    if (combined.aborted || signal.aborted) throw abortError();
    throw new AIError("provider_unavailable");
  }

  // Redirects are never followed; a 3xx is a hard provider failure.
  if (response.status >= 300 && response.status < 400) {
    void response.body?.cancel().catch(() => {});
    throw new AIError("provider_unavailable");
  }

  const ok = response.status >= 200 && response.status < 300;
  const limit = ok ? HTTP_LIMITS.responseBytes : HTTP_LIMITS.errorBodyBytes;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        bytes += value.length;
        if (bytes > limit) {
          if (ok) throw new AIError("output_limit");
          // Error bodies are truncated at the cap, not rejected.
          const keep = value.subarray(0, value.length - (bytes - limit));
          if (keep.length > 0) chunks.push(keep);
          bytes = limit;
          break;
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof AIError) throw error;
      if (combined.aborted || signal.aborted) throw abortError();
      throw new AIError("provider_unavailable");
    } finally {
      try {
        void reader.cancel().catch(() => {});
      } catch {
        // best effort
      }
      reader.releaseLock();
    }
  }

  const bodyText = new TextDecoder("utf-8").decode(
    Buffer.concat(chunks.map((c) => Buffer.from(c))),
  );
  const result: HttpAttemptResult = { status: response.status, bodyText, bytes };
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;
  return result;
}
