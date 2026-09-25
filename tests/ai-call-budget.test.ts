import test from "node:test";
import assert from "node:assert/strict";
import { HTTP_LIMITS } from "../src/ai-contract.ts";
import { AIError } from "../src/server/ai/errors.ts";
import { createCallBudget } from "../src/server/ai/call-budget.ts";

const MAX_TOKENS = HTTP_LIMITS.maxOutputTokens;
const MAX_TOTAL = 52 * MAX_TOKENS;
const isAIError = (code: string) => (e: unknown) =>
  e instanceof AIError && e.code === code;

test("createCallBudget starts untouched and reserves synchronously", () => {
  const budget = createCallBudget({
    maxCalls: 3,
    maxOutputTokensPerCall: 1000,
    totalOutputTokenLimit: 2000,
  });
  assert.equal(budget.used, 0);
  assert.equal(budget.limit, 3);
  assert.equal(budget.reservedOutputTokens, 0);
  assert.equal(budget.outputTokenLimit, 2000);
  assert.equal(budget.reserve(400), undefined);
  assert.equal(budget.used, 1);
  assert.equal(budget.reservedOutputTokens, 400);
});

test("constructor accepts boundary values", () => {
  for (const [maxCalls, perCall, total] of [
    [0, 1, 1],
    [0, MAX_TOKENS, MAX_TOTAL],
    [52, 1, 1],
    [52, MAX_TOKENS, MAX_TOTAL],
  ] as const) {
    const budget = createCallBudget({
      maxCalls,
      maxOutputTokensPerCall: perCall,
      totalOutputTokenLimit: total,
    });
    assert.equal(budget.limit, maxCalls);
    assert.equal(budget.outputTokenLimit, total);
  }
});

test("constructor rejects out-of-range or non-integer options", () => {
  const base = {
    maxCalls: 4,
    maxOutputTokensPerCall: 8192,
    totalOutputTokenLimit: 32768,
  };
  for (const maxCalls of [-1, 53, 1.5, NaN, Infinity])
    assert.throws(
      () => createCallBudget({ ...base, maxCalls }),
      isAIError("invalid_request"),
    );
  for (const maxOutputTokensPerCall of [0, -1, 1.5, NaN, MAX_TOKENS + 1])
    assert.throws(
      () => createCallBudget({ ...base, maxOutputTokensPerCall }),
      isAIError("invalid_request"),
    );
  for (const totalOutputTokenLimit of [0, -1, 1.5, NaN, MAX_TOTAL + 1])
    assert.throws(
      () => createCallBudget({ ...base, totalOutputTokenLimit }),
      isAIError("invalid_request"),
    );
});

test("reserve rejects malformed token counts without charging", () => {
  const budget = createCallBudget({
    maxCalls: 2,
    maxOutputTokensPerCall: 500,
    totalOutputTokenLimit: 1000,
  });
  for (const n of [0, -1, 1.5, NaN, Infinity])
    assert.throws(() => budget.reserve(n), isAIError("invalid_request"));
  for (const n of [MAX_TOKENS + 1, 501])
    assert.throws(() => budget.reserve(n), isAIError("input_limit"));
  assert.equal(budget.used, 0);
  assert.equal(budget.reservedOutputTokens, 0);
});

test("call-count exhaustion throws without charging", () => {
  const budget = createCallBudget({
    maxCalls: 2,
    maxOutputTokensPerCall: 100,
    totalOutputTokenLimit: 400,
  });
  budget.reserve(100);
  budget.reserve(100);
  assert.throws(() => budget.reserve(1), isAIError("input_limit"));
  assert.equal(budget.used, 2);
  assert.equal(budget.reservedOutputTokens, 200);
});

test("zero-call budget rejects every reservation", () => {
  const budget = createCallBudget({
    maxCalls: 0,
    maxOutputTokensPerCall: MAX_TOKENS,
    totalOutputTokenLimit: 1,
  });
  assert.throws(() => budget.reserve(1), isAIError("input_limit"));
  assert.equal(budget.used, 0);
});

test("token-limit exhaustion throws without charging", () => {
  const budget = createCallBudget({
    maxCalls: 4,
    maxOutputTokensPerCall: 60,
    totalOutputTokenLimit: 100,
  });
  budget.reserve(60);
  assert.throws(() => budget.reserve(41), isAIError("input_limit"));
  assert.equal(budget.used, 1);
  assert.equal(budget.reservedOutputTokens, 60);
  budget.reserve(40);
  assert.throws(() => budget.reserve(1), isAIError("input_limit"));
  assert.equal(budget.used, 2);
  assert.equal(budget.reservedOutputTokens, 100);
});

test("reserve boundary values at the shared cap", () => {
  const budget = createCallBudget({
    maxCalls: 52,
    maxOutputTokensPerCall: MAX_TOKENS,
    totalOutputTokenLimit: MAX_TOTAL,
  });
  for (let i = 0; i < 52; i++) budget.reserve(MAX_TOKENS);
  assert.equal(budget.used, 52);
  assert.equal(budget.reservedOutputTokens, MAX_TOTAL);
  assert.throws(() => budget.reserve(1), isAIError("input_limit"));
});

test("view() exposes only used and limit", () => {
  const budget = createCallBudget({
    maxCalls: 5,
    maxOutputTokensPerCall: 100,
    totalOutputTokenLimit: 500,
  });
  budget.reserve(50);
  assert.deepEqual(budget.view(), { used: 1, limit: 5 });
  assert.deepEqual(Object.keys(budget.view()).sort(), ["limit", "used"]);
});
