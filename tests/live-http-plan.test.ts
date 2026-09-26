import test from "node:test";
import assert from "node:assert/strict";
import { objectFixture } from "./core-review-helpers.ts";
import {
  analysisIdentity,
  createPlanBudget,
  transmissionPlan,
  type PlanEngine,
} from "../src/server/live-pipeline.ts";
import { planContext } from "../src/server/analysis-v3/index.ts";
import { HTTP_LIMITS } from "../src/ai-contract.ts";
import { AIError } from "../src/server/ai/errors.ts";
import type { Connection } from "../src/server/github.ts";
import type { LiveSnapshot } from "../src/server/analysis-v3/index.ts";

type T = { after: (fn: () => void) => void };

const httpEngine = (overrides: Partial<PlanEngine> = {}): PlanEngine => ({
  transport: "http",
  providerId: "openai-compatible",
  model: "fixture-model",
  host: "api.example.invalid:8443",
  configId: "cfg-fixture-1",
  revision: 7,
  ...overrides,
});

async function singleFileSnapshot(t: T): Promise<LiveSnapshot> {
  const f = objectFixture(t);
  const base = f.commit({
    "core.ts": "export const a = 1;\nexport const b = 2;\n",
  });
  const head = f.commit(
    { "core.ts": "export const a = 3;\nexport const b = 4;\n" },
    [base],
  );
  return f.collect(base, head);
}

async function emptySnapshot(t: T): Promise<LiveSnapshot> {
  const s = structuredClone(await singleFileSnapshot(t));
  s.evidence = [];
  s.sourceEvidence = [];
  s.coverage.complete = false;
  s.coverage.unavailable = ["No retrievable evidence"];
  return s;
}

async function multiFileSnapshot(t: T): Promise<LiveSnapshot> {
  const f = objectFixture(t);
  const base = f.commit({
    ...Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [`m${i}.ts`, `export const m = ${i};\n`]),
    ),
    "keep.ts": "export const k = 0;\n",
  });
  const head = f.commit(
    {
      ...Object.fromEntries(
        Array.from({ length: 4 }, (_, i) => [
          `m${i}.ts`,
          `export const m = ${i};\n// changed\n`,
        ]),
      ),
      "keep.ts": "export const k = 0;\n",
      "added.ts": "export const added = 1;\n",
    },
    [base],
  );
  return f.collect(base, head);
}

test("HTTP plan on an empty snapshot reserves nothing; audit adds no step", async (t) => {
  const s = await emptySnapshot(t);
  for (const audit of [false, true]) {
    const plan = transmissionPlan(s, { kind: "pr" }, audit, httpEngine());
    assert.equal(plan.plannedChunks, 0);
    assert.equal(plan.logicalSteps, 0);
    assert.equal(plan.maxProviderCalls, 0);
    assert.equal(
      plan.maxOutputTokensPerCall,
      HTTP_LIMITS.defaultMaxOutputTokens,
    );
    assert.equal(plan.totalOutputTokenReservation, 0);
    assert.equal(plan.inputByteLimit, plan.maxStageBytes);
    assert.deepEqual(plan.engine, {
      transport: "http",
      providerId: "openai-compatible",
      model: "fixture-model",
      host: "api.example.invalid:8443",
      configId: "cfg-fixture-1",
      revision: 7,
    });
  }
  // The legacy CLI shape is untouched and still counts the audit call.
  const cli = transmissionPlan(s, { kind: "pr" }, true);
  assert.equal(cli.maxProviderCalls, 1);
  assert.equal(cli.logicalSteps, undefined);
  assert.equal(cli.engine, undefined);
});

test("HTTP plan scales calls by 4x logical steps for a single-source plan", async (t) => {
  const s = await emptySnapshot(t);
  s.sourceEvidence = (await singleFileSnapshot(t)).sourceEvidence
    .filter((e) => e.sourceKind === "pr")
    .slice(0, 1);
  assert.equal(planContext(s, { kind: "pr" }).chunks.length, 1);
  const off = transmissionPlan(s, { kind: "pr" }, false, httpEngine());
  assert.equal(off.logicalSteps, 3);
  assert.equal(off.maxProviderCalls, 12);
  assert.equal(off.totalOutputTokenReservation, 12 * 8192);
  const on = transmissionPlan(s, { kind: "pr" }, true, httpEngine());
  assert.equal(on.logicalSteps, 4);
  assert.equal(on.maxProviderCalls, 16);
  assert.equal(on.totalOutputTokenReservation, 16 * 8192);
  // CLI stays at one call per logical step.
  assert.equal(transmissionPlan(s, { kind: "pr" }, true).maxProviderCalls, 4);
});

