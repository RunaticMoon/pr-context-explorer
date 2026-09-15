import test from "node:test";
import assert from "node:assert/strict";
// These are explorer contract tests, NOT model inference or target code execution.
import {
  sample,
  candidate,
  unknown,
  observed as grounded,
  step,
} from "./analysis-v3-fixtures.test.ts";
const api = () => import("../src/server/analysis-v3/index.ts");
const observed = {
  text: "입력 경계를 확인한다.",
  kind: "observed",
  evidenceIds: ["code:1"],
  confidence: "high",
  rationale: "",
  limitation: "",
};

test("V3 important statements require proof, inference rationale and unknown limitation", async () => {
  const { validateGroundedStatement } = await api();
  assert.doesNotThrow(() =>
    validateGroundedStatement(observed, new Set(["code:1"])),
  );
  assert.throws(
    () =>
      validateGroundedStatement({ ...observed, evidenceIds: [] }, new Set()),
    /evidence/,
  );
  assert.throws(
    () =>
      validateGroundedStatement(
        { ...observed, kind: "inferred" },
        new Set(["code:1"]),
      ),
    /rationale/,
  );
  assert.throws(
    () =>
      validateGroundedStatement(
        { ...observed, kind: "unknown", evidenceIds: [] },
        new Set(),
      ),
    /limitation/,
  );
  assert.throws(
    () => validateGroundedStatement(observed, new Set()),
    /transmitted/,
  );
  assert.doesNotThrow(() =>
    validateGroundedStatement(
      {
        ...observed,
        kind: "unknown",
        evidenceIds: [],
        limitation: "대상 테스트를 실행하지 않았다.",
      },
      new Set(),
    ),
  );
  assert.throws(
    () =>
      validateGroundedStatement(
        { ...observed, safe: true },
        new Set(["code:1"]),
      ),
    /schema/,
  );
});

test("V3 validates every important nested field and rejects out-of-scope proof and counterfeit source facts", async (t) => {
  const s = await sample(t),
    { planContext, validateV3Output, mergeContexts } = await api();
  const p = planContext(s, { kind: "pr" }),
    context = mergeContexts(
      s,
      { kind: "pr" },
      p.chunks.map((c) => c.context),
    );
  const e = context.code.find(
    (c) => c.evidence.commitSha === s.headSha && c.evidence.side === "new",
  )!.evidence;
  const value = candidate(s, e);
  assert.doesNotThrow(() => validateV3Output(value, s, context));
  const pointers = [
    "tour.steps.0.title",
    "tour.steps.0.whyNow",
    "tour.steps.0.explanation",
    "tour.steps.0.beforeAfter",
    "tour.steps.0.nextTransition",
    "tour.steps.0.previousConnection",
    "tour.steps.0.relationToGoal",
    "codeExplanations.0.roleInPR",
    "codeExplanations.0.inputsOutputs",
    "codeExplanations.0.behavior",
    "codeExplanations.0.sideEffects",
    "codeExplanations.0.errorHandling",
    "codeExplanations.0.responsibility",
    "codeExplanations.0.answerToQuestion",
    "overview.problem",
  ];
  for (const pointer of pointers) {
    const bad: any = structuredClone(value),
      parts = pointer.split("."),
      key = parts.pop()!;
    parts.reduce((x, k) => x[k], bad)[key] = {
      ...grounded(e.id),
      evidenceIds: [],
    };
    assert.throws(
      () => validateV3Output(bad, s, context),
      /evidence|schema/,
      pointer,
    );
  }
  const bad = structuredClone(context);
  bad.code[0].evidence.lineEnd = 99999;
  assert.throws(() => validateV3Output(value, s, bad), /range/);
  assert.throws(
    () => validateV3Output(value, s, { ...context, code: [], blobs: {} }),
    /transmitted|graph/,
  );
  const sourceBad = structuredClone(context);
  sourceBad.sources[0].text = "invented";
  assert.throws(() => validateV3Output(value, s, sourceBad), /source/);
});

test("head tour is independent of commits, historical opt-in is explicit and story edges cannot become code edges", async (t) => {
  const s = await sample(t),
    { planContext, mergeContexts, validateV3Output } = await api();
  const context = mergeContexts(
    s,
    { kind: "pr" },
    planContext(s, { kind: "pr" }).chunks.map((c) => c.context),
  );
  const head = context.code.find(
    (c) => c.evidence.commitSha === s.headSha && c.evidence.side === "new",
  )!.evidence;
  const past = context.code.find(
    (c) =>
      c.evidence.commitSha === s.phases[0].sha && c.evidence.side === "new",
  )!.evidence;
  const value: any = candidate(s, head);
  value.tour.steps = [step(past, "past"), step(head)];
  assert.throws(() => validateV3Output(value, s, context), /head/);
  value.tour.steps[0].historical = true;
  value.tour.steps[0].historicalReason = {
    ...grounded(past.id),
    kind: "inferred",
    rationale: "중간 상태와 현재 상태의 차이를 비교한다.",
  };
  assert.throws(() => validateV3Output(value, s, context), /opt-in/);
  assert.doesNotThrow(() =>
    validateV3Output(value, s, context, { allowHistoricalSteps: true }),
  );
  value.tour.steps[1].prerequisiteStepIds = ["past"];
  value.tour.storyEdges = [
    {
      id: "story1",
      fromStepId: "past",
      toStepId: "s1",
      relation: "next_reading",
      reason: unknown(),
    },
  ];
  assert.doesNotThrow(() =>
    validateV3Output(value, s, context, { allowHistoricalSteps: true }),
  );
  value.tour.storyEdges.push({
    id: "story2",
    fromStepId: "s1",
    toStepId: "past",
    relation: "next_reading",
    reason: unknown(),
  });
  assert.throws(
    () => validateV3Output(value, s, context, { allowHistoricalSteps: true }),
    /cycle|order/,
  );
  value.tour.storyEdges.pop();
  value.tour.steps[1].focusGraphEdgeIds = ["invented"];
  assert.throws(
    () => validateV3Output(value, s, context, { allowHistoricalSteps: true }),
    /graph/,
  );
  value.tour.steps[1].focusGraphEdgeIds = [];
  value.tour.steps[1].focusHunkIds = ["invented"];
  assert.throws(
    () => validateV3Output(value, s, context, { allowHistoricalSteps: true }),
    /hunk/,
  );
  value.tour.steps[1].focusHunkIds = [];
  value.tour.steps[1].id = "past";
  assert.throws(
    () => validateV3Output(value, s, context, { allowHistoricalSteps: true }),
    /duplicate/,
  );
});

