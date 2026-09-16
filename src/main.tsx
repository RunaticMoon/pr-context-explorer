import { LiveApp } from "./live";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReactFlow, Background, Controls, MarkerType } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "@fontsource/noto-sans-kr/400.css";
import "@fontsource/noto-sans-kr/600.css";
import "./style.css";
import type { Snapshot, Evidence, FileState } from "./server/git";
import type { Analysis, Step } from "./server/contract";
type Data = {
  snapshot: Snapshot;
  analysis: Analysis;
  providers: { id: string; available: boolean; reason: string }[];
};
const readURL = () => Object.fromEntries(new URLSearchParams(location.search));
function App() {
  const [data, setData] = useState<Data>();
  const [csrf, setCsrf] = useState("");
  const [error, setError] = useState("");
  const [u, setU] = useState<Record<string, string>>(readURL);
  const [search, setSearch] = useState("");
  const [context, setContext] = useState(false);
  const [focus, setFocus] = useState(false);
  const [read, setRead] = useState<string[]>([]);
  const nav = (change: Record<string, string>) => {
    const next = { ...u, ...change };
    const query = new URLSearchParams(next);
    history.pushState({}, "", `?${query}`);
    setU(next);
    if (data && next.page === "workspace")
      localStorage.setItem(
        "resume:" + data.snapshot.snapshotId,
        query.toString(),
      );
  };
  useEffect(() => {
    const pop = () => setU(readURL());
    addEventListener("popstate", pop);
    (async () => {
      const session = await fetch("/api/session", { method: "POST" });
      if (!session.ok) throw Error("로컬 세션 거부");
      setCsrf((await session.json()).csrf);
      const r = await fetch("/api/snapshot");
      if (!r.ok) throw Error("데이터 읽기 실패");
      const d: Data = await r.json();
      setData(d);
      try {
        setRead(
          JSON.parse(
            localStorage.getItem("read:" + d.snapshot.snapshotId) || "[]",
          ),
        );
      } catch {
        setRead([]);
      }
    })().catch((e) => setError(String(e)));
    return () => removeEventListener("popstate", pop);
  }, []);
  if (!u.page || u.page === "connections" || u.page?.startsWith("live-"))
    return <LiveApp csrf={csrf} onDemo={() => nav({ page: "demo" })} />;
  if (error) return <main role="alert">{error}</main>;
  if (!data) return <main>고정 Git snapshot 수집 중…</main>;
  const s = data.snapshot,
    a = data.analysis;
  const phase =
    [s.baseline, ...s.phases].find((p) => p.sha === u.commit) || s.phases[2];
  const mode = u.mode || "Graph";
  const selected = phase.files.find((f) => f.id === u.file);
  const statement = a.statements.find((x) => x.commitSha === phase.sha)!;
  const step = a.steps.find((x) => x.id === u.step) || a.steps[0];
  const defaultState = {
    page: "workspace",
    snapshot: s.snapshotId,
    commit: s.headSha,
    comparison: s.phases[2].comparisonFromSha || "",
    file: s.phases[2].files.find((f) => f.path === "src/process.ts")!.id,
    side: "new",
    start: "1",
    end: "1",
    mode: "Graph",
    tour: "head-tour",
    step: "step-0",
  };
  const evidenceNav = (e: Evidence) =>
    nav({
      commit: e.commitSha,
      comparison: e.comparisonFromSha || "",
      file: e.fileId,
      side: e.side,
      start: String(e.lineStart),
      end: String(e.lineEnd),
      mode: "Code Explorer",
    });
  const chooseFile = (f: FileState) => {
    const e = s.evidence.find(
      (e) =>
        e.commitSha === phase.sha &&
        e.fileId === f.id &&
        e.side === (f.status === "deleted" ? "old" : "new") &&
        e.lineStart === 1,
    );
    if (e) evidenceNav(e);
  };
  const choosePhase = (sha: string) => {
    const p = [s.baseline, ...s.phases].find((x) => x.sha === sha)!;
    nav({
      commit: sha,
      comparison: p.comparisonFromSha || "",
      file: "",
      side: "new",
      start: "1",
      end: "1",
      mode: mode === "Guided Flow" ? "Graph" : mode,
      step: "",
    });
  };
  const chooseStep = (t: Step) => {
    const e = s.evidence.find((x) => x.id === t.evidenceIds[0])!;
    nav({
      commit: t.revisionSha,
      comparison: t.comparisonFromSha,
      file: e.fileId,
      side: e.side,
      start: String(e.lineStart),
      end: String(e.lineEnd),
      mode: "Guided Flow",
      tour: "head-tour",
      step: t.id,
    });
  };
  const mark = () => {
    const next = read.includes(step.id)
      ? read.filter((x) => x !== step.id)
      : [...read, step.id];
    setRead(next);
    localStorage.setItem("read:" + s.snapshotId, JSON.stringify(next));
  };
  const header = (
    <header>
      <div className="brand">
        ◈ <b>PR Context Explorer</b>
        <small>변경을 읽는 또 다른 순서</small>
      </div>
      <span className="badge">Demo</span>
      <span className="badge">MockProvider</span>
      <span className="badge amber">partial · 외부 연동 없음</span>
      <button
        onClick={() =>
          nav({
            page: "live-connections",
            snapshot: "",
            analysis: "",
            commit: "",
            file: "",
          })
        }
      >
        실제 PR 연결
      </button>
      <button onClick={() => nav({ page: "live-connections" })}>
        연결 설정
      </button>
    </header>
  );
  if (u.page === "list" || u.page === "demo")
    return (
      <>
        {header}
        <main className="landing">
          <div className="eyebrow">DEMO / 내 작성 PR</div>
          <h1>변경의 이유부터 읽기</h1>
          <input
            aria-label="PR 검색"
            placeholder="PR 제목 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <p>모의 작성자 demo-author · 실제 계정 조회 아님 · 전체 1개</p>
          {s.pr.title.includes(search) && (
            <section className="pr-card">
              <span className="badge">OPEN · DEMO</span>
              <h2>{s.pr.title}</h2>
              <p>{s.pr.repository} · PR #1 · 3 commits · Jira DEMO-1 (모의)</p>
              <p>{s.pr.body}</p>
              <button className="primary" onClick={() => nav(defaultState)}>
                PR #1 열기
              </button>
              <button
                onClick={() => {
                  const saved = localStorage.getItem("resume:" + s.snapshotId);
                  nav(
                    saved
                      ? Object.fromEntries(new URLSearchParams(saved))
                      : defaultState,
                  );
                }}
              >
                이어보기
              </button>
            </section>
          )}
        </main>
      </>
    );
  const rangeContent = selected
    ? u.side === "old"
      ? selected.oldContent
      : selected.status === "deleted"
        ? null
        : selected.content
    : null;
  const badRange =
    selected &&
    (rangeContent === null ||
      !Number.isInteger(Number(u.start)) ||
      !Number.isInteger(Number(u.end)) ||
      Number(u.start) < 1 ||
      Number(u.end) < Number(u.start) ||
      Number(u.end) >
        (rangeContent || "").replace(/\n$/, "").split("\n").length);
  const invalid =
    badRange ||
    (u.snapshot && u.snapshot !== s.snapshotId) ||
    (u.commit && ![s.baseline, ...s.phases].some((p) => p.sha === u.commit)) ||
    (u.comparison !== undefined &&
      u.comparison !== (phase.comparisonFromSha || "")) ||
    (u.file && !selected) ||
    (u.side && !["old", "new"].includes(u.side)) ||
    (mode === "Guided Flow" && phase.sha !== s.headSha) ||
    (u.mode && !["Graph", "Guided Flow", "Code Explorer"].includes(u.mode)) ||
    (u.tour && u.tour !== "head-tour") ||
    (u.step && !a.steps.some((t) => t.id === u.step));
  if (invalid)
    return (
      <>
        {header}
        <main role="alert">
          <h1>선택 상태가 이 snapshot과 맞지 않습니다</h1>
          <p>잘못된 revision을 다른 코드에 연결하지 않았습니다.</p>
          <button onClick={() => nav(defaultState)}>데모 head 다시 열기</button>
        </main>
      </>
    );
  const neighbors = new Set([
    u.file,
    ...phase.edges
      .filter((e) => e.source === u.file || e.target === u.file)
      .flatMap((e) => [e.source, e.target]),
  ]);
  const allIds = [
    ...new Set(
      [s.baseline, ...s.phases].flatMap((p) => p.files.map((f) => f.id)),
    ),
  ];
  const visible = phase.files.filter(
    (f) =>
      (context || s.relatedFileIds.includes(f.id)) &&
      f.path.includes(search) &&
      (!focus || !u.file || neighbors.has(f.id)),
  );
  const nodes = visible.map((f) => {
    const i = allIds.indexOf(f.id);
    return {
      id: f.id,
      position: { x: (i % 3) * 240, y: Math.floor(i / 3) * 115 },
      data: {
        label: (
          <div>
            <b>{f.path}</b>
            <small>
              {f.status}
              {!s.relatedFileIds.includes(f.id) ? " · 문맥" : ""}
            </small>
          </div>
        ),
      },
      style: {
        background: f.id === u.file ? "#234e5c" : "#172633",
        color: "#e2edf4",
        border: `1px ${f.status === "deleted" ? "dashed" : "solid"} ${f.status === "added" ? "#55ceaa" : f.status === "deleted" ? "#ed8e91" : "#405568"}`,
        borderRadius: 10,
        width: 210,
      },
      selected:
        mode === "Guided Flow" ? step.fileIds.includes(f.id) : f.id === u.file,
    };
  });
  const edges = phase.edges
    .filter(
      (e) =>
        visible.some((f) => f.id === e.source) &&
        visible.some((f) => f.id === e.target),
    )
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: "import · AST",
      style: { stroke: "#5da7bd" },
      labelStyle: { fill: "#a9cbd6", fontSize: 10 },
      labelBgStyle: { fill: "#132330" },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#5da7bd" },
    }));
  const evButtons = (ids: string[], prefix = "근거") =>
    ids.map((id, i) => {
      const e = s.evidence.find((e) => e.id === id)!;
      return (
        <button
          key={id}
          onClick={() => evidenceNav(e)}
          aria-label={`${prefix} ${i + 1}`}
        >
          {prefix} {i + 1} · {e.path}:{e.lineStart}–{e.lineEnd} ({e.side})
        </button>
      );
    });
  const codeEvidence = s.evidence.find(
    (e) =>
      e.commitSha === phase.sha &&
      e.fileId === u.file &&
      e.side === u.side &&
      e.lineStart === 1,
  );
  const codeExplanation = a.codeExplanations.find(
    (x) => x.evidenceId === codeEvidence?.id,
  );
  const codePane = (side: "old" | "new") => {
    if (!selected) return null;
    const content =
      side === "old"
        ? selected.oldContent
        : selected.status === "deleted"
          ? null
          : selected.content;
    const sha = side === "old" ? phase.comparisonFromSha : phase.sha;
    const filePath = side === "old" ? selected.oldPath : selected.path;
    return (
      <div className="code-pane" data-testid={"code-" + side}>
        <h4>
          {side} · {sha?.slice(0, 10) || "없음"} · {filePath}
        </h4>
        {content === null ? (
          <p>이 side에 파일이 없습니다.</p>
        ) : (
          <pre>
            {content
              .replace(/\n$/, "")
              .split("\n")
              .map((line, i) => (
                <div
                  key={i}
                  className={
                    u.side === side &&
                    i + 1 >= Number(u.start) &&
                    i + 1 <= Number(u.end)
                      ? "highlight"
                      : ""
                  }
                >
                  <button
                    className="line"
                    onClick={() =>
                      nav({ side, start: String(i + 1), end: String(i + 1) })
                    }
                  >
                    {i + 1}
                  </button>
                  <code>{line || " "}</code>
                </div>
              ))}
          </pre>
        )}
      </div>
    );
  };
  return (
    <>
      {header}
      <main className="workspace">
        <div className="summary">
          <div>
            <div className="eyebrow">
              {s.pr.repository} / PR #1 / {s.pr.author}
            </div>
            <h1>{s.pr.title}</h1>
            <p>{s.pr.body}</p>
          </div>
          <button onClick={() => nav({ page: "list" })}>← PR 목록</button>
        </div>
        <div className="timeline">
          <button
            aria-pressed={phase.sha === s.baseSha}
            onClick={() => choosePhase(s.baseSha)}
          >
            Baseline (비교 기준)
          </button>
          {s.phases.map((p, i) => (
            <button
              key={p.sha}
              aria-label={`Phase ${i + 1}`}
              aria-pressed={phase.sha === p.sha}
              onClick={() => choosePhase(p.sha)}
            >
              <b>Phase {i + 1}</b>
              <span>{["입력 규칙", "처리 연결", "테스트 보강"][i]}</span>
              <code>{p.sha.slice(0, 8)}</code>
            </button>
          ))}
        </div>
        <div className="revision">
          snapshot {s.snapshotId.slice(0, 12)} · 선택 SHA {phase.sha} · 비교{" "}
          {phase.comparisonFromSha || "없음 (baseline)"} · 실제 부모{" "}
          {phase.parents.join(", ") || "없음"}
        </div>
        <nav className="modes">
          {["Graph", "Guided Flow", "Code Explorer"].map((m) => (
            <button
              key={m}
              aria-pressed={mode === m}
              onClick={() =>
                m === "Guided Flow" ? chooseStep(step) : nav({ mode: m })
              }
            >
              {m}
            </button>
          ))}
          <span>원문 사실과 데모 해석을 구분합니다</span>
        </nav>
        <div className="layout">
          <aside>
            <h3>파일 탐색</h3>
            <input
              aria-label="파일 검색"
              placeholder="경로 검색"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <label>
              <input
                type="checkbox"
                checked={context}
                onChange={(e) => setContext(e.target.checked)}
              />{" "}
              문맥 파일 확장
            </label>
            <label>
              <input
                type="checkbox"
                checked={focus}
                onChange={(e) => setFocus(e.target.checked)}
              />{" "}
              선택 파일 주변 집중
            </label>
            {visible.map((f) => (
              <button
                className="file"
                key={f.id}
                aria-label={"파일 " + f.path}
                onClick={() => chooseFile(f)}
              >
                <span>{f.path}</span>
                <small>{f.status}</small>
              </button>
            ))}
            <hr />
            <h3>요구사항 · 파일 노드 아님</h3>
            <b>{s.jira.key} · 모의 Jira</b>
            <p>{s.jira.title}</p>
            <p>{s.jira.description}</p>
            <small>
              source: {s.jira.host}/{s.jira.issueId}
              <br />
              fetched / updated {s.jira.fetchedAt}
              <br />
              현재 예제 요구사항이며 커밋 당시 Jira 기록 아님
            </small>
            <p className="badge amber">일부 코드 근거 · 충족 확정 아님</p>
            <p>rules / process / tests를 투어에서 함께 확인합니다.</p>
          </aside>
          <article>
            <section data-testid="phase-message">
              <div className="eyebrow">GIT 원문 · {phase.date}</div>
              <h3>{phase.subject}</h3>
              <pre>{phase.body || "(본문 없음)"}</pre>
              <details>
                <summary>전체 원문 메시지 / 작성자</summary>
                <pre>{phase.message}</pre>
                {phase.author}
              </details>
            </section>
            {(mode === "Graph" || mode === "Guided Flow") && (
              <section>
                <div className="graph">
                  <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    fitView
                    minZoom={0.3}
                    maxZoom={2}
                    nodesDraggable={false}
                    onNodeClick={(_, n) =>
                      chooseFile(phase.files.find((f) => f.id === n.id)!)
                    }
                    onEdgeClick={(_, e) =>
                      evidenceNav(
                        s.evidence.find(
                          (x) =>
                            x.id ===
                            phase.edges.find((x) => x.id === e.id)!.evidenceId,
                        )!,
                      )
                    }
                  >
                    <Background color="#304657" gap={22} />
                    <Controls />
                  </ReactFlow>
                </div>
                <div className="legend">
                  실선: TypeScript AST import (호출/실행 순서 아님) · 초록: 추가
                  · 점선 테두리: 삭제 흔적 · 문맥: 미변경 확장
                </div>
              </section>
            )}
            {mode === "Guided Flow" && (
              <section data-testid="tour">
                <div className="eyebrow">
                  추천 읽기 순서 · head 고정 {s.headSha.slice(0, 10)}
                </div>
                <p>
                  실제 커밋 순서는 위 Phase 타임라인, 추천 순서는 아래 story
                  단계입니다. 코드 의존성 edge와 별개입니다.
                </p>
                <div className="step-list">
                  {a.steps.map((t, i) => (
                    <button
                      aria-pressed={step.id === t.id}
                      key={t.id}
                      onClick={() => chooseStep(t)}
                    >
                      {i + 1}. {t.title} {read.includes(t.id) ? "✓" : ""}
                    </button>
                  ))}
                </div>
                <h2>{step.title}</h2>
                <h4>지금 읽는 이유</h4>
                <p>{step.why}</p>
                <p>이전 연결: {step.previous}</p>
                <p>PR 전체 baseline → head 동작 변화: {step.beforeAfter}</p>
                <small>
                  아래 코드 old는 head의 부모 대비입니다. PR 전체 이전 동작은
                  Baseline Phase에서 확인하세요.
                </small>
                <p>
                  집중 파일:{" "}
                  {step.fileIds
                    .map((id) => phase.files.find((f) => f.id === id)?.path)
                    .join(" + ")}
                </p>
                {evButtons(step.evidenceIds, "단계 근거")}
                <div className="notice">확인 질문: {step.question}</div>
                <p>다음 이유: {step.next}</p>
                <button
                  disabled={step.id === a.steps[0].id}
                  onClick={() => chooseStep(a.steps[a.steps.indexOf(step) - 1])}
                >
                  이전 단계
                </button>
                <button onClick={mark}>
                  {read.includes(step.id) ? "읽음 취소" : "읽음 표시"}
                </button>
                <button
                  disabled={step.id === a.steps.at(-1)!.id}
                  onClick={() => chooseStep(a.steps[a.steps.indexOf(step) + 1])}
                >
                  다음 단계
                </button>
                <p data-testid="progress">
                  읽음 {read.length} / {a.steps.length} · snapshot별 자동 저장 /
                  이어보기
                </p>
              </section>
            )}
            {selected ? (
              <section>
                <h3>
                  {selected.path}{" "}
                  <span className="badge">{selected.status}</span>
                </h3>
                {selected.renameEvidence && (
                  <p>
                    {selected.oldPath} → {selected.path} ·{" "}
                    {selected.renameEvidence}
                  </p>
                )}
                <div data-testid="evidence-location" className="revision">
                  {u.side} · SHA{" "}
                  {u.side === "old" ? phase.comparisonFromSha : phase.sha} ·{" "}
                  {u.side === "old" ? selected.oldPath : selected.path} · L
                  {u.start}–{u.end}
                </div>
                <div className="diff-grid">
                  {codePane("old")}
                  {codePane("new")}
                </div>
                <p>
                  선택 라인 버튼으로 URL 범위를 변경합니다. 코드·주석은 실행하지
                  않는 텍스트입니다.
                </p>
              </section>
            ) : (
              <section className="empty">
                파일 또는 그래프 근거를 선택하면 해당 revision의 old/new 코드를
                엽니다.
              </section>
            )}
            <details className="rawdiff">
              <summary>
                실제 부모 대비 diff / hunk ({phase.hunks.length})
              </summary>
              <pre>{phase.diff || "baseline: 비교 없음"}</pre>
            </details>
            <details className="rawdiff">
              <summary>
                PR 전체 순변경 · merge-base → head (현재 Phase diff와 별개)
              </summary>
              <pre>{s.netDiff}</pre>
            </details>
          </article>
          <aside>
            <div className="eyebrow">검증된 위치 / 모의 해석</div>
            <h3>이 단계에서 무엇이 달라졌나</h3>
            <div data-testid="phase-explanation">
              <span className="badge">{statement.kind}</span>
              <p>{statement.text}</p>
            </div>
            {evButtons(statement.evidenceIds)}
            <p className="muted">
              confidence: {statement.confidence} (자기 평가)
              <br />
              위치 검사: 통과 · 의미 감사: 미수행
            </p>
            {codeExplanation && (
              <section data-testid="code-explanation">
                <h3>선택 side의 코드 설명</h3>
                <p className="revision">
                  {codeEvidence!.side} ·{" "}
                  {codeEvidence!.revisionSha.slice(0, 12)} ·{" "}
                  {codeEvidence!.path}
                </p>
                <b>{codeExplanation.role}</b>
                <p>입출력: {codeExplanation.inputsOutputs}</p>
                <p>동작: {codeExplanation.behavior}</p>
                <p>오류: {codeExplanation.errors}</p>
                <p>부작용: {codeExplanation.sideEffects}</p>
                {evButtons([codeExplanation.evidenceId], "코드 근거")}
                <small>{codeExplanation.limitation}</small>
              </section>
            )}
            <h3>코드 질문</h3>
            {[
              "왜 바뀌었나",
              "어디에서 쓰이나",
              "어떤 Jira와 관련 있나",
              "무엇을 확인해야 하나",
            ].map((q) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>
                  {q === "왜 바뀌었나"
                    ? statement.text
                    : q === "어디에서 쓰이나"
                      ? selected
                        ? phase.edges
                            .filter((e) => e.target === selected.id)
                            .map(
                              (e) =>
                                phase.files.find((f) => f.id === e.source)
                                  ?.path,
                            )
                            .join(", ") ||
                          "확인된 정적 import 없음. 동적 사용은 분석하지 않음."
                        : "파일을 먼저 선택하세요."
                      : q === "어떤 Jira와 관련 있나"
                        ? "모의 DEMO-1 입력 정책. 관련성은 고정 예제이며 실행 충족 판정이 아닙니다."
                        : "예외 정책, 유니코드/긴 입력, 대상 테스트 실제 실행 여부를 확인하세요."}
                </p>
              </details>
            ))}
            <h3>Coverage</h3>
            <p>
              발견 {s.coverage.discovered} · 원문 확보 {s.coverage.retrieved}
              <br />
              TS AST 파일 {s.coverage.analyzed}
              <br />
              대상 테스트 실행: 안 함<br />
              외부 CI 조회: 안 함
            </p>
            {a.limitations.map((l) => (
              <p className="muted" key={l}>
                — {l}
              </p>
            ))}
            <details>
              <summary>분석 제외 / 미지원</summary>
              <p>{s.coverage.omitted.join(", ")}</p>
              <p>
                단일 선형 fixture만 지원. merge/fork/LFS/binary/대형 PR/실제
                언어 확장 미검증.
              </p>
            </details>
          </aside>
        </div>
      </main>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