test("HTTP plan for a code scope counts chunks plus one code question step", async (t) => {
  const s = await singleFileSnapshot(t);
  const fileId = s.phases[0].files[0].id;
  const scope = {
    kind: "code" as const,
    commitSha: s.headSha,
    fileId,
    side: "old" as const,
    lineStart: 2,
    lineEnd: 2,
    question: "이 범위의 역할은?",
  };
  assert.equal(planContext(s, scope).chunks.length, 4);
  const plan = transmissionPlan(s, scope, false, httpEngine());
  assert.equal(plan.plannedChunks, 4);
  assert.equal(plan.logicalSteps, 5);
  assert.equal(plan.maxProviderCalls, 20);
  assert.equal(plan.totalOutputTokenReservation, 20 * 8192);
  const audited = transmissionPlan(s, scope, true, httpEngine());
  assert.equal(audited.logicalSteps, 6);
  assert.equal(audited.maxProviderCalls, 24);
  assert.equal(transmissionPlan(s, scope, true).maxProviderCalls, 6);
});

test("HTTP plan caps provider calls at the unchanged 52-call budget", async (t) => {
  const s = await multiFileSnapshot(t);
  assert.equal(planContext(s, { kind: "pr" }).chunks.length, 17);
  const plan = transmissionPlan(s, { kind: "pr" }, true, httpEngine());
  assert.equal(plan.plannedChunks, 17);
  assert.equal(plan.logicalSteps, 20);
  assert.equal(plan.maxProviderCalls, 52); // min(52, 4 * 20)
  assert.equal(plan.maxProviderCalls <= 4 * plan.logicalSteps!, true);
  assert.equal(plan.totalOutputTokenReservation, 52 * 8192);
  // CLI is not capped by the same multiplier.
  assert.equal(transmissionPlan(s, { kind: "pr" }, true).maxProviderCalls, 20);
});

test("HTTP plan honors per-call output token bounds and rejects invalid values", async (t) => {
  const s = await singleFileSnapshot(t);
  const scoped = transmissionPlan(s, { kind: "pr" }, false, httpEngine());
  const perCall = transmissionPlan(
    s,
    { kind: "pr" },
    false,
    httpEngine({ maxOutputTokens: 4096 }),
  );
  assert.equal(perCall.maxOutputTokensPerCall, 4096);
  assert.equal(
    perCall.totalOutputTokenReservation,
    perCall.maxProviderCalls * 4096,
  );
  const clamped = transmissionPlan(
    s,
    { kind: "pr" },
    false,
    httpEngine({ maxOutputTokens: HTTP_LIMITS.maxOutputTokens + 1 }),
  );
  assert.equal(clamped.maxOutputTokensPerCall, HTTP_LIMITS.maxOutputTokens);
  for (const bad of [0, -5, 1.5, NaN])
    assert.throws(
      () =>
        transmissionPlan(
          s,
          { kind: "pr" },
          false,
          httpEngine({ maxOutputTokens: bad }),
        ),
      /maxOutputTokens/,
    );
  assert.ok(scoped.maxOutputTokensPerCall === HTTP_LIMITS.defaultMaxOutputTokens);
});

test("CLI plan output is unchanged whether the engine argument is absent or cli", async (t) => {
  const s = await singleFileSnapshot(t);
  const scope = { kind: "pr" as const };
  for (const audit of [false, true]) {
    const legacy = transmissionPlan(s, scope, audit);
    assert.deepEqual(
      Object.keys(legacy).sort(),
      [
        "auditCalls",
        "maxProviderCalls",
        "maxStageBytes",
        "note",
        "omissions",
        "plannedChunks",
        "scope",
        "serializedChunkBytes",
        "snapshotId",
      ].sort(),
    );
    const cli = transmissionPlan(s, scope, audit, {
      transport: "cli",
      providerId: "codex",
      model: "fixture-model",
    });
    assert.deepEqual(cli, legacy);
    const chunks = planContext(s, scope).chunks.length;
    assert.equal(
      legacy.maxProviderCalls,
      Math.min(52, chunks + (chunks ? 2 : 0) + (audit ? 1 : 0)),
    );
  }
});

