// Server-side store binding a live-run consent token (planId) to the exact
// transmission parameters it was issued for (C5). A plan proves the caller
// was shown the transmissionPlan for a specific snapshot, scope, engine
// revision and budget; any validation attempt against a live entry consumes
// it, so a planId authorizes at most one run. Entries hold only the
// caller-supplied PlanBinding — never credentials or key material.
import { randomBytes } from "node:crypto";
import { HTTP_LIMITS } from "../ai-contract.ts";
import { AIError } from "./ai/errors.ts";

/** Parameters a transmission plan is bound to. scopeKey is the caller's
 * normalized scope serialization; every present field must match exactly. */
export type PlanBinding = {
  snapshotId: string;
  scopeKey: string;
  providerId: string;
  model: string;
  configId?: string;
  revision?: number;
  audit: boolean;
  historical: boolean;
  maxProviderCalls: number;
  maxOutputTokensPerCall?: number;
  totalOutputTokenReservation?: number;
};

const BINDING_TYPES: Record<
  keyof PlanBinding,
  "string" | "number" | "boolean"
> = {
  snapshotId: "string",
  scopeKey: "string",
  providerId: "string",
  model: "string",
  configId: "string",
  revision: "number",
  audit: "boolean",
  historical: "boolean",
  maxProviderCalls: "number",
  maxOutputTokensPerCall: "number",
  totalOutputTokenReservation: "number",
};
const BINDING_KEYS = new Set<string>(Object.keys(BINDING_TYPES));
const REQUIRED_KEYS = [
  "snapshotId",
  "scopeKey",
  "providerId",
  "model",
  "audit",
  "historical",
  "maxProviderCalls",
] as const;
/** 128–512 bits of lowercase hex; the default generator emits 128 bits. */
const PLAN_ID_PATTERN = /^[0-9a-f]{32,128}$/;
const invalid = () => new AIError("invalid_request");

/** Rejects malformed bindings at issue time so no stored plan is provably
 * unmatchable: required fields present, no unknown fields, correct types. */
function checkBinding(binding: PlanBinding): void {
  if (!binding || typeof binding !== "object" || Array.isArray(binding))
    throw invalid();
  for (const key of REQUIRED_KEYS)
    if ((binding as Record<string, unknown>)[key] === undefined)
      throw invalid();
  for (const [key, value] of Object.entries(binding)) {
    if (!BINDING_KEYS.has(key)) throw invalid();
    const expected = BINDING_TYPES[key as keyof PlanBinding];
    if (typeof value !== expected) throw invalid();
    if (expected === "number" && !Number.isSafeInteger(value)) throw invalid();
  }
}

/** Exact structural equality: identical key set, identical values. Missing
 * or extra fields on either side are a mismatch. */
function sameBinding(a: PlanBinding, b: PlanBinding): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key)) return false;
    if (
      !Object.is(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    )
      return false;
  }
  return true;
}

type PlanEntry = { binding: PlanBinding; expiresAt: number };

export class AnalysisConsentStore {
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #plans = new Map<string, PlanEntry>();

  constructor(opts?: {
    now?: () => number;
    randomId?: () => string;
    ttlMs?: number;
    maxEntries?: number;
  }) {
    this.#now = opts?.now ?? Date.now;
    this.#randomId = opts?.randomId ?? (() => randomBytes(16).toString("hex"));
    this.#ttlMs = opts?.ttlMs ?? HTTP_LIMITS.planTtlMs;
    this.#maxEntries = opts?.maxEntries ?? 64;
    if (
      typeof this.#now !== "function" ||
      typeof this.#randomId !== "function" ||
      !Number.isFinite(this.#ttlMs) ||
      this.#ttlMs <= 0 ||
      !Number.isSafeInteger(this.#maxEntries) ||
      this.#maxEntries < 1
    )
      throw invalid();
  }

  /** Issues a one-time planId bound to the exact binding. */
  issuePlan(binding: PlanBinding): string {
    checkBinding(binding);
    this.#sweep();
    const planId = this.#randomId();
    if (
      typeof planId !== "string" ||
      !PLAN_ID_PATTERN.test(planId) ||
      this.#plans.has(planId)
    )
      throw invalid();
    this.#plans.set(planId, {
      binding: { ...binding },
      expiresAt: this.#now() + this.#ttlMs,
    });
    // Map iteration is insertion-ordered, so the front is always oldest.
    while (this.#plans.size > this.#maxEntries)
      this.#plans.delete(this.#plans.keys().next().value!);
    return planId;
  }

  /** Consumes the plan on any attempt against a live entry — the binding is
   * the consent, so a mismatch must not get a second try. Only an exact
   * match succeeds, and success is single-use. */
  validatePlan(planId: string, binding: PlanBinding): void {
    const entry = this.#plans.get(planId);
    if (!entry) throw invalid();
    this.#plans.delete(planId);
    if (entry.expiresAt <= this.#now()) throw invalid();
    if (
      !binding ||
      typeof binding !== "object" ||
      !sameBinding(entry.binding, binding)
    )
      throw invalid();
  }

  /** Test/debug inspection; never consumes. Expired entries are dropped and
   * reported absent. */
  peek(planId: string): PlanBinding | undefined {
    const entry = this.#plans.get(planId);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#plans.delete(planId);
      return undefined;
    }
    return { ...entry.binding };
  }

  /** Drops every plan bound to a configId (config edit or forget). Plans
   * without a configId — local CLI plans — are untouched. */
  invalidate(configId: string): void {
    if (typeof configId !== "string") throw invalid();
    for (const [planId, entry] of this.#plans)
      if (entry.binding.configId === configId) this.#plans.delete(planId);
  }

  clear(): void {
    this.#plans.clear();
  }

  #sweep(): void {
    const now = this.#now();
    for (const [planId, entry] of this.#plans)
      if (entry.expiresAt <= now) this.#plans.delete(planId);
  }
}
