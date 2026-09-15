import { objectFixture } from "./core-review-helpers.ts";
import type {
  GroundedStatement,
  LiveSnapshot,
} from "../src/server/analysis-v3/index.ts";
export const unknown = (text = "확인하지 못했다."): GroundedStatement => ({
  text,
  kind: "unknown",
  evidenceIds: [],
  confidence: "low",
  rationale: "",
  limitation:
    "제공된 근거로 확인하지 못했다. 대상 테스트/CI는 실행하지 않았다.",
});
export const observed = (id: string): GroundedStatement => ({
  text: "전달된 소스의 입력 경계를 읽는다.",
  kind: "observed",
  evidenceIds: [id],
  confidence: "medium",
  rationale: "",
  limitation: "",
});
export async function sample(t: {
  after: (fn: () => void) => void;
}): Promise<LiveSnapshot> {
  const f = objectFixture(t);
  const base = f.commit({ "core.ts": "export const n = 1;\n" });
  const a = f.commit(
    { "core.ts": "export const n = 2;\n" },
    [base],
    "Intermediate original",
  );
  const head = f.commit(
    { "core.ts": "export const n = 3;\n" },
    [a],
    "Head original",
  );
  return f.collect(base, head);
}
export function codeExplanation(e: any) {
  return {
    id: "code-summary",
    fileId: e.fileId,
    targetRevisionSha: e.commitSha,
    comparisonFromSha: e.comparisonFromSha,
    selectedEvidenceIds: [e.id],
    roleInPR: observed(e.id),
    responsibility: unknown(),
    inputsOutputs: unknown(),
    behavior: unknown(),
    beforeAfter: unknown(),
    sideEffects: unknown(),
    errorHandling: unknown(),
    answerToQuestion: unknown(),
    contextKind: "changed_code",
    relationships: [],
    requirementLinks: [],
    testEvidenceIds: [],
    reviewQuestions: [],
    nextReadingSuggestions: [],
  };
}
export function step(e: any, id = "s1") {
  return {
    id,
    title: observed(e.id),
    targetRevisionSha: e.commitSha,
    comparisonFromSha: e.comparisonFromSha,
    historical: false,
    historicalReason: unknown(),
    prerequisiteStepIds: [],
    whyNow: unknown(),
    previousConnection: unknown(),
    explanation: observed(e.id),
    beforeAfter: unknown(),
    relationToGoal: unknown(),
    focusFileIds: [e.fileId],
    focusHunkIds: [],
    focusEvidenceIds: [e.id],
    focusGraphEdgeIds: [],
    requirementIds: [],
    checkpointQuestions: [],
    nextTransition: unknown(),
  };
}
export function candidate(s: LiveSnapshot, e: any) {
  return {
    schemaVersion: "3",
    snapshotId: s.snapshotId,
    analysisStatus: "partial",
    limitations: [unknown()],
    missingContext: [],
    overview: Object.fromEntries(
      [
        "oneLiner",
        "problem",
        "statedIntent",
        "inferredIntent",
        "previousBehavior",
        "newBehavior",
        "strategy",
        "nonGoals",
      ].map((k) => [k, unknown()]),
    ),
    changeGroups: [],
    phaseSummaries: [],
    requirements: [],
    requirementMappings: [],
    codeExplanations: [codeExplanation(e)],
    discrepancies: [],
    inferredEdgeSuggestions: [],
    reviewQuestions: [],
    tour: {
      tourId: "tour-fixture",
      tourRevisionSha: s.headSha,
      title: unknown(),
      rationale: unknown(),
      summary: unknown(),
      steps: [step(e)],
      storyEdges: [],
    },
  };
}

export function fixtureRunner(
  s: LiveSnapshot,
  calls: any[],
  hook?: (r: any) => void,
) {
  return async (r: any) => {
    calls.push(r);
    hook?.(r);
    const ids = [
      ...r.context.bundle.code.map((x: any) => x.evidence.id),
      ...r.context.bundle.sources.map((e: any) => e.id),
    ];
    const e =
      r.context.bundle.code.find(
        (x: any) =>
          x.evidence.commitSha === s.headSha && x.evidence.side === "new",
      )?.evidence || r.context.bundle.code[0]?.evidence;
    const envelope = {
      schemaVersion: "3",
      snapshotId: s.snapshotId,
      analysisStatus: "complete",
      limitations: [],
      missingContext: [],
    };
    let output: any;
    if (r.stage === "chunk")
      output = {
        ...envelope,
        taskId: r.taskId,
        summary: observed(ids[0]),
        findings: ids.map(observed),
        codeExplanations: [],
      };
    else if (r.stage === "synthesis") {
      const { tour, ...rest } = candidate(s, e);
      output = { ...rest, ...envelope };
    } else if (r.stage === "tour")
      output = {
        ...envelope,
        tour: {
          tourId: r.context.task.tourId,
          tourRevisionSha: s.headSha,
          title: unknown(),
          rationale: unknown(),
          summary: unknown(),
          steps: [step(e)],
          storyEdges: [],
        },
      };
    else throw Error("unexpected stage");
    return {
      output,
      metadata: {
        providerId: r.providerId,
        model: r.model,
        observedModel: null,
        fixtureInferenceNotPerformed: true,
        fallbackUsed: false,
      },
    };
  };
}
