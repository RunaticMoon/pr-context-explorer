import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPlanBody,
  buildRunBody,
  dropPlanId,
  httpEngineKey,
  samePlanContext,
  sameScope,
  usablePlanId,
  type LivePlanContext,
  type LiveRunFields,
  type StoredLivePlan,
} from "../src/live-http-run.ts";
import type { HttpEngineView } from "../src/ai-contract.ts";
import type { Scope } from "../src/server/live-analysis.ts";

const PR_SCOPE: Scope = { kind: "pr" };
const CODE_SCOPE: Scope = {
  kind: "code",
  commitSha: "a".repeat(40),
  fileId: "file-1",
  side: "new",
  lineStart: 2,
  lineEnd: 7,
  question: "이 범위는 무엇을 하나요?",
};

function fakeView(overrides: Partial<HttpEngineView> = {}): HttpEngineView {
  return {
    providerId: "openai-compatible",
    transport: "http",
    configId: "cfg-FAKE",
    revision: 3,
    host: "api.example.test:8443",
    model: "fake-http-model",
    hasApiKey: true,
    verification: "verified",
    blockers: [],
    ready: true,
    ...overrides,
  };
}

function httpContext(
  overrides: Partial<LivePlanContext> = {},
): LivePlanContext {
  return {
    snapshotId: "snap-1",
    scope: PR_SCOPE,
    audit: false,
    allowHistoricalSteps: false,
    providerId: "openai-compatible",
    model: "fake-http-model",
    engine: httpEngineKey(fakeView()),
    ...overrides,
  };
}

function cliContext(overrides: Partial<LivePlanContext> = {}): LivePlanContext {
  return {
    snapshotId: "snap-1",
    scope: PR_SCOPE,
    audit: false,
    allowHistoricalSteps: false,
    providerId: "codex",
    model: "cli-model",
    ...overrides,
  };
}

function runFields(overrides: Partial<LiveRunFields> = {}): LiveRunFields {
  return {
    snapshotId: "snap-1",
    providerId: "codex",
    model: "cli-model",
    scope: PR_SCOPE,
    consent: true,
    audit: false,
    auditConsent: false,
    allowHistoricalSteps: false,
    refresh: false,
    ...overrides,
  };
}

function storedPlan(
  context: LivePlanContext,
  planId = "f".repeat(32),
): StoredLivePlan {
  return {
    response: {
      snapshotId: context.snapshotId,
      scope: context.scope,
      plannedChunks: 2,
      maxProviderCalls: 12,
      auditCalls: context.audit ? 1 : 0,
      serializedChunkBytes: 1024,
      note: "plan",
      ...(planId ? { planId } : {}),
      engine: context.engine
        ? {
            transport: "http",
            providerId: context.providerId,
            ...context.engine,
          }
        : undefined,
    },
    context,
  };
}

test("HTTP plan body carries provider, model and history policy", () => {
  assert.deepEqual(
    buildPlanBody(httpContext({ audit: true, allowHistoricalSteps: true })),
    {
      snapshotId: "snap-1",
      scope: PR_SCOPE,
      audit: true,
      providerId: "openai-compatible",
      model: "fake-http-model",
      allowHistoricalSteps: true,
    },
  );
});

test("CLI plan body keeps exactly the original field set", () => {
  for (const providerId of ["codex", "claude"] as const) {
    assert.deepEqual(buildPlanBody(cliContext({ providerId, audit: true })), {
      snapshotId: "snap-1",
      scope: PR_SCOPE,
      audit: true,
    });
  }
});

test("HTTP run body appends the one-shot planId", () => {
  const body = buildRunBody(
    runFields({
      providerId: "openai-compatible",
      model: "fake-http-model",
      consent: true,
      audit: true,
      auditConsent: true,
    }),
    "f".repeat(32),
  );
  assert.equal(body.planId, "f".repeat(32));
  assert.equal(body.providerId, "openai-compatible");
  assert.equal(body.model, "fake-http-model");
  assert.equal(body.auditConsent, true);
});

test("CLI run body is unchanged: same field set, no planId", () => {
  const body = buildRunBody(runFields());
  assert.deepEqual(
    Object.keys(body).sort(),
    [
      "allowHistoricalSteps",
      "audit",
      "auditConsent",
      "consent",
      "model",
      "providerId",
      "refresh",
      "scope",
      "snapshotId",
    ].sort(),
  );
  assert.deepEqual(body, {
    snapshotId: "snap-1",
    providerId: "codex",
    model: "cli-model",
    scope: PR_SCOPE,
    consent: true,
    audit: false,
    auditConsent: false,
    allowHistoricalSteps: false,
    refresh: false,
  });
});

