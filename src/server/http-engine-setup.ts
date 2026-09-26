// Server-side in-memory store for the OpenAI-compatible HTTP engine
// configuration (C5). The API key lives only in a private field and reaches
// the transport through the getApiKey() closure on HttpRuntimeConfig; it is
// never copied into HttpEngineView, error text, or serialized output.
import { randomUUID } from "node:crypto";
import {
  HTTP_LIMITS,
  type HttpEngineVerification,
  type HttpEngineView,
} from "../ai-contract.ts";
import { AIError, type AIErrorCode } from "./ai/errors.ts";
import type { HttpRuntimeConfig } from "./ai/types.ts";

/** Runs the user-triggered connection check against a resolved runtime.
 * Throws an AIError on failure; resolves when the endpoint answers. */
export type HttpVerifier = (
  runtime: HttpRuntimeConfig,
  signal: AbortSignal,
) => Promise<void>;

const MODEL_PATTERN = /^[-a-zA-Z0-9_.:/]{1,120}$/;
const KEY_FORBIDDEN = /[\s\x00-\x1f\x7f-\x9f]/;

function pushUnique(list: AIErrorCode[], code: AIErrorCode): void {
  if (!list.includes(code)) list.push(code);
}

function validateApiKey(raw: unknown): string {
  if (typeof raw !== "string") throw new AIError("invalid_request");
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes === 0 || bytes > HTTP_LIMITS.apiKeyMaxBytes)
    throw new AIError("invalid_request");
  if (KEY_FORBIDDEN.test(raw)) throw new AIError("invalid_request");
  return raw;
}

/** Validates an absolute http(s) prefix URL. Only the prefix is stored; the
 * transport appends "/chat/completions" itself, so a URL already carrying
 * that suffix is rejected rather than silently duplicated. */