test("requirements distinguish explicit AC and source extraction; discrepancies retain conflicting source and code IDs", async (t) => {
  const s = await sample(t),
    { planContext, mergeContexts, validateV3Output } = await api();
  const c = mergeContexts(
    s,
    { kind: "pr" },
    planContext(s, { kind: "pr" }).chunks.map((c) => c.context),
  );
  const e = c.code.find(
      (x) => x.evidence.commitSha === s.headSha && x.evidence.side === "new",
    )!.evidence,
    source = c.sources.find((x) => x.sourceKind === "pr")!;
  const value: any = candidate(s, e);
  value.requirements = [
    {
      id: "req1",
      sourceRole: "explicit_acceptance_criteria",
      sourceEvidenceIds: [source.id],
      statement: grounded(source.id),
    },
  ];
  assert.throws(() => validateV3Output(value, s, c), /acceptance/);
  value.requirements[0].sourceRole = "extracted_requirement";
  value.requirementMappings = [
    {
      requirementId: "req1",
      status: "contradicted",
      explanation: grounded(e.id),
      commitShas: [s.headSha],
      fileIds: [e.fileId],
      evidenceIds: [source.id, e.id],
      testEvidenceIds: [],
    },
  ];
  assert.throws(() => validateV3Output(value, s, c), /discrepancy/);
  value.discrepancies = [
    {
      id: "d1",
      requirementIds: ["req1"],
      sourceEvidenceIds: [source.id],
      codeEvidenceIds: [e.id],
      explanation: { ...grounded(e.id), evidenceIds: [source.id, e.id] },
      resolution: unknown(),
    },
  ];
  assert.doesNotThrow(() => validateV3Output(value, s, c));
  value.discrepancies[0].sourceEvidenceIds = [e.id];
  assert.throws(() => validateV3Output(value, s, c), /source/);
  value.discrepancies[0].sourceEvidenceIds = [source.id];
  value.inferredEdgeSuggestions = [
    {
      id: "guess",
      fromFileId: e.fileId,
      toFileId: e.fileId,
      revisionSha: s.headSha,
      relationType: "possible_call",
      evidenceSource: "static",
      explanation: {
        ...grounded(e.id),
        kind: "inferred",
        rationale: "정적 증명이 아닌 해석이다.",
      },
    },
  ];
  assert.throws(() => validateV3Output(value, s, c), /schema|inferred/);
});

test("the transmitted JSON Schema itself rejects ungrounded claims, not just the TypeScript validator", async () => {
  const { default: Ajv } = await import("ajv"),
    { groundedStatementSchema } = await api(),
    check = new Ajv({ strict: true }).compile(groundedStatementSchema);
  assert.equal(check({ ...grounded("e"), evidenceIds: [] }), false);
  assert.equal(
    check({ ...grounded("e"), kind: "inferred", rationale: "   " }),
    false,
  );
  assert.equal(check({ ...unknown(), limitation: " " }), false);
  assert.equal(check(unknown()), true);
});

test("context proof includes immutable phase/hunk/source metadata and no unreferenced blob payload", async (t) => {
  const s = await sample(t),
    { planContext, mergeContexts, validateContextBundle } = await api();
  const c = mergeContexts(
    s,
    { kind: "pr" },
    planContext(s, { kind: "pr" }).chunks.map((c) => c.context),
  );
  for (const mutate of [
    (x: any) => (x.hunks[0].text = "forged patch"),
    (x: any) => (x.phases[0].parents = ["invented"]),
    (x: any) => (x.sourceHashes.prMetadataHash = "forged"),
    (x: any) => (x.blobs["hidden"] = "source outside selected context"),
    (x: any) =>
      (x.sources.find((e: any) => e.sourceKind === "pr").version = "forged"),
  ]) {
    const bad = structuredClone(c);
    mutate(bad);
    assert.throws(
      () => validateContextBundle(bad, s),
      /context|source|hunk|phase|blob/,
    );
  }
});

test("cached context cannot rename original evidence IDs or smuggle an arbitrary derived identity", async (t) => {
  const s = await sample(t),
    { planContext, mergeContexts, validateContextBundle } = await api(),
    c = mergeContexts(
      s,
      { kind: "pr" },
      planContext(s, { kind: "pr" }).chunks.map((c) => c.context),
    );
  const bad = structuredClone(c);
  bad.code[0].evidence.id = "invented-but-real-lines";
  assert.throws(() => validateContextBundle(bad, s), /evidence identity/);
});
