import test from "node:test";
import assert from "node:assert/strict";
import {
  HTTP_LIMITS,
  VALIDATION_REASON_CODES,
  httpMaxProviderCalls,
  isLocalProviderId,
  logicalStepCount,
} from "../src/ai-contract.ts";

test("isLocalProviderId", () => {
  assert.equal(isLocalProviderId("codex"), true);
  assert.equal(isLocalProviderId("claude"), true);
  assert.equal(isLocalProviderId("openai-compatible"), false);
  assert.equal(isLocalProviderId("bogus"), false);
  assert.equal(isLocalProviderId(undefined), false);
  assert.equal(isLocalProviderId(null), false);
  assert.equal(isLocalProviderId(42), false);
});

test("VALIDATION_REASON_CODES covers the C6 minimum list", () => {
  assert.deepEqual([...VALIDATION_REASON_CODES].sort(), [
    "audit_reference_invalid",
    "duplicate_reference",
    "evidence_outside_context",
    "execution_claim_forbidden",
    "file_outside_context",
    "inference_rationale_required",
    "output_schema_mismatch",
    "phase_outside_context",
    "revision_mismatch",
    "runner_identity_mismatch",
    "statement_evidence_required",
    "task_id_mismatch",
    "tour_id_mismatch",
    "unknown_limitation_required",
    "validation_failed",
  ]);
  assert.equal(
    new Set(VALIDATION_REASON_CODES).size,
    VALIDATION_REASON_CODES.length,
  );
});

test("HTTP_LIMITS values", () => {
  assert.equal(HTTP_LIMITS.requestBytes, 1024 * 1024);
  assert.equal(HTTP_LIMITS.schemaBytes, 64 * 1024);
  assert.equal(HTTP_LIMITS.responseBytes, 4 * 1024 * 1024);
  assert.equal(HTTP_LIMITS.errorBodyBytes, 64 * 1024);
  assert.equal(HTTP_LIMITS.defaultMaxOutputTokens, 8192);
  assert.equal(HTTP_LIMITS.maxOutputTokens, 32768);
  assert.equal(HTTP_LIMITS.maxAttemptsPerStage, 4);
  assert.equal(HTTP_LIMITS.maxRetries, 2);
  assert.equal(HTTP_LIMITS.stageDeadlineMs, 120_000);
  assert.equal(HTTP_LIMITS.pipelineDeadlineMs, 900_000);
  assert.equal(HTTP_LIMITS.retryAfterCapMs, 30_000);
  assert.equal(HTTP_LIMITS.verifyDeadlineMs, 15_000);
  assert.equal(HTTP_LIMITS.verifyMaxOutputTokens, 128);
  assert.equal(HTTP_LIMITS.apiKeyMaxBytes, 8192);
  assert.equal(HTTP_LIMITS.planTtlMs, 600_000);
});

test("logicalStepCount", () => {
  assert.equal(logicalStepCount({ chunks: 0, kind: "pr", audit: false }), 0);
  assert.equal(logicalStepCount({ chunks: 0, kind: "code", audit: true }), 0);
  assert.equal(logicalStepCount({ chunks: 3, kind: "pr", audit: false }), 5);
  assert.equal(logicalStepCount({ chunks: 3, kind: "code", audit: false }), 4);
  assert.equal(logicalStepCount({ chunks: 2, kind: "pr", audit: true }), 5);
  assert.equal(logicalStepCount({ chunks: 2, kind: "code", audit: true }), 4);
  assert.equal(logicalStepCount({ chunks: 1, kind: "pr", audit: true }), 4);
});

test("httpMaxProviderCalls is min(maxCalls, 4*logicalSteps)", () => {
  assert.equal(httpMaxProviderCalls(52, 5), 20);
  assert.equal(httpMaxProviderCalls(52, 20), 52);
  assert.equal(httpMaxProviderCalls(52, 0), 0);
  assert.equal(httpMaxProviderCalls(10, 3), 10);
});