export function normalizeBaseUrl(raw: string): {
  baseUrl: string;
  host: string;
} {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw !== raw.trim() ||
    /\s/.test(raw) ||
    // Require a real authority: WHATWG would otherwise promote the path of
    // "http:///localhost:1234/v1" into the host.
    !/^https?:\/\/[^/?#]+/i.test(raw)
  )
    throw new AIError("invalid_request");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AIError("invalid_request");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new AIError("invalid_request");
  if (
    url.host === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new AIError("invalid_request");
  let path = url.pathname;
  while (path.endsWith("/")) path = path.slice(0, -1);
  if (path.endsWith("/chat/completions")) throw new AIError("invalid_request");
  return { baseUrl: url.origin + path, host: url.host };
}

interface StoredHttpConfig {
  configId: string;
  revision: number;
  baseUrl: string;
  host: string;
  model: string;
  verification: HttpEngineVerification;
  /** AIError code of the last failed connection check. */
  failureCode: AIErrorCode | null;
}

export class HttpEngineSetup {
  readonly #verifier: HttpVerifier;
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #listeners = new Set<(configId: string) => void>();
  #config: StoredHttpConfig | null = null;
  #apiKey: string | null = null;
  #activeVerify: { controller: AbortController } | null = null;
  #closed = false;

  constructor(opts: {
    verifier: HttpVerifier;
    now?: () => number;
    randomId?: () => string;
  }) {
    if (typeof opts?.verifier !== "function")
      throw new AIError("invalid_request");
    this.#verifier = opts.verifier;
    this.#now = opts.now ?? Date.now;
    this.#randomId = opts.randomId ?? randomUUID;
  }

  /** Public credential-free projection, or null before first configure. */
  view(): HttpEngineView | null {
    const cfg = this.#config;
    if (!cfg) return null;
    const hasApiKey = this.#apiKey !== null;
    const blockers: AIErrorCode[] = [];
    if (cfg.verification === "failed")
      pushUnique(blockers, cfg.failureCode ?? "provider_failed");
    // auth_required covers a missing key and a credential not yet confirmed
    // authorized by a successful connection check.
    if (
      !hasApiKey ||
      cfg.verification === "not_checked" ||
      cfg.verification === "checking"
    )
      pushUnique(blockers, "auth_required");
    return {
      providerId: "openai-compatible",
      transport: "http",
      configId: cfg.configId,
      revision: cfg.revision,
      host: cfg.host,
      model: cfg.model,
      hasApiKey,
      verification: cfg.verification,
      blockers,
      ready: hasApiKey && cfg.verification === "verified",
    };
  }

  configure(input: {
    providerId: "openai-compatible";
    baseUrl: string;
    model: string;
    apiKey?: string;
    configId?: string;
    expectedRevision?: number;
  }): HttpEngineView {
    this.#assertOpen();
    if (input?.providerId !== "openai-compatible")
      throw new AIError("invalid_request");
    const { baseUrl, host } = normalizeBaseUrl(input.baseUrl);
    if (typeof input.model !== "string" || !MODEL_PATTERN.test(input.model))
      throw new AIError("invalid_request");

    const previous = this.#config;
    let key: string | null;
    if (previous) {
      if (
        input.configId !== previous.configId ||
        input.expectedRevision !== previous.revision
      )
        throw new AIError("invalid_request");
      // A different endpoint must never receive the previously stored key.
      key = baseUrl === previous.baseUrl ? this.#apiKey : null;
    } else {
      if (input.configId !== undefined || input.expectedRevision !== undefined)
        throw new AIError("invalid_request");
      key = null;
    }
    if (input.apiKey !== undefined) key = validateApiKey(input.apiKey);
    if (key === null) throw new AIError("auth_required");

    // Mutations abort any in-flight check: its result would target a
    // superseded revision.
    this.#abortVerify();
    const next: StoredHttpConfig = {
      configId: previous?.configId ?? this.#randomId(),
      revision: (previous?.revision ?? 0) + 1,
      baseUrl,
      host,
      model: input.model,
      verification: "not_checked",
      failureCode: null,
    };
    this.#config = next;
    this.#apiKey = key;
    if (previous) this.#emitInvalidate(next.configId);
    return this.#requireView();
  }

  /** User-triggered connection check. Resolves with the updated view for both
   * success and verification failure; request-level problems (stale
   * revision, missing consent, a check already running) reject instead. */
  async verify(
    input: { configId: string; revision: number; consent: true },
    signal?: AbortSignal,
  ): Promise<HttpEngineView> {
    this.#assertOpen();
    if (input?.consent !== true) throw new AIError("invalid_request");
    const cfg = this.#config;
    if (
      !cfg ||
      cfg.configId !== input.configId ||
      cfg.revision !== input.revision
    )
      throw new AIError("invalid_request");
    if (this.#activeVerify) throw new AIError("invalid_request");
    if (this.#apiKey === null) throw new AIError("auth_required");

    const controller = new AbortController();
    const deadline = AbortSignal.timeout(HTTP_LIMITS.verifyDeadlineMs);
    const combined = AbortSignal.any(
      signal
        ? [signal, controller.signal, deadline]
        : [controller.signal, deadline],
    );
    const active = { controller };
    this.#activeVerify = active;
    cfg.verification = "checking";
    cfg.failureCode = null;
    const revision = cfg.revision;
    const runtime = this.#runtime(cfg);
    try {
      await this.#verifier(runtime, combined);
      if (this.#closed) throw new AIError("cancelled");
      if (this.#config !== cfg || cfg.revision !== revision)
        return this.#requireView(); // superseded: discard the late result
      if (signal?.aborted) {
        cfg.verification = "not_checked";
        throw new AIError("cancelled");
      }
      if (combined.aborted) {
        cfg.verification = "failed";
        cfg.failureCode = deadline.aborted ? "timeout" : "cancelled";
        return this.#requireView();
      }
      cfg.verification = "verified";
      return this.#requireView();
    } catch (err) {
      if (this.#closed) throw new AIError("cancelled");
      if (this.#config !== cfg || cfg.revision !== revision)
        return this.#requireView(); // superseded: discard the late result
      if (signal?.aborted) {
        cfg.verification = "not_checked";
        throw new AIError("cancelled");
      }
      cfg.verification = "failed";
      cfg.failureCode = deadline.aborted
        ? "timeout"
        : err instanceof AIError
          ? err.code
          : "provider_failed";
      return this.#requireView();
    } finally {
      if (this.#activeVerify === active) this.#activeVerify = null;
    }
  }

  /** Removes the stored key and bumps the revision; the endpoint and model
   * remain so status can report "key missing". Returns null when no
   * configuration exists. */
  forget(input: { configId: string; revision: number }): HttpEngineView | null {
    this.#assertOpen();
    const cfg = this.#config;
    if (!cfg) return null;
    if (input?.configId !== cfg.configId || input.revision !== cfg.revision)
      throw new AIError("invalid_request");
    this.#abortVerify();
    this.#apiKey = null;
    this.#config = {
      ...cfg,
      revision: cfg.revision + 1,
      verification: "not_checked",
      failureCode: null,
    };
    this.#emitInvalidate(cfg.configId);
    return this.view();
  }

  /** Server-internal resolution for the HTTP adapter. Fails closed whenever
   * the configuration is not ready. */
  resolve(): HttpRuntimeConfig {
    this.#assertOpen();
    const cfg = this.#config;
    if (!cfg || this.#apiKey === null) throw new AIError("auth_required");
    if (cfg.verification === "failed")
      throw new AIError(cfg.failureCode ?? "provider_failed");
    if (cfg.verification !== "verified") throw new AIError("auth_required");
    return this.#runtime(cfg);
  }

  /** Revision-bumping changes (configure, forget) notify listeners so
   * consent records and cached plans keyed to the old revision drop. */
  onInvalidate(listener: (configId: string) => void): () => void {
    if (typeof listener !== "function") throw new AIError("invalid_request");
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#abortVerify();
    this.#apiKey = null;
    this.#config = null;
    this.#listeners.clear();
  }

  #assertOpen(): void {
    if (this.#closed) throw new AIError("cancelled");
  }

  #abortVerify(): void {
    // Clear the slot, not just the signal: a verifier that ignores abort would
    // otherwise keep #activeVerify set and block checks on the new revision
    // until it settles. The finally guard in verify() keeps a late-settling
    // check from clearing a newer active entry.
    const active = this.#activeVerify;
    this.#activeVerify = null;
    active?.controller.abort();
  }

  #emitInvalidate(configId: string): void {
    for (const listener of this.#listeners) {
      try {
        listener(configId);
      } catch {
        // Listener failures must not corrupt the configuration store.
      }
    }
  }

  #requireView(): HttpEngineView {
    const view = this.view();
    if (!view) throw new AIError("cancelled");
    return view;
  }

  /** Builds a runtime bound to this exact config snapshot: after a
   * reconfigure, forget, or close, the credential closure refuses to hand
   * out its key rather than pair it with a stale endpoint. */
  #runtime(cfg: StoredHttpConfig): HttpRuntimeConfig {
    const key = this.#apiKey;
    if (key === null) throw new AIError("auth_required");
    return {
      providerId: "openai-compatible",
      configId: cfg.configId,
      revision: cfg.revision,
      baseUrl: cfg.baseUrl,
      host: cfg.host,
      model: cfg.model,
      maxOutputTokens: HTTP_LIMITS.defaultMaxOutputTokens,
      getApiKey: () => {
        if (this.#closed || this.#config !== cfg)
          throw new AIError("cancelled");
        return key;
      },
    };
  }
}
