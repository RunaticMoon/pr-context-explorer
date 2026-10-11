import React from "react";
import type { LiveSnapshot } from "./server/live-git";
import type { V3Output, GroundedStatement } from "./server/analysis-v3/types";

/** Compare captured trees, never sum per-commit counts (reverts disappear). */
export function finalTreeChanges(s: LiveSnapshot) {
  if (
    !s.chosenComparisonBaseSha ||
    s.baseline.sha !== s.chosenComparisonBaseSha
  )
    return null;
  const head = s.phases.find((p) => p.sha === s.headSha);
  if (!head) return null;
  const before = new Map(
    s.baseline.files
      .filter((f) => f.status !== "deleted")
      .map((f) => [f.path, f]),
  );
  const after = new Map(
    head.files.filter((f) => f.status !== "deleted").map((f) => [f.path, f]),
  );
  return [...new Set([...before.keys(), ...after.keys()])].flatMap((path) => {
    const a = before.get(path),
      b = after.get(path);
    if (a && b && a.blobSha === b.blobSha && a.mode === b.mode) return [];
    return [{ path, status: !a ? "추가" : !b ? "삭제" : "수정" }];
  });
}

export function PrOverview({
  snapshot: s,
  output,
  expanded,
  currentSha,
  onToggle,
  onChoosePhase,
  onFinal,
  buttons,
}: {
  snapshot: LiveSnapshot;
  output?: V3Output;
  expanded: boolean;
  currentSha: string;
  onToggle: () => void;
  onChoosePhase: (sha: string) => void;
  onFinal: () => void;
  buttons: (ids: string[]) => React.ReactNode;
}) {
  const changes = finalTreeChanges(s);
  const areas = new Map<string, number>();
  changes?.forEach(({ path }) => {
    const area = path.includes("/")
      ? path.split("/").slice(0, -1).join("/") + "/"
      : "루트 파일";
    areas.set(area, (areas.get(area) || 0) + 1);
  });
  const position = s.phases.findIndex((p) => p.sha === currentSha) + 1;
  const intent =
    output?.overview.statedIntent.kind !== "unknown"
      ? output?.overview.statedIntent
      : output?.overview.inferredIntent;
  const outcome = output?.overview.newBehavior;
  const statement = (
    value: GroundedStatement | undefined,
    fallback: React.ReactNode,
  ) =>
    value && value.kind !== "unknown" ? (
      <>
        <span className="overview-source">
          {value.kind === "observed"
            ? "근거 포함 분석"
            : "AI 추정 · 의도 확인 필요"}
        </span>
        <p>{value.text}</p>
        {buttons(value.evidenceIds)}
        {(value.rationale || value.limitation) && (
          <details>
            <summary>추정 이유·한계</summary>
            <p>
              {value.rationale} {value.limitation}
            </p>
          </details>
        )}
      </>
    ) : (
      fallback
    );
  const bodyPreview = s.pr.body
    .trim()
    .split(/\n\s*\n/)[0]
    ?.slice(0, 480);
  return (
    <section
      className="pr-overview"
      aria-label="PR 전체 맥락"
      data-testid="pr-overview"
    >
      <div className="pr-overview-bar">
        <button
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls="pr-overview-content"
        >
          {expanded ? "전체 맥락 접기" : "PR 전체 맥락으로 돌아가기"}
        </button>
        <span>전체 → 실제 커밋 흐름 → 코드 근거</span>
        <small>
          {position
            ? `읽던 위치 ${position} / ${s.phases.length}`
            : currentSha
              ? "비교 기준"
              : "탐색 시작 전"}
        </small>
      </div>
      <div id="pr-overview-content" hidden={!expanded}>
        <div className="pr-overview-columns">
          <section>
            <h2>왜 필요한 PR인가</h2>
            {statement(
              intent,
              <>
                <span className="overview-source">
                  {bodyPreview
                    ? "PR 작성자 원문 · 요약 분석 전"
                    : "의도 미확인"}
                </span>
                <p className="overview-excerpt">
                  {bodyPreview ||
                    "PR 본문에 목적이 없습니다. 실제 커밋과 diff를 확인할 수 있습니다."}
                </p>
                {s.pr.body.length > (bodyPreview?.length || 0) && (
                  <details>
                    <summary>PR 본문 전체</summary>
                    <pre>{s.pr.body}</pre>
                  </details>
                )}
              </>,
            )}
          </section>
          <section>
            <h2>최종적으로 달라지는 것</h2>
            {statement(
              outcome,
              <>
                <span className="overview-source">
                  Git tree 비교 · 동작 의도는 아직 분석되지 않음
                </span>
                <p>
                  {changes
                    ? `최종 코드에서 ${changes.length}개 경로 변경 · 추가 ${changes.filter((f) => f.status === "추가").length} · 수정 ${changes.filter((f) => f.status === "수정").length} · 삭제 ${changes.filter((f) => f.status === "삭제").length}`
                    : "유효한 비교 기준을 확보하지 못해 최종 변경을 확정할 수 없습니다."}
                </p>
                <small>
                  rename 전후는 각각의 경로로 계산합니다. 수집된 tree
                  기준입니다.
                </small>
              </>,
            )}
            <button disabled={!s.chosenComparisonBaseSha} onClick={onFinal}>
              최종 PR diff 확인
            </button>
          </section>
        </div>
        {!!areas.size && (
          <div className="overview-areas">
            <b>핵심 변경 영역</b>
            {[...areas]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([area, n]) => (
                <span key={area}>
                  {area} · {n}
                </span>
              ))}
            {areas.size > 5 && (
              <small>
                외 {areas.size - 5}개 영역 · 최종 diff에서 모두 확인
              </small>
            )}
          </div>
        )}
        <div className="overview-flow-head">
          <h3>실제 커밋 흐름 · {s.phases.length}개</h3>
          <button
            className="primary"
            disabled={!s.phases.length}
            onClick={() => onChoosePhase(s.phases[0].sha)}
          >
            처음부터 따라 읽기
          </button>
        </div>
        <ol className="overview-commits">
          {s.phases.map((p, i) => (
            <li key={p.sha}>
              <button
                aria-current={p.sha === currentSha ? "step" : undefined}
                onClick={() => onChoosePhase(p.sha)}
              >
                <span className="overview-phase-number">{i + 1}</span>
                <span>
                  {p.subject || "(제목 없는 커밋)"}
                  <small>
                    {p.sha.slice(0, 8)} ·{" "}
                    {p.files.filter((f) => f.status !== "unchanged").length}개
                    파일
                    {p.parents.length > 1
                      ? ` · merge (${p.parents.length} parents)`
                      : ""}
                  </small>
                </span>
              </button>
            </li>
          ))}
        </ol>
        <p className="overview-source">
          Git 부모 관계에 따른 표시 순서입니다. 인접한 Phase가 항상 직접 부모인
          것은 아닙니다. 코드 의존 관계는 Code Explorer에서 확인합니다.
        </p>
        {!s.coverage.complete && (
          <p className="overview-source">
            일부 원문 수집에 제한이 있습니다. 커밋 {s.coverage.commitsRetrieved}{" "}
            / {s.coverage.commitsDiscovered}개 · 파일별 제외 표시를 확인하세요.
          </p>
        )}
      </div>
    </section>
  );
}