test("run body omits planId when none is supplied", () => {
  const body = buildRunBody(
    runFields({ providerId: "openai-compatible", model: "m" }),
    undefined,
  );
  assert.ok(!("planId" in body));
});

test("usablePlanId returns the stored planId when the context matches", () => {
  const context = httpContext();
  assert.equal(
    usablePlanId(storedPlan(context), { ...context }),
    "f".repeat(32),
  );
});

test("usablePlanId rejects a plan when the engine revision changed", () => {
  const context = httpContext();
  const plan = storedPlan(context);
  const bumped = httpContext({
    engine: httpEngineKey(fakeView({ revision: 4 })),
  });
  assert.equal(usablePlanId(plan, bumped), undefined);
  const reKeyed = httpContext({
    engine: httpEngineKey(fakeView({ configId: "cfg-other" })),
  });
  assert.equal(usablePlanId(plan, reKeyed), undefined);
  const remodeled = httpContext({
    engine: httpEngineKey(fakeView({ model: "other-model" })),
    model: "other-model",
  });
  assert.equal(usablePlanId(plan, remodeled), undefined);
});

test("usablePlanId rejects a plan when scope, audit or history changed", () => {
  const context = httpContext();
  const plan = storedPlan(context);
  assert.equal(
    usablePlanId(plan, httpContext({ scope: CODE_SCOPE })),
    undefined,
  );
  assert.equal(usablePlanId(plan, httpContext({ audit: true })), undefined);
  assert.equal(
    usablePlanId(plan, httpContext({ allowHistoricalSteps: true })),
    undefined,
  );
  assert.equal(
    usablePlanId(plan, httpContext({ snapshotId: "snap-2" })),
    undefined,
  );
});

test("usablePlanId blocks an HTTP run when no planId is stored", () => {
  const context = httpContext();
  assert.equal(usablePlanId(undefined, context), undefined);
  assert.equal(usablePlanId(storedPlan(context, ""), context), undefined);
  assert.equal(
    usablePlanId({ response: { planId: 42 }, context }, context),
    undefined,
  );
  const consumed = dropPlanId(storedPlan(context));
  assert.equal(usablePlanId(consumed, context), undefined);
});

test("dropPlanId removes only the planId and keeps the plan display", () => {
  const context = httpContext();
  const plan = storedPlan(context);
  const dropped = dropPlanId(plan);
  assert.ok(!("planId" in dropped.response));
  assert.equal(dropped.response.plannedChunks, 2);
  assert.equal(dropped.context, plan.context);
  // No planId at all: the same object is returned untouched.
  const cliPlan = storedPlan(cliContext(), "");
  assert.equal(dropPlanId(cliPlan), cliPlan);
});

test("sameScope compares the full selected-code range", () => {
  assert.ok(sameScope(PR_SCOPE, { kind: "pr" }));
  assert.ok(sameScope(CODE_SCOPE, { ...CODE_SCOPE }));
  assert.ok(!sameScope(PR_SCOPE, CODE_SCOPE));
  for (const variant of [
    { ...CODE_SCOPE, commitSha: "b".repeat(40) },
    { ...CODE_SCOPE, fileId: "file-2" },
    { ...CODE_SCOPE, side: "old" as const },
    { ...CODE_SCOPE, lineStart: 3 },
    { ...CODE_SCOPE, lineEnd: 8 },
    { ...CODE_SCOPE, question: "다른 질문" },
  ])
    assert.ok(!sameScope(CODE_SCOPE, variant));
});

test("samePlanContext treats CLI contexts without an engine key", () => {
  assert.ok(samePlanContext(cliContext(), { ...cliContext() }));
  assert.ok(!samePlanContext(cliContext(), httpContext()));
});

test("httpEngineKey projects only public identity fields", () => {
  assert.equal(httpEngineKey(undefined), undefined);
  assert.equal(httpEngineKey(null), undefined);
  assert.deepEqual(httpEngineKey(fakeView()), {
    configId: "cfg-FAKE",
    revision: 3,
    model: "fake-http-model",
  });
});
