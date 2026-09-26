import test from "node:test";
import assert from "node:assert/strict";
import { HTTP_LIMITS } from "../src/ai-contract.ts";
import { AIError } from "../src/server/ai/errors.ts";
import {
  AnalysisConsentStore,
  type PlanBinding,
} from "../src/server/analysis-consent.ts";

const isAIError = (code: string) => (e: unknown) =>
  e instanceof AIError && e.code === code;

const baseBinding = (): PlanBinding => ({
  snapshotId: "snap-1",
  scopeKey: "pr:owner/repo#1",
  providerId: "openai-compatible",
  model: "model-a",
  configId: "cfg-1",
  revision: 3,
  audit: true,
  historical: false,
  maxProviderCalls: 8,
  maxOutputTokensPerCall: 8192,
  totalOutputTokenReservation: 65536,
});

/** Sequential ids that still satisfy the planId charset and length. */
const sequentialIds = () => {
  let n = 0;
  return () => (++n).toString(16).padStart(32, "0");
};

const without = (key: keyof PlanBinding): PlanBinding => {
  const b: Record<string, unknown> = { ...baseBinding() };
  delete b[key];
  return b as PlanBinding;
};

test("issuePlan returns a 128-bit unguessable hex planId", () => {
  const store = new AnalysisConsentStore();
  const a = store.issuePlan(baseBinding());
  const b = store.issuePlan(baseBinding());
  for (const id of [a, b]) {
    assert.equal(typeof id, "string");
    assert.equal(id.length, 32);
    assert.match(id, /^[0-9a-f]{32}$/);
  }
  assert.notEqual(a, b);
});

test("validatePlan accepts the exact binding once and consumes it", () => {
  const store = new AnalysisConsentStore();
  const binding = baseBinding();
  const planId = store.issuePlan(binding);
  assert.deepEqual(store.peek(planId), binding);
  assert.deepEqual(store.peek(planId), binding); // peek does not consume
  store.validatePlan(planId, binding);
  assert.throws(
    () => store.validatePlan(planId, binding),
    isAIError("invalid_request"),
  );
  assert.equal(store.peek(planId), undefined);
});

test("validatePlan rejects a binding differing in any single field", () => {
  const binding = baseBinding();
  const variants: PlanBinding[] = [
    { ...binding, snapshotId: "snap-2" },
    { ...binding, scopeKey: "code:owner/repo@abc" },
    { ...binding, providerId: "codex" },
    { ...binding, model: "model-b" },
    { ...binding, configId: "cfg-2" },
    { ...binding, revision: 4 },
    { ...binding, revision: 2.5 },
    { ...binding, audit: false },
    { ...binding, historical: true },
    { ...binding, maxProviderCalls: 9 },
    { ...binding, maxOutputTokensPerCall: 4096 },
    { ...binding, totalOutputTokenReservation: 65537 },
  ];
  for (const variant of variants) {
    const store = new AnalysisConsentStore();
    const planId = store.issuePlan(binding);
    assert.throws(
      () => store.validatePlan(planId, variant),
      isAIError("invalid_request"),
    );
  }
});

test("validatePlan rejects missing and extra binding fields", () => {
  const binding = baseBinding();
  const extra = { ...binding, unexpected: 1 } as PlanBinding;
  for (const presented of [
    without("snapshotId"),
    without("revision"),
    without("configId"),
    extra,
  ]) {
    const store = new AnalysisConsentStore();
    const planId = store.issuePlan(binding);
    assert.throws(
      () => store.validatePlan(planId, presented),
      isAIError("invalid_request"),
    );
  }
  // Presenting an optional field the issued plan never had is a mismatch.
  const minimal = without("configId");
  delete (minimal as Record<string, unknown>).revision;
  const store = new AnalysisConsentStore();
  const planId = store.issuePlan(minimal);
  assert.throws(
    () => store.validatePlan(planId, { ...minimal, configId: "cfg-9" }),
    isAIError("invalid_request"),
  );
});

test("a failed validation attempt consumes the plan", () => {
  const store = new AnalysisConsentStore();
  const binding = baseBinding();
  const planId = store.issuePlan(binding);
  assert.throws(
    () => store.validatePlan(planId, { ...binding, model: "other" }),
    isAIError("invalid_request"),
  );
  assert.throws(
    () => store.validatePlan(planId, binding),
    isAIError("invalid_request"),
  );
});

test("plans expire after ttlMs and are cleaned on access", () => {
  let now = 1_000;
  const store = new AnalysisConsentStore({
    now: () => now,
    ttlMs: 100,
    randomId: sequentialIds(),
  });
  const binding = baseBinding();
  const first = store.issuePlan(binding);
  now = 1_099; // boundary - 1: still live
  store.validatePlan(first, binding);
  const second = store.issuePlan(binding);
  now = 1_199; // boundary: expired
  assert.throws(
    () => store.validatePlan(second, binding),
    isAIError("invalid_request"),
  );
  assert.equal(store.peek(second), undefined);
});

