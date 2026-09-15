import React from "react";
import type {
  GroundedStatement,
  V3Output,
  TourStep,
  Question,
  PipelineResult,
} from "./server/analysis-v3/types";
export type EvidenceButtons = (ids: string[]) => React.ReactNode;
export function Grounded({
  value,
  label,
  buttons,
}: {
  value: GroundedStatement;
  label?: string;
  buttons: EvidenceButtons;
}) {
  return (
    <section className={`grounded grounded-${value.kind}`}>
      {label && <h4>{label}</h4>}
      <span className="badge">{value.kind}</span>
      <p>{value.text}</p>
      {buttons(value.evidenceIds)}
      {value.rationale && <p className="rationale">{value.rationale}</p>}
      {value.limitation && <p className="muted">한계: {value.limitation}</p>}
      <small>confidence {value.confidence} · 모델 자기평가, 검증 아님</small>
    </section>
  );
}
function Questions({
  items,
  buttons,
}: {
  items: Question[];
  buttons: EvidenceButtons;
}) {
  return (
    <>
      {items.map((q, i) => (
        <section key={i}>
          <Grounded
            label="사람이 확인할 질문"
            value={q.question}
            buttons={buttons}
          />
          <Grounded label="질문 이유" value={q.reason} buttons={buttons} />
        </section>
      ))}
    </>
  );
}
export function GroundedTourStep({
  output,
  step,
  buttons,
  choose,
}: {
  output: V3Output;
  step: TourStep;
  buttons: EvidenceButtons;
  choose: (id: string) => void;
}) {
  const tour = output.tour;
  return (
    <>
      <p className="revision">
        tourId {tour.tourId} · 고정 tourRevisionSha {tour.tourRevisionSha}
      </p>
      <Grounded label="투어 제목" value={tour.title} buttons={buttons} />
      <Grounded label="추천 이유" value={tour.rationale} buttons={buttons} />
      <h2>{step.title.text}</h2>
      <Grounded value={step.title} buttons={buttons} />
      <p className="revision">
        {step.historical ? "명시적으로 허용한 과거 단계" : "고정 head 단계"} ·{" "}
        {step.targetRevisionSha} · 비교 {step.comparisonFromSha || "없음"}
      </p>
      {step.historical && (
        <Grounded
          label="과거 문맥이 필요한 이유"
          value={step.historicalReason}
          buttons={buttons}
        />
      )}
      {(
        [
          ["whyNow", "지금 읽는 이유"],
          ["previousConnection", "이전 연결"],
          ["explanation", "설명"],
          ["beforeAfter", "변경 전후"],
          ["relationToGoal", "목표와 관계"],
          ["nextTransition", "다음 이유"],
        ] as const
      ).map(([k, label]) => (
        <Grounded key={k} label={label} value={step[k]} buttons={buttons} />
      ))}
      {buttons(step.focusEvidenceIds)}
      <p>
        선행 단계: {step.prerequisiteStepIds.join(", ") || "없음"} · 파일:{" "}
        {step.focusFileIds.join(", ")}
      </p>
      <p>
        hunk: {step.focusHunkIds.join(", ") || "없음"} · AST 강조:{" "}
        {step.focusGraphEdgeIds.join(", ") || "없음"} · 요구:{" "}
        {step.requirementIds.join(", ") || "없음"}
      </p>
      <Questions items={step.checkpointQuestions} buttons={buttons} />
      <section data-testid="live-story-edges">
        <h3>StoryEdge · 읽기 순서 (코드 관계 아님)</h3>
        {tour.storyEdges.map((edge) => (
          <section key={edge.id}>
            <button onClick={() => choose(edge.fromStepId)}>
              {edge.fromStepId}
            </button>{" "}
            →{" "}
            <button onClick={() => choose(edge.toStepId)}>
              {edge.toStepId}
            </button>
            <Grounded value={edge.reason} buttons={buttons} />
          </section>
        ))}
        {!tour.storyEdges.length && <p>읽기 연결 없음</p>}
      </section>
      <Grounded
        label="투어 요약 / 미확인 사항"
        value={tour.summary}
        buttons={buttons}
      />
    </>
  );
}
export function GroundedRequirements({
  output: a,
  buttons,
}: {
  output: V3Output;
  buttons: EvidenceButtons;
}) {
  return (
    <>
      {a.requirements.map((r) => (
        <section key={r.id}>
          <h4>{r.id}</h4>
          <p>{r.sourceRole} · 명시 AC / 추출 요구 / 해석 제안 구별</p>
          <Grounded value={r.statement} buttons={buttons} />
          {buttons(r.sourceEvidenceIds)}
        </section>
      ))}
      {a.requirementMappings.map((r, i) => (
        <section key={i}>
          <h4>
            {r.requirementId} · {r.status}
          </h4>
          <Grounded value={r.explanation} buttons={buttons} />
          {buttons(r.evidenceIds)}
          <p>
            revision {r.commitShas.join(", ")} · 파일 {r.fileIds.join(", ")}
          </p>
          <p>테스트 원문 근거 (실행 아님)</p>
          {buttons(r.testEvidenceIds)}
        </section>
      ))}
    </>
  );
}
export function GroundedDetails({
  output: a,
  phaseSha,
  comparisonSha,
  fileId,
  side,
  start,
  end,
  evidence,
  buttons,
}: {
  output: V3Output;
  phaseSha: string;
  comparisonSha: string | null;
  fileId?: string;
  side?: string;
  start: number;
  end: number;
  evidence: PipelineResult["evidence"];
  buttons: EvidenceButtons;
}) {
  return (
    <>
      <section data-testid="live-v3-overview">
        <h3>PR 개요 · 출처와 추론 구별</h3>
        {Object.entries(a.overview).map(([k, v]) => (
          <Grounded key={k} label={k} value={v} buttons={buttons} />
        ))}
      </section>
      {a.changeGroups.map((g) => (
        <section key={g.id}>
          <Grounded label="변화 묶음" value={g.title} buttons={buttons} />
          <Grounded label="변경 목적" value={g.purpose} buttons={buttons} />
          {buttons(g.evidenceIds)}
          <p>
            {g.commitShas.join(", ")} · {g.fileIds.join(", ")}
          </p>
        </section>
      ))}
      {a.phaseSummaries
        .filter((p) => p.commitSha === phaseSha)
        .map((p) => (
          <section key={p.commitSha + p.comparisonFromSha}>
            {(
              [
                "title",
                "before",
                "changes",
                "why",
                "limitationsOfPhase",
              ] as const
            ).map((k) => (
              <Grounded key={k} label={k} value={p[k]} buttons={buttons} />
            ))}
            <p>
              강조 파일 {p.focusFileIds.join(", ")} · AST{" "}
              {p.focusGraphEdgeIds.join(", ")} · hunk{" "}
              {p.focusHunkIds.join(", ")}
            </p>
          </section>
        ))}
      {a.codeExplanations
        .filter(
          (c) =>
            c.targetRevisionSha === phaseSha &&
            c.comparisonFromSha === comparisonSha &&
            c.fileId === fileId &&
            c.selectedEvidenceIds.some((id) => {
              const e = evidence.find((e) => e.id === id);
              return (
                e && e.side === side && e.lineStart <= end && e.lineEnd >= start
              );
            }),
        )
        .map((c) => (
          <section key={c.id} data-testid="live-grounded-code">
            <h3>코드 설명 · {c.contextKind}</h3>
            <p className="revision">
              {c.targetRevisionSha} · 비교 {c.comparisonFromSha}
            </p>
            {buttons(c.selectedEvidenceIds)}
            {(
              [
                ["answerToQuestion", "선택 코드 답변"],
                ["roleInPR", "PR에서 역할"],
                ["responsibility", "책임"],
                ["inputsOutputs", "입출력"],
                ["behavior", "동작"],
                ["beforeAfter", "변경 전후"],
                ["sideEffects", "부작용"],
                ["errorHandling", "오류 처리"],
              ] as const
            ).map(([k, label]) => (
              <Grounded key={k} label={label} value={c[k]} buttons={buttons} />
            ))}
            {c.relationships.map((r, i) => (
              <section key={i}>
                <p>
                  {r.kind} · {r.referenceId}
                </p>
                <Grounded value={r.explanation} buttons={buttons} />
              </section>
            ))}
            {c.requirementLinks.map((r, i) => (
              <section key={i}>
                <p>요구 {r.requirementId}</p>
                <Grounded value={r.explanation} buttons={buttons} />
              </section>
            ))}
            <p>테스트 원문 근거 (실행 아님)</p>
            {buttons(c.testEvidenceIds)}
            <Questions items={c.reviewQuestions} buttons={buttons} />
            {c.nextReadingSuggestions.map((n, i) => (
              <section key={i}>
                <p>
                  후속 읽기 {n.fileId} · {n.targetRevisionSha}
                </p>
                <Grounded value={n.reason} buttons={buttons} />
                {buttons(n.evidenceIds)}
              </section>
            ))}
          </section>
        ))}
      <section data-testid="live-discrepancies">
        <h3>불일치 · 양쪽 근거</h3>
        {a.discrepancies.map((d) => (
          <section key={d.id}>
            <Grounded value={d.explanation} buttons={buttons} />
            <h4>원문 측</h4>
            {buttons(d.sourceEvidenceIds)}
            <h4>코드 측</h4>
            {buttons(d.codeEvidenceIds)}
            <p>요구 {d.requirementIds.join(", ")}</p>
            <Grounded
              label="확인 / 해결 방향"
              value={d.resolution}
              buttons={buttons}
            />
          </section>
        ))}
        {!a.discrepancies.length && (
          <p>보고된 불일치 없음 · 불일치 부재를 보증하지 않음</p>
        )}
      </section>
      {a.inferredEdgeSuggestions
        .filter((e) => e.revisionSha === phaseSha)
        .map((e) => (
          <section key={e.id} className="inferred-edge">
            <h4>추정 관계 · {e.relationType} · static 아님</h4>
            <p>
              {e.fromFileId} → {e.toFileId}
            </p>
            <Grounded value={e.explanation} buttons={buttons} />
          </section>
        ))}
      <Questions items={a.reviewQuestions} buttons={buttons} />
    </>
  );
}
export function PipelineStatus({
  result: r,
  buttons,
}: {
  result: PipelineResult;
  buttons: EvidenceButtons;
}) {
  const a = r.output,
    coverage = r.coverage,
    audit = r.semanticAudit;
  return (
    <>
      <section
        className={`notice analysis-${a.analysisStatus}`}
        data-testid="live-analysis-status"
        role="status"
      >
        <b>
          프로세스 {r.processStatus} · 분석 {a.analysisStatus}
        </b>
        <p>
          {a.analysisStatus === "complete"
            ? "전달 범위 분석 완료 · 전체 저장소/요구 충족/안전성 보증 아님"
            : a.analysisStatus === "partial"
              ? "부분 분석 · 누락과 한계를 확인하세요"
              : "자료 부족 · 정상 충분한 분석이 아닙니다"}
        </p>
        <p>
          위치 검증 {r.deterministicValidation.status} · 의미 감사{" "}
          {audit.status} · 의미적 지지 확정 아님
        </p>
      </section>
      {a.limitations.map((v, i) => (
        <Grounded key={i} label="분석 한계" value={v} buttons={buttons} />
      ))}
      <section data-testid="live-missing-context">
        <h3>MissingContext · 추가 자료는 자동 수집하지 않음</h3>
        {a.missingContext.map((m, i) => (
          <section key={i}>
            <h4>{m.target}</h4>
            <Grounded label="필요 이유" value={m.reason} buttons={buttons} />
            <Grounded label="사용 목적" value={m.purpose} buttons={buttons} />
          </section>
        ))}
      </section>
      <section data-testid="live-pipeline-coverage">
        <h3>모델 분할 Coverage · Git/AST 수집과 별개</h3>
        <p>
          발견 {coverage.discovered} · 확보 {coverage.retrieved} · 계획 분할{" "}
          {coverage.plannedChunks} · 검증된 분할 {coverage.analyzedChunks} ·
          실패 {coverage.failedChunks} · 미시작 {coverage.notStartedChunks} ·
          통합 {coverage.synthesizedChunkIds.length}
        </p>
        <p>
          이 저장 실행의 전송 근거{" "}
          {coverage.currentRunTransmittedEvidenceIds.length} · 캐시 재사용 포함
          처리 근거 {coverage.transmittedEvidenceIds.length} · 인용 근거{" "}
          {coverage.citedEvidenceIds.length}
        </p>
        <p>
          이 화면의 읽기/캐시 복원은 새 모델 전송 0회. 위 수치는 저장된 실행
          기록입니다.
        </p>
        {[...coverage.omitted, ...coverage.unavailable].map((o, i) => (
          <p key={i}>
            {o.category} · {o.target} · {o.reason} · {o.purpose}
          </p>
        ))}
        <details>
          <summary>작업별 검증 / 캐시 / 사용량 metadata</summary>
          <pre>{JSON.stringify(r.metadata.stages, null, 2)}</pre>
          <pre>{JSON.stringify(coverage, null, 2)}</pre>
        </details>
      </section>
      <section data-testid="live-semantic-audit">
        <h3>선택 의미 감사 · {audit.status}</h3>
        {audit.failureCode && <p>{audit.failureCode}</p>}
        {audit.output && (
          <>
            <Grounded
              label="감사 범위"
              value={audit.output.scopeSummary}
              buttons={buttons}
            />
            <p>
              검토 {audit.output.assessedJsonPointers.length} · 미확인{" "}
              {audit.output.unableToVerify.length} · 문제{" "}
              {audit.output.issues.length}
            </p>
            {audit.output.issues.map((i, n) => (
              <section key={n}>
                <p>
                  {i.targetJsonPointer} · {i.category} · {i.severity} ·{" "}
                  {i.action}
                </p>
                <Grounded value={i.reason} buttons={buttons} />
                {buttons(i.evidenceIds)}
              </section>
            ))}
            <details>
              <summary>미확인 진술 / 검토 pointer / 보류 원문</summary>
              {audit.output.unableToVerify.map((u, i) => (
                <section key={i}>
                  <p>{u.targetJsonPointer}</p>
                  <Grounded value={u.reason} buttons={buttons} />
                </section>
              ))}
              <pre>
                {JSON.stringify(
                  {
                    assessed: audit.output.assessedJsonPointers,
                    disputedOriginals: audit.dispositions,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </>
        )}
        <p>
          위치 검사는 의미적 지지를 증명하지 않습니다. 선택 감사 역시 모델
          점검이며 사람의 검토/대상 테스트 실행을 대체하지 않습니다.
        </p>
      </section>
    </>
  );
}