test("plan JSON carries public engine identity only, never key material", async (t) => {
  const s = await singleFileSnapshot(t);
  const plan = transmissionPlan(s, { kind: "pr" }, false, {
    ...httpEngine(),
    apiKey: "sk-super-secret-key",
    keyHash: "deadbeef".repeat(8),
    authorization: "Bearer sk-super-secret-key",
  } as any);
  const json = JSON.stringify(plan);
  for (const leak of [
    "sk-super-secret-key",
    "apiKey",
    "keyHash",
    "deadbeef",
    "authorization",
    "Bearer",
  ])
    assert.ok(!json.includes(leak), leak);
  assert.deepEqual(Object.keys(plan.engine!).sort(), [
    "configId",
    "host",
    "model",
    "providerId",
    "revision",
    "transport",
  ]);
});

test("analysisIdentity binds HTTP runs to configId/revision, never CLI", async (t) => {
  const s = await singleFileSnapshot(t);
  const connection = {
    id: "conn",
    type: "github",
    webUrl: "https://github.com",
    apiUrl: "https://api.github.com",
    apiVersion: "2022-11-28",
    account: "acct",
  } as Connection;
  const policy = { audit: false, allowHistoricalSteps: false };
  const cli = analysisIdentity(s, connection, { kind: "pr" }, "codex", "m", policy);
  assert.equal(
    analysisIdentity(s, connection, { kind: "pr" }, "codex", "m", policy, {}, {
      transport: "cli",
      providerId: "codex",
      model: "m",
    }),
    cli,
  );
  const at = (engine?: PlanEngine) =>
    analysisIdentity(
      s,
      connection,
      { kind: "pr" },
      "openai-compatible",
      "fixture-model",
      policy,
      {},
      engine,
    );
  const base = at(httpEngine({ revision: 1 }));
  assert.equal(at(httpEngine({ revision: 1 })), base);
  assert.notEqual(at(httpEngine({ revision: 2 })), base);
  assert.notEqual(at(httpEngine({ configId: "cfg-other", revision: 1 })), base);
  assert.notEqual(at(httpEngine({ host: "other.invalid", revision: 1 })), base);
  assert.notEqual(at(), base);
  assert.notEqual(at(httpEngine({ revision: 1 })), cli);
});

test("createPlanBudget enforces the planned call cap and token reservation", async (t) => {
  const s = await emptySnapshot(t);
  s.sourceEvidence = (await singleFileSnapshot(t)).sourceEvidence
    .filter((e) => e.sourceKind === "pr")
    .slice(0, 1);
  const plan = transmissionPlan(s, { kind: "pr" }, false, httpEngine());
  const budget = createPlanBudget(plan);
  assert.equal(budget.limit, plan.maxProviderCalls);
  assert.equal(budget.used, 0);
  assert.throws(() => budget.reserve(8193), AIError);
  assert.throws(() => budget.reserve(0), AIError);
  for (let i = 0; i < plan.maxProviderCalls; i++) budget.reserve(8192);
  assert.equal(budget.used, plan.maxProviderCalls);
  assert.equal(budget.view().limit, plan.maxProviderCalls);
  assert.throws(
    () => budget.reserve(1),
    (e: unknown) => e instanceof AIError && e.code === "call_budget_exceeded",
  );
  const zero = createPlanBudget(
    transmissionPlan(await emptySnapshot(t), { kind: "pr" }, false, httpEngine()),
  );
  assert.equal(zero.limit, 0);
  assert.throws(() => zero.reserve(1), AIError);
  const tight = createPlanBudget({
    maxProviderCalls: 4,
    maxOutputTokensPerCall: 8192,
    totalOutputTokenReservation: 8192,
  });
  tight.reserve(8192);
  assert.throws(() => tight.reserve(1), AIError);
});