test("default ttl is HTTP_LIMITS.planTtlMs", () => {
  let now = 0;
  const store = new AnalysisConsentStore({ now: () => now });
  const binding = baseBinding();
  const planId = store.issuePlan(binding);
  now = HTTP_LIMITS.planTtlMs - 1;
  assert.deepEqual(store.peek(planId), binding);
  now = HTTP_LIMITS.planTtlMs;
  assert.throws(
    () => store.validatePlan(planId, binding),
    isAIError("invalid_request"),
  );
});

test("invalidate(configId) drops only plans bound to that configId", () => {
  const store = new AnalysisConsentStore({ randomId: sequentialIds() });
  const cfg1 = baseBinding();
  const cfg2 = { ...baseBinding(), configId: "cfg-2" };
  const cli = { ...baseBinding(), providerId: "codex" };
  delete cli.configId;
  delete cli.revision;
  const p1a = store.issuePlan(cfg1);
  const p1b = store.issuePlan(cfg1);
  const p2 = store.issuePlan(cfg2);
  const p3 = store.issuePlan(cli);
  store.invalidate("cfg-1");
  assert.equal(store.peek(p1a), undefined);
  assert.equal(store.peek(p1b), undefined);
  assert.deepEqual(store.peek(p2), cfg2);
  assert.deepEqual(store.peek(p3), cli);
  assert.throws(
    () => store.validatePlan(p1a, cfg1),
    isAIError("invalid_request"),
  );
  // Unknown configIds are a no-op.
  store.invalidate("cfg-never-issued");
  assert.deepEqual(store.peek(p2), cfg2);
});

test("issuePlan evicts the oldest entry beyond maxEntries", () => {
  const store = new AnalysisConsentStore({
    maxEntries: 2,
    randomId: sequentialIds(),
  });
  const binding = baseBinding();
  const p1 = store.issuePlan(binding);
  const p2 = store.issuePlan(binding);
  const p3 = store.issuePlan(binding);
  assert.equal(store.peek(p1), undefined);
  assert.deepEqual(store.peek(p2), binding);
  assert.deepEqual(store.peek(p3), binding);
});

test("expired entries are swept before oldest-live eviction", () => {
  let now = 0;
  const store = new AnalysisConsentStore({
    now: () => now,
    ttlMs: 100,
    maxEntries: 2,
    randomId: sequentialIds(),
  });
  const binding = baseBinding();
  const p1 = store.issuePlan(binding);
  const p2 = store.issuePlan(binding);
  now = 200;
  const p3 = store.issuePlan(binding);
  assert.equal(store.peek(p1), undefined);
  assert.equal(store.peek(p2), undefined);
  assert.deepEqual(store.peek(p3), binding);
});

test("unknown planIds are rejected", () => {
  const store = new AnalysisConsentStore();
  const binding = baseBinding();
  const neverIssued = "f".repeat(32);
  assert.throws(
    () => store.validatePlan(neverIssued, binding),
    isAIError("invalid_request"),
  );
  assert.equal(store.peek(neverIssued), undefined);
});

test("issuePlan rejects malformed bindings", () => {
  const store = new AnalysisConsentStore();
  const binding = baseBinding();
  for (const bad of [
    null,
    "x",
    [],
    { ...binding, snapshotId: 1 },
    { ...binding, audit: "yes" },
    { ...binding, maxProviderCalls: 1.5 },
    { ...binding, maxProviderCalls: NaN },
    { ...binding, unexpected: 1 },
    without("model"),
  ])
    assert.throws(
      () => store.issuePlan(bad as PlanBinding),
      isAIError("invalid_request"),
    );
});

test("a colliding or weak randomId output is rejected", () => {
  const dup = new AnalysisConsentStore({ randomId: () => "a".repeat(32) });
  dup.issuePlan(baseBinding());
  assert.throws(
    () => dup.issuePlan(baseBinding()),
    isAIError("invalid_request"),
  );
  const weak = new AnalysisConsentStore({ randomId: () => "short" });
  assert.throws(
    () => weak.issuePlan(baseBinding()),
    isAIError("invalid_request"),
  );
});

test("constructor rejects invalid options", () => {
  for (const opts of [
    { ttlMs: 0 },
    { ttlMs: -1 },
    { ttlMs: NaN },
    { maxEntries: 0 },
    { maxEntries: -1 },
    { maxEntries: 1.5 },
  ])
    assert.throws(
      () => new AnalysisConsentStore(opts),
      isAIError("invalid_request"),
    );
});

test("clear() drops every outstanding plan", () => {
  const store = new AnalysisConsentStore();
  const binding = baseBinding();
  const planId = store.issuePlan(binding);
  store.clear();
  assert.equal(store.peek(planId), undefined);
  assert.throws(
    () => store.validatePlan(planId, binding),
    isAIError("invalid_request"),
  );
});
