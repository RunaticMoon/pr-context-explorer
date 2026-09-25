import test from "node:test";
import assert from "node:assert/strict";
import { sample, fixtureRunner } from "./analysis-v3-fixtures.test.ts";
import type {
  LiveSnapshot,
  ProviderCallBudget,
  RunnerRequest,
  StageContext,
} from "../src/server/analysis-v3/index.ts";
// Deterministic runner fixtures test orchestration ONLY. No CLI/model inference occurs.
const api = () => import("../src/server/analysis-v3/index.ts");

const ENGINE: NonNullable<RunnerRequest["engine"]> = {
  transport: "http",
  providerId: "openai-compatible",
  model: "chosen",
  host: "127.0.0.1:18080",
  configId: "cfg-test",
  revision: 3,
};

const budget = (): ProviderCallBudget => {
  const b = {
    used: 0,
    limit: 16,
    reserve(_maxOutputTokens: number) {
      b.used += 1;
    },
  };
  return b;
};

const fixedContext = (s: LiveSnapshot): StageContext => ({
  bundle: {
    snapshotId: s.snapshotId,
    headSha: s.headSha,
    scope: { kind: "pr" },
    sourceHashes: {
      prMetadataHash: s.prMetadataHash,
      jiraSnapshotHashes: s.jiraSnapshotHashes,
    },
    phases: [],
    code: [],
    blobs: {},
    sources: [],
    sourceRoles: {},
    hunks: [],
    edges: [],
  },
  task: {
    taskId: "fixed-task",
    kind: "chunk",
    tourRevisionSha: s.headSha,
    allowHistoricalSteps: false,
    commitOrder: [],
  },
  summaries: [],
  omissions: { total: 0, items: [] },
  executionEvidence: { targetTestsExecuted: false, externalCIQueried: false },
});

const identityMismatch = async (promise: Promise<unknown>) => {
  const { ValidationError } =
    await import("../src/server/analysis-v3/schema.ts");
  await assert.rejects(promise, (e: any) => {
    assert.ok(e instanceof ValidationError);
    assert.equal(e.reasonCode, "runner_identity_mismatch");
    return true;
  });
};

test("openai-compatible http engine runs the pipeline and forwards providerId, engine and budget to the runner", async (t) => {
  const s = await sample(t),
    { runPipeline } = await api(),
    calls: any[] = [];
  const b = budget(),
    base = fixtureRunner(s, []);
  const result = await runPipeline({
    snapshot: s,
    providerId: "openai-compatible",
    model: "chosen",
    scope: { kind: "pr" },
    budget: b,
    engine: ENGINE,
    runner: async (r: any) => {
      calls.push(r);
      r.budget.reserve(8192);
      return base(r);
    },
  });
  assert.equal(result.processStatus, "succeeded");
  assert.ok(calls.length > 0);
  assert.ok(
    calls.every(
      (c) =>
        c.providerId === "openai-compatible" &&
        c.model === "chosen" &&
        c.engine === ENGINE &&
        c.budget === b,
    ),
  );
  assert.ok(b.used > 0);
  assert.equal(result.metadata.providerId, "openai-compatible");
  assert.equal(result.metadata.fallbackUsed, false);
});

test("openai-compatible requires a matching http engine identity and a provider call budget", async (t) => {
  const s = await sample(t),
    { runPipeline } = await api(),
    base = {
      snapshot: s,
      providerId: "openai-compatible" as const,
      model: "chosen",
      scope: { kind: "pr" as const },
      runner: fixtureRunner(s, []),
    };
  await identityMismatch(runPipeline({ ...base, budget: budget() }));
  await identityMismatch(runPipeline({ ...base, engine: ENGINE }));
  await identityMismatch(
    runPipeline({
      ...base,
      budget: budget(),
      engine: { ...ENGINE, model: "other" },
    }),
  );
  await identityMismatch(
    runPipeline({
      ...base,
      budget: budget(),
      engine: { ...ENGINE, providerId: "codex" },
    }),
  );
});

test("local providers reject http transport engines; the cli path is unchanged", async (t) => {
  const s = await sample(t),
    { runPipeline } = await api(),
    base = {
      snapshot: s,
      providerId: "codex" as const,
      model: "chosen",
      scope: { kind: "pr" as const },
      runner: fixtureRunner(s, []),
    };
  await identityMismatch(
    runPipeline({ ...base, budget: budget(), engine: ENGINE }),
  );
  await identityMismatch(
    runPipeline({
      ...base,
      engine: { ...ENGINE, providerId: "codex" },
    }),
  );
  const calls: any[] = [];
  const result = await runPipeline({
    ...base,
    runner: fixtureRunner(s, calls),
  });
  assert.equal(result.processStatus, "succeeded");
  assert.ok(
    calls.every(
      (c) =>
        c.providerId === "codex" &&
        c.engine === undefined &&
        c.budget === undefined,
    ),
  );
});

test("cli stage cache key is byte-identical to the pre-engine value", async (t) => {
  const s = await sample(t),
    { pipelineCacheKey } = await api();
  assert.equal(
    pipelineCacheKey(
      { snapshot: s, providerId: "codex", model: "chosen" },
      "chunk",
      { type: "object" },
      fixedContext(s),
    ),
    "v3:3392feb3157473f8f2b33b46ae2b9321d6352f02d35bc303e302142777a9d08e",
  );
});

test("http engine public identity participates in the stage cache key", async (t) => {
  const s = await sample(t),
    { pipelineCacheKey } = await api();
  const schema = { type: "object" },
    context = fixedContext(s);
  const at = (engine: NonNullable<RunnerRequest["engine"]>) =>
    pipelineCacheKey(
      {
        snapshot: s,
        providerId: "openai-compatible",
        model: "chosen",
        engine,
      },
      "chunk",
      schema,
      context,
    );
  assert.notEqual(at(ENGINE), at({ ...ENGINE, revision: 4 }));
  assert.notEqual(at(ENGINE), at({ ...ENGINE, configId: "cfg-other" }));
  assert.notEqual(at(ENGINE), at({ ...ENGINE, host: "10.0.0.1:8080" }));
  const bare = pipelineCacheKey(
    { snapshot: s, providerId: "openai-compatible", model: "chosen" },
    "chunk",
    schema,
    context,
  );
  assert.notEqual(at(ENGINE), bare);
});
