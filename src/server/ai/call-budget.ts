import { HTTP_LIMITS } from "../../ai-contract.ts";
import type { ProviderCallBudgetView } from "../../ai-contract.ts";
import { AIError } from "./errors.ts";

/** Shared call cap; must stay aligned with DEFAULT_BUDGETS.maxCalls (52). */
const MAX_CALLS = 52;
const MAX_TOTAL_OUTPUT_TOKENS = MAX_CALLS * HTTP_LIMITS.maxOutputTokens;

export interface ProviderCallBudget {
  readonly used: number;
  readonly limit: number;
  readonly reservedOutputTokens: number;
  readonly outputTokenLimit: number;
  /** Charge one provider call; invoke synchronously just before transmission. */
  reserve(maxOutputTokens: number): void;
  view(): ProviderCallBudgetView;
}

const positiveInt = (value: number, max: number) =>
  Number.isSafeInteger(value) && value >= 1 && value <= max;

export function createCallBudget(opts: {
  maxCalls: number;
  maxOutputTokensPerCall: number;
  totalOutputTokenLimit: number;
}): ProviderCallBudget {
  const { maxCalls, maxOutputTokensPerCall, totalOutputTokenLimit } = opts;
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 0 || maxCalls > MAX_CALLS)
    throw new AIError("invalid_request");
  if (!positiveInt(maxOutputTokensPerCall, HTTP_LIMITS.maxOutputTokens))
    throw new AIError("invalid_request");
  if (!positiveInt(totalOutputTokenLimit, MAX_TOTAL_OUTPUT_TOKENS))
    throw new AIError("invalid_request");
  let used = 0,
    reserved = 0;
  return {
    get used() {
      return used;
    },
    get reservedOutputTokens() {
      return reserved;
    },
    limit: maxCalls,
    outputTokenLimit: totalOutputTokenLimit,
    reserve(maxOutputTokens: number) {
      if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1)
        throw new AIError("invalid_request");
      if (
        maxOutputTokens > HTTP_LIMITS.maxOutputTokens ||
        maxOutputTokens > maxOutputTokensPerCall ||
        used + 1 > maxCalls ||
        reserved + maxOutputTokens > totalOutputTokenLimit
      )
        throw new AIError("call_budget_exceeded");
      used += 1;
      reserved += maxOutputTokens;
    },
    view() {
      return { used, limit: maxCalls };
    },
  };
}
