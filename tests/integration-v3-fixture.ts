import { objectFixture } from "./core-review-helpers.ts";
import {
  fixtureRunner,
  observed,
  unknown,
  step,
} from "./analysis-v3-fixtures.test.ts";
import {
  collectStatements,
  type PipelineRunner,
  type LiveSnapshot,
} from "../src/server/analysis-v3/index.ts";
export { observed, unknown };
export async function richSnapshot(t: { after: (fn: () => void) => void }) {
  const f = objectFixture(t);
  const base = f.commit({ "a.ts": "export const value = 1;\n" });
  const middle = f.commit(
    { "a.ts": "export const value = 2;\n" },
    [base],
    "중간 원문 · FAKE fixture",
  );
  const head = f.commit(
    {
      "a.ts": "export const value = 3;\n",
      "b.ts": 'import { value } from "./a";\nexport const answer = value;\n',
    },
    [middle],
    "마지막 원문 · FAKE fixture",
  );
  return f.collect(base, head);
}
/** Bounded deterministic model-shaped JSON, not AI output or semantic quality evidence. */
export function richRunner(
  s: LiveSnapshot,
  calls: any[],
  mode: "complete" | "insufficient_context" = "complete",
): PipelineRunner {
  const base = fixtureRunner(s, calls);
  return async (request) => {
    if (request.stage === "audit") {
      calls.push(request);
      return {
        output: {
          schemaVersion: "3",
          snapshotId: s.snapshotId,
          assessedJsonPointers: ["/overview/oneLiner"],
          issues: [],
          unableToVerify: collectStatements(request.context.candidate)
            .filter((x) => x.pointer !== "/overview/oneLiner")
            .map((x) => ({
              targetJsonPointer: x.pointer,
              reason: unknown("FAKE 의미 점검 미확인"),
            })),
          scopeSummary: unknown("FAKE 감사 fixture · 실제 의미 검증 아님"),
        },
        metadata: {
          providerId: request.providerId,
          model: request.model,
          fallbackUsed: false,
          fixtureInferenceNotPerformed: true,
        },
      };
    }
    const r = await base(request);
    const bundle = request.context.bundle;
    const head = bundle.code.find(
      (x) => x.evidence.commitSha === s.headSha && x.evidence.side === "new",
    )?.evidence;
    if (request.stage === "synthesis") {
      const x = r.output as any;
      const e = head || bundle.code[0]?.evidence;
      x.overview.oneLiner = { ...observed(e.id), text: "FAKE PR 맥락 보존" };
      x.overview.inferredIntent = {
        ...observed(e.id),
        kind: "inferred",
        text: "FAKE 의도 추정",
        rationale: "FAKE 추정 연결 이유",
        limitation: "저자에게 확인하지 않았다.",
      };
      x.codeExplanations[0].roleInPR.text = "FAKE 코드 역할";
      x.codeExplanations[0].answerToQuestion = {
        ...observed(e.id),
        text:
          request.context.bundle.scope.kind === "code"
            ? "FAKE 선택 코드 답변"
            : "FAKE PR 코드 설명",
      };
      x.codeExplanations[0].contextKind =
        bundle.scope.kind === "code" ? "selected_range" : "changed_code";
      if (bundle.scope.kind === "pr") {
        const source = bundle.sources.find((x) => x.sourceKind === "pr")!;
        const proof = {
          ...observed(e.id),
          text: "FAKE 원문과 코드 불일치",
          evidenceIds: [source.id, e.id],
        };
        x.requirements = [
          {
            id: "requirement:fixture",
            sourceRole: "extracted_requirement",
            sourceEvidenceIds: [source.id],
            statement: {
              ...observed(source.id),
              text: "FAKE 원문에서 추출한 요구",
            },
          },
        ];
        x.requirementMappings = [
          {
            requirementId: "requirement:fixture",
            status: "contradicted",
            explanation: proof,
            commitShas: [e.commitSha],
            fileIds: [e.fileId],
            evidenceIds: [source.id, e.id],
            testEvidenceIds: [],
          },
        ];
        x.discrepancies = [
          {
            id: "discrepancy:fixture",
            requirementIds: ["requirement:fixture"],
            sourceEvidenceIds: [source.id],
            codeEvidenceIds: [e.id],
            explanation: proof,
            resolution: unknown("FAKE 작성자 확인 필요"),
          },
        ];
        const edge = bundle.edges.find((x) => x.revisionSha === s.headSha);
        if (edge)
          x.inferredEdgeSuggestions = [
            {
              id: "inferred:fixture",
              fromFileId: edge.source,
              toFileId: edge.target,
              revisionSha: s.headSha,
              relationType: "possible_call",
              evidenceSource: "inferred",
              explanation: {
                ...observed(edge.evidenceId),
                kind: "inferred",
                text: "FAKE 호출 가능성 · 정적 확인 아님",
                rationale: "import만으로 실행을 입증하지 못한다.",
                limitation: "실행하지 않았다.",
              },
            },
          ];
      }
      if (mode === "insufficient_context") {
        x.analysisStatus = mode;
        x.limitations = [unknown("FAKE 분석 자료 부족")];
        x.missingContext = [
          {
            target: "FAKE 추가 사양",
            reason: unknown("FAKE 필요한 이유"),
            purpose: unknown("FAKE 사용 목적"),
          },
        ];
      }
    }
    if (request.stage === "tour") {
      const x = r.output as any;
      const second: any = step(head!, "s2");
      second.title.text = "FAKE 두 번째 읽기";
      second.prerequisiteStepIds = ["s1"];
      x.tour.steps[0].title.text = "FAKE 고정 head 투어";
      const old = bundle.code.find((c) => c.evidence.commitSha === s.headSha && c.evidence.fileId === head!.fileId && c.evidence.side === "old")?.evidence;
      if (old) {
        x.tour.steps[0].focusEvidenceIds = [head!.id, old.id];
        x.tour.steps[0].beforeAfter = { ...observed(head!.id), text: "FAKE 이전/현재 비교", evidenceIds: [head!.id, old.id] };
      }
      x.tour.steps.push(second);
      x.tour.storyEdges = [
        {
          id: "story:fixture",
          fromStepId: "s1",
          toStepId: "s2",
          relation: "next_reading",
          reason: { ...observed(head!.id), text: "FAKE 다음 읽기 이유" },
        },
      ];
    }
    return r;
  };
}
