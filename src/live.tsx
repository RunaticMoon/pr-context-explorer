import { SourcePanel } from "./source-ui";
import {
  GroundedTourStep,
  GroundedRequirements,
  GroundedDetails,
  PipelineStatus,
} from "./live-grounded";
import type { PipelineResult, V3Output } from "./server/analysis-v3/types";
import React, { useEffect, useState } from "react";
import { ReactFlow, Background, Controls, MarkerType } from "@xyflow/react";
import type { Connection } from "./server/github";
import type {
  LiveSnapshot,
  LivePhase,
  SourceEvidence,
} from "./server/live-git";
import type { LiveOutput, Scope, buildContext } from "./server/live-analysis";
import type { Evidence } from "./server/git";
import type { Job } from "./server/live-api";
const query = () => Object.fromEntries(new URLSearchParams(location.search));
type AnalysisResult = {
  output: LiveOutput | V3Output;
  metadata: Record<string, unknown>;
  scope: Scope;
  cacheKey: string;
  selectionEvidence?: Evidence[];
  contextCoverage?: ReturnType<typeof buildContext>["coverage"];
  evidence?: Evidence[];
  coverage?: PipelineResult["coverage"];
  semanticAudit?: PipelineResult["semanticAudit"];
  processStatus?: PipelineResult["processStatus"];
  deterministicValidation?: PipelineResult["deterministicValidation"];
};
const initial: Connection = {
  id: "github",
  type: "github",
  webUrl: "https://github.com",
  apiUrl: "https://api.github.com",
  apiVersion: "2022-11-28",
  account: "",
  auth: { kind: "gh" },
};
export function LiveApp({
  onDemo,
  csrf,
}: {
  onDemo: () => void;
  csrf: string;
}) {
  const [u, setU] = useState(query),
    [connections, setConnections] = useState<Connection[]>([]),
    [form, setForm] = useState<Connection>(initial),
    [connectionId, setConnectionId] = useState(""),
    [status, setStatus] = useState(""),
    [error, setError] = useState(""),
    [inventory, setInventory] = useState<any[]>([]),
    [s, setS] = useState<LiveSnapshot>(),
    [stale, setStale] = useState(false),
    [result, setResult] = useState<AnalysisResult>(),
    [codeResult, setCodeResult] = useState<AnalysisResult>(),
    [job, setJob] = useState<Job>(),
    [providers, setProviders] = useState<any[]>([]),
    [prURL, setPrURL] = useState(""),
    [list, setList] = useState<any>(),
    [filters, setFilters] = useState({
      tab: "authored",
      repository: "",
      organization: "",
      author: "",
      state: "open",
      draft: "all",
      search: "",
      page: 1,
    }),
    [providerId, setProviderId] = useState<"codex" | "claude">("codex"),
    [model, setModel] = useState(""),
    [consent, setConsent] = useState(false),
    [audit, setAudit] = useState(false),
    [historical, setHistorical] = useState(false),
    [freshRun, setFreshRun] = useState(false),
    [plan, setPlan] = useState<any>();
  const nav = (change: Record<string, string>) => {
    const next = { ...query(), ...change };
    history.pushState({}, "", `?${new URLSearchParams(next)}`);
    setU(next);
    if (next.page === "live-workspace" && next.snapshot)
      localStorage.setItem(
        "live-resume:" + next.snapshot,
        new URLSearchParams(next).toString(),
      );
  };
  const api = async (
    route: string,
    method = "GET",
    body?: unknown,
    token = csrf,
  ) => {
    const r = await fetch(route, {
      method,
      headers: {
        ...(method !== "GET"
          ? { "Content-Type": "application/json", "X-PRCE-CSRF": token }
          : {}),
      },
      body: method !== "GET" ? JSON.stringify(body || {}) : undefined,
    });
    const d = await r.json();
    if (!r.ok) throw Error(d.error || "Local API failed");
    return d;
  };
  const guard = async (action: () => Promise<void>) => {
    setError("");
    try {
      await action();
    } catch (e) {
      setError(String(e));
    }
  };
  const refresh = async (token = csrf) => {
    const data = await api("/api/connections", "GET", undefined, token);
    setConnections(data.connections);
    if (!connectionId && data.connections.length)
      setConnectionId(data.connections[0].id);
    setInventory(
      (await api("/api/live/snapshots", "GET", undefined, token)).snapshots,
    );
  };
  useEffect(() => {
    const pop = () => setU(query());
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    if (csrf) guard(() => refresh(csrf));
  }, [csrf]);
  useEffect(() => {
    if (!csrf || !u.snapshot || u.page !== "live-workspace") return;
    let active = true;
    guard(async () => {
      const d = await api(
        "/api/live/snapshot?id=" + encodeURIComponent(u.snapshot),
      );
      const load = async (key: string | undefined, kind: Scope["kind"]) => {
        if (!key) return undefined;
        const cached = await api(
          "/api/live/analysis?key=" + encodeURIComponent(key),
        );
        if (
          cached.result.output.snapshotId !== d.snapshot.snapshotId ||
          cached.result.scope.kind !== kind
        )
          throw Error("cached analysis snapshot/scope mismatch");
        return cached.result as AnalysisResult;
      };
      // Each cache is independent: an expired/rejected Q&A record must not
      // prevent the pinned snapshot and still-valid PR tour from reopening.
      const [pr, code] = await Promise.allSettled([
        load(u.analysis, "pr"),
        load(u.codeAnalysis, "code"),
      ]);
      if (!active) return;
      setS(d.snapshot);
      setStale(d.stale);
      setResult(pr.status === "fulfilled" ? pr.value : undefined);
      setCodeResult(code.status === "fulfilled" ? code.value : undefined);
      const failures = [pr, code].flatMap((r) => r.status === "rejected" ? [String(r.reason)] : []);
      if (failures.length) setError(failures.join("; "));
    });
    return () => {
      active = false;
    };
  }, [csrf, u.snapshot, u.analysis, u.codeAnalysis, u.page]);
  const completeAnalysis = (r: AnalysisResult) => {
    if (r.scope.kind === "code") {
      setCodeResult(r);
      const scope = r.scope;
      nav({
        codeAnalysis: r.cacheKey,
        mode: "Code Explorer",
        step: "",
        tour: query().tour || "",
        tourStep: query().step || query().tourStep || "",
        commit: scope.commitSha,
        file: scope.fileId,
        side: scope.side,
        start: String(scope.lineStart),
        end: String(scope.lineEnd),
        comparison:
          (s &&
            [s.baseline, ...s.phases].find((p) => p.sha === scope.commitSha)
              ?.comparisonFromSha) ||
          "",
      });
    } else {
      setResult(r);
      nav({
        analysis: r.cacheKey,
        tour: r.output.schemaVersion === "3" ? r.output.tour.tourId : "",
        step: "",
        tourStep: "",
        mode: "Graph",
      });
    }
  };
  useEffect(() => {
    if (!job || !["running", "queued"].includes(job.status)) return;
    let active = true;
    const timer = setInterval(() => {
      guard(async () => {
        const next: Job = await api("/api/live/job?id=" + job.id);
        if (!active) return;
        setJob(next);
        if (["succeeded", "partial"].includes(next.status)) {
          const r = next.result as any;
          if (next.kind === "snapshot") {
            setS(r.snapshot);
            setStale(false);
            setResult(undefined);
            setCodeResult(undefined);
            nav({
              page: "live-workspace",
              snapshot: r.snapshot.snapshotId,
              commit: r.snapshot.headSha,
              file: "",
              side: "new",
              start: "1",
              end: "1",
              mode: "Graph",
              step: "",
              analysis: "",
              codeAnalysis: "",
              tourStep: "",
            });
            await refresh();
          } else {
            completeAnalysis(r);
          }
        }
      });
    }, 500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [job?.id, job?.status, csrf]);
  const busy = !!job && ["queued", "running"].includes(job.status);
  const startCapture = (url: string) =>
    guard(async () => {
      setResult(undefined);
      setJob(await api("/api/live/snapshots", "POST", { connectionId, url }));
    });
  const run = (scope: Scope) =>
    guard(async () => {
      if (!s) return;
      const d = await api("/api/live/run", "POST", {
        snapshotId: s.snapshotId,
        providerId,
        model,
        scope,
        consent,
        audit,
        auditConsent: audit,
        allowHistoricalSteps: historical,
        refresh: freshRun,
      });
      if (d.cached) {
        completeAnalysis(d.result);
        setStatus("검증된 로컬 캐시 재사용");
      } else setJob(d);
    });
  const openSaved = (id: string) => {
    setResult(undefined);
    const resume = localStorage.getItem("live-resume:" + id);
    if (resume) {
      const parsed = Object.fromEntries(new URLSearchParams(resume));
      if (parsed.snapshot === id && parsed.page === "live-workspace") {
        nav(parsed);
        return;
      }
    }
    nav({
      page: "live-workspace",
      snapshot: id,
      commit: "",
      file: "",
      side: "new",
      start: "1",
      end: "1",
      mode: "Graph",
      step: "",
      analysis: "",
      codeAnalysis: "",
      tourStep: "",
    });
  };
  const connectionSelect = (
    <label>
      승인된 연결
      <select
        value={connectionId}
        onChange={(e) => {
          setConnectionId(e.target.value);
          setList(undefined);
        }}
      >
        <option value="">선택</option>
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.id} · {c.account} · {c.webUrl}
          </option>
        ))}
      </select>
    </label>
  );
  const jobPanel = job && (
    <section className="notice" data-testid="live-job">
      <b>
        {job.kind} · 프로세스 {job.processStatus || job.status}{" "}
        {job.analysisStatus ? `· 분석 ${job.analysisStatus}` : ""}
      </b>
      {job.error && <p role="alert">{job.error}</p>}
      <p>{job.events.at(-1)?.message}</p>
      {job.coverage && (
        <details>
          <summary>실패/취소 시 분할 coverage</summary>
          <pre>{JSON.stringify(job.coverage, null, 2)}</pre>
        </details>
      )}
      {job.semanticAudit && (
        <details>
          <summary>실패한 의미 감사 · {job.semanticAudit.status}</summary>
          <pre>{JSON.stringify(job.semanticAudit, null, 2)}</pre>
        </details>
      )}
      {busy && (
        <button
          onClick={() =>
            guard(async () => {
              await api("/api/live/cancel", "POST", { id: job.id });
              setStatus("취소 요청됨");
            })
          }
        >
          현재 작업 취소
        </button>
      )}
      <details>
        <summary>진행 기록 · 내부 추론 아님</summary>
        {job.events.map((e, i) => (
          <p key={i}>
            {e.at} · {e.message}
          </p>
        ))}
      </details>
    </section>
  );
  const engine = (
    <section className="engine-controls">
      <h3>선택한 실제 분석 엔진</h3>
      <label>
        엔진
        <select
          value={providerId}
          onChange={(e) => setProviderId(e.target.value as any)}
        >
          <option value="codex">Codex CLI</option>
          <option value="claude">Claude Code CLI</option>
        </select>
      </label>
      <label>
        모델 식별자
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="설치 CLI에서 지원하는 정확한 모델 ID"
        />
      </label>
      <button
        onClick={() =>
          guard(async () =>
            setProviders((await api("/api/live/capabilities")).providers),
          )
        }
      >
        CLI 설치 / 격리 확인
      </button>
      {providers.map((p, i) => (
        <p key={i}>
          {p.providerId || p.id} · {p.ready ? "사용 가능" : "차단 / 미검증"} ·{" "}
          {Array.isArray(p.blockers)
            ? p.blockers
                .map((x: any) =>
                  typeof x === "string" ? x : x.message || x.code,
                )
                .join("; ")
            : p.reason || ""}
        </p>
      ))}
      <label>
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />{" "}
        선택 범위의 PR/코드/Jira를 선택 모델 제공자에게 전송하는 데 동의합니다.
      </label>
      <p>
        PR: 변경/직접 import/원문을 최대 48개 분할 → 통합 1회 → 고정 head 투어
        1회. 선택 코드: 해당 SHA/side/라인과 원문 문맥의 분할 → 통합. 실행당 총
        최대 52회 호출, 15분. 실제 가격/토큰은 제공자 과금이며 캐시 적중으로
        호출이 줄 수 있습니다.
      </p>
      <label>
        <input
          type="checkbox"
          checked={audit}
          onChange={(e) => setAudit(e.target.checked)}
        />
        선택한 동일 엔진·모델의 의미 감사 추가 전송/과금 최대 1회에 동의합니다
        (선택)
      </label>
      <label>
        <input
          type="checkbox"
          checked={historical}
          onChange={(e) => setHistorical(e.target.checked)}
        />
        투어의 명시적인 과거 revision 예외 허용 (기본 head 고정)
      </label>
      <label>
        <input
          type="checkbox"
          checked={freshRun}
          onChange={(e) => setFreshRun(e.target.checked)}
        />
        검증 캐시를 건너뛰고 새 실행 (추가 과금 가능)
      </label>
      {s && (
        <button
          onClick={() =>
            guard(async () =>
              setPlan(
                await api("/api/live/plan", "POST", {
                  snapshotId: s.snapshotId,
                  scope: { kind: "pr" },
                  audit,
                }),
              ),
            )
          }
        >
          PR 전송 계획 확인 · 모델 호출 없음
        </button>
      )}
      {plan && plan.snapshotId === s?.snapshotId && (
        <section data-testid="live-transmission-plan">
          <p>
            분할 {plan.plannedChunks} · 제공자 호출 상한 {plan.maxProviderCalls}{" "}
            · 추가 감사 {plan.auditCalls} · 분할 JSON UTF-8{" "}
            {plan.serializedChunkBytes} bytes
          </p>
          <pre>{JSON.stringify(plan.scope)}</pre>
          <p>{plan.note}</p>
        </section>
      )}
      <p className="muted">
        로컬 CLI는 오프라인 추론이 아닙니다. GitHub/Jira 토큰은 전달하지
        않습니다. 격리·인증·기능이 없으면 실행은 차단됩니다. 화면 이동은 모델을
        실행하지 않습니다.
      </p>
    </section>
  );
  return (
    <>
      <header>
        <div className="brand">
          ◈ <b>PR Context Explorer</b>
          <small>실제 원문 / 고정 revision / 읽기 전용</small>
        </div>
        <span className="badge">Live</span>
        <button onClick={() => nav({ page: "live-connections" })}>
          실제 연결 설정
        </button>
        <button onClick={() => nav({ page: "live-list" })}>
          내 PR / URL 열기
        </button>
        <button onClick={onDemo}>명시적 데모로 돌아가기</button>
      </header>
      <div className="live-notices">
        <output role="status">{status}</output>
        {error && (
          <div className="notice" role="alert">
            {error}
            <button onClick={() => setError("")}>닫기</button>
          </div>
        )}
        {jobPanel}
      </div>
      {u.page === "live-connections" && (
        <main className="landing">
          <div className="eyebrow">LOCAL FIRST / READ-ONLY REMOTES</div>
          <h1>실제 GitHub 연결</h1>
          <p>
            연결별 Web/API/배포 유형/버전/계정을 명시합니다. 토큰 값은
            브라우저에 입력하지 않습니다.
          </p>
          <div className="cards">
            <section>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  guard(async () => {
                    await api("/api/connections", "POST", form);
                    setConnectionId(form.id);
                    await refresh();
                    setStatus("연결 저장 완료 · 인증은 별도 확인");
                  });
                }}
              >
                <label>
                  연결 ID
                  <input
                    required
                    value={form.id}
                    onChange={(e) => setForm({ ...form, id: e.target.value })}
                  />
                </label>
                <label>
                  GitHub 배포 유형
                  <select
                    value={form.type}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        type: e.target.value as Connection["type"],
                      })
                    }
                  >
                    <option value="github">github.com</option>
                    <option value="ghe-cloud">GitHub Enterprise Cloud</option>
                    <option value="ghes">GitHub Enterprise Server</option>
                  </select>
                </label>
                <label>
                  Web URL
                  <input
                    required
                    type="url"
                    value={form.webUrl}
                    onChange={(e) =>
                      setForm({ ...form, webUrl: e.target.value })
                    }
                  />
                </label>
                <label>
                  API base URL
                  <input
                    required
                    type="url"
                    value={form.apiUrl}
                    onChange={(e) =>
                      setForm({ ...form, apiUrl: e.target.value })
                    }
                  />
                </label>
                <label>
                  호환 API 버전
                  <input
                    required
                    value={form.apiVersion}
                    onChange={(e) =>
                      setForm({ ...form, apiVersion: e.target.value })
                    }
                  />
                </label>
                {form.type === "ghes" && (
                  <label>
                    GHES 서버 버전
                    <input
                      required
                      value={form.serverVersion || ""}
                      onChange={(e) =>
                        setForm({ ...form, serverVersion: e.target.value })
                      }
                    />
                  </label>
                )}
                <label>
                  계정 식별자
                  <input
                    required
                    value={form.account}
                    onChange={(e) =>
                      setForm({ ...form, account: e.target.value })
                    }
                  />
                </label>
                <label>
                  인증 방식
                  <select
                    value={form.auth.kind}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        auth:
                          e.target.value === "env"
                            ? { kind: "env", envName: "PRCE_GITHUB_TOKEN" }
                            : { kind: e.target.value as "gh" | "public" },
                      })
                    }
                  >
                    <option value="gh">공식 gh auth</option>
                    <option value="env">서버 환경변수 이름</option>
                    <option value="public">공개 URL만 · 인증 없음</option>
                  </select>
                </label>
                {form.auth.kind === "env" && (
                  <label>
                    시크릿 환경변수 이름
                    <input
                      value={form.auth.envName}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          auth: { kind: "env", envName: e.target.value },
                        })
                      }
                    />
                  </label>
                )}
                <button className="primary" disabled={!csrf}>
                  연결 저장
                </button>
              </form>
              <p>
                gh는 공식 인증 저장소를 읽습니다. 환경변수는 전용 PRCE_ 이름만
                허용합니다. TLS 검증을 끄지 않습니다. 프록시는 현재 fail-closed,
                직접 VPN / NODE_EXTRA_CA_CERTS를 사용하세요.
              </p>
            </section>
            <section>
              <h2>저장된 연결과 계정 검증</h2>
              {connectionSelect}
              <button
                disabled={!connectionId}
                onClick={() =>
                  guard(async () => {
                    const d = await api("/api/live/verify", "POST", {
                      connectionId,
                    });
                    setStatus(`인증된 /user: ${d.user.login} (${d.user.id})`);
                  })
                }
              >
                인증 사용자 확인
              </button>
              <button
                disabled={!connectionId}
                onClick={() => {
                  const c = connections.find((c) => c.id === connectionId);
                  if (c) setForm(c);
                }}
              >
                설정 편집
              </button>
              <button
                disabled={!connectionId}
                onClick={() =>
                  guard(async () => {
                    await api("/api/connections", "DELETE", {
                      id: connectionId,
                    });
                    setConnectionId("");
                    await refresh();
                    setStatus("연결 삭제됨 · 캐시는 별도 삭제");
                  })
                }
              >
                연결 삭제
              </button>
              {engine}
              <SourcePanel api={api} ready={!!csrf} />
              <h3>로컬 민감 캐시</h3>
              <p>
                비공개 파일 저장 · 기본 30일 보존 · telemetry 없음 · 암호화
                아님. 삭제는 보안 소거가 아닙니다.
              </p>
              <button
                onClick={() =>
                  guard(async () => {
                    if (
                      !confirm(
                        "로컬 snapshot/분석/Git 캐시를 삭제할까요? 연결 설정은 유지합니다.",
                      )
                    )
                      return;
                    await api("/api/live/cache", "DELETE", {
                      confirm: "delete-local-cache",
                    });
                    setS(undefined);
                    setResult(undefined);
                    setJob(undefined);
                    await refresh();
                    setStatus("로컬 캐시 삭제 완료");
                  })
                }
              >
                로컬 캐시 삭제
              </button>
            </section>
          </div>
        </main>
      )}
      {u.page === "live-list" && (
        <main className="landing">
          <h1>내 PR / 직접 URL</h1>
          {connectionSelect}
          <div className="cards">
            <section>
              <h2>인증 사용자 PR</h2>
              <label>
                목록 유형
                <select
                  value={filters.tab}
                  onChange={(e) =>
                    setFilters({ ...filters, tab: e.target.value, page: 1 })
                  }
                >
                  <option value="authored">내가 작성</option>
                  <option value="review-requested">내 리뷰 요청</option>
                </select>
              </label>
              {(
                ["repository", "organization", "author", "search"] as const
              ).map((key, i) => (
                <label key={key}>
                  {
                    ["저장소 owner/repo", "조직", "추가 작성자 필터", "검색어"][
                      i
                    ]
                  }
                  <input
                    value={filters[key]}
                    onChange={(e) =>
                      setFilters({ ...filters, [key]: e.target.value, page: 1 })
                    }
                  />
                </label>
              ))}
              <label>
                PR 상태
                <select
                  value={filters.state}
                  onChange={(e) =>
                    setFilters({ ...filters, state: e.target.value, page: 1 })
                  }
                >
                  {["open", "closed", "merged", "all"].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
              <label>
                Draft
                <select
                  value={filters.draft}
                  onChange={(e) =>
                    setFilters({ ...filters, draft: e.target.value, page: 1 })
                  }
                >
                  {["all", "true", "false"].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
              <button
                disabled={!connectionId || busy}
                onClick={() =>
                  guard(async () =>
                    setList(
                      await api("/api/live/list", "POST", {
                        connectionId,
                        filters: { ...filters, page: 1 },
                      }),
                    ),
                  )
                }
              >
                내 PR 조회
              </button>
              {list && (
                <>
                  <p>
                    검색 총계 {list.total} · 현재 페이지 {list.page} · 확보{" "}
                    {list.items.length} ·{" "}
                    {list.complete ? "페이지 수집 완료" : "부분 목록"} · 남은
                    API {list.rateRemaining ?? "알 수 없음"}
                  </p>
                  {list.limitReason && (
                    <p className="notice">{list.limitReason}</p>
                  )}
                  {list.items.map((p: any) => (
                    <section className="pr-card" key={p.html_url}>
                      <h3>
                        #{p.number} {p.title}
                      </h3>
                      <p>
                        {p.state} · {p.draft ? "draft" : "ready"}
                      </p>
                      <button
                        disabled={busy}
                        onClick={() => startCapture(p.html_url)}
                      >
                        이 PR 수집
                      </button>
                    </section>
                  ))}
                  <button
                    disabled={list.page <= 1}
                    onClick={() =>
                      guard(async () =>
                        setList(
                          await api("/api/live/list", "POST", {
                            connectionId,
                            filters: { ...filters, page: list.page - 1 },
                          }),
                        ),
                      )
                    }
                  >
                    이전 페이지
                  </button>
                  <button
                    disabled={!list.hasMore}
                    onClick={() =>
                      guard(async () =>
                        setList(
                          await api("/api/live/list", "POST", {
                            connectionId,
                            filters: { ...filters, page: list.page + 1 },
                          }),
                        ),
                      )
                    }
                  >
                    다음 페이지
                  </button>
                </>
              )}
            </section>
            <section>
              <h2>등록 호스트의 PR URL</h2>
              <label>
                PR URL
                <input
                  type="url"
                  value={prURL}
                  onChange={(e) => setPrURL(e.target.value)}
                  placeholder="https://github.com/owner/repository/pull/123"
                />
              </label>
              <button
                className="primary"
                disabled={!connectionId || !prURL || busy}
                onClick={() => startCapture(prURL)}
              >
                고정 snapshot 수집
              </button>
              <p>
                이 동작은 선택한 GitHub/GHE의 원문과 Git 객체만 읽습니다. 모델
                전송은 별도의 명시적 실행 단계입니다.
              </p>
              <h2>저장된 snapshot</h2>
              {inventory.length === 0 && <p>아직 수집된 실제 PR이 없습니다.</p>}
              {inventory.map((item) => (
                <section className="pr-card" key={item.snapshotId}>
                  <h3>
                    {item.pr.repository} #{item.pr.number} · {item.pr.title}
                  </h3>
                  <p>
                    {item.capturedAt} ·{" "}
                    {item.stale
                      ? "stale / 과거 버전"
                      : "마지막 수집 · 실시간 최신 보증 아님"}
                  </p>
                  <button onClick={() => openSaved(item.snapshotId)}>
                    고정 버전 열기 / 이어보기
                  </button>
                </section>
              ))}
            </section>
          </div>
        </main>
      )}
      {u.page === "live-workspace" &&
        (s ? (
          <>
            <div className="workspace">
              <div className="summary">
                <div>
                  <h1>{s.pr.title}</h1>
                  <p>
                    {s.pr.repository} #{s.pr.number} · {s.pr.author} ·{" "}
                    {s.pr.state} {s.pr.draft ? "draft" : ""}
                  </p>
                  <p>{s.pr.body || "(PR 본문 없음)"}</p>
                  <p className="revision">
                    snapshot {s.snapshotId} · 수집 {s.capturedAt} ·{" "}
                    {stale
                      ? "STALE / 과거 분석"
                      : "고정 원문 · 현재 최신 여부 미확인"}
                  </p>
                </div>
                <button
                  disabled={busy}
                  onClick={() => {
                    setConnectionId(s.connectionId);
                    startCapture(s.pr.url);
                  }}
                >
                  같은 PR 명시적 새로 수집
                </button>
              </div>
              <details>
                <summary>모델 선택 / 전송 동의 / 분석 실행</summary>
                {engine}
                <button
                  className="primary"
                  disabled={busy || !consent || !model}
                  onClick={() => run({ kind: "pr" })}
                >
                  PR 맥락 분석 실행
                </button>
              </details>
              <details>
                <summary>Jira 후보 연결 / 제외 / 실제 원문 수집</summary>
                <SourcePanel
                  api={api}
                  ready={!!csrf}
                  snapshot={s}
                  onJob={setJob}
                />
              </details>
            </div>
            <LiveWorkspace
              key={s.snapshotId}
              snapshot={s}
              result={result}
              codeResult={codeResult}
              u={u}
              nav={nav}
              api={api}
              onError={setError}
              runCode={run}
              canRun={!busy && consent && !!model}
            />
          </>
        ) : (
          <main>저장된 고정 snapshot 읽는 중…</main>
        ))}
    </>
  );
}
function LiveWorkspace({
  snapshot: s,
  result,
  codeResult,
  u,
  nav,
  api,
  onError,
  runCode,
  canRun,
}: {
  snapshot: LiveSnapshot;
  result?: AnalysisResult;
  codeResult?: AnalysisResult;
  u: Record<string, string>;
  nav: (u: Record<string, string>) => void;
  api: (route: string, method?: string, body?: unknown) => Promise<any>;
  onError: (e: string) => void;
  runCode: (scope: Scope) => void;
  canRun: boolean;
}) {
  const [search, setSearch] = useState(""),
    [context, setContext] = useState(false),
    [focus, setFocus] = useState(false),
    [question, setQuestion] = useState("왜 바뀌었나?"),
    [comparison, setComparison] = useState<any>(),
    [from, setFrom] = useState(s.baseSha),
    [to, setTo] = useState(s.headSha),
    [source, setSource] = useState<SourceEvidence>(),
    [read, setRead] = useState<string[]>(() => {
      try {
        return JSON.parse(
          localStorage.getItem("live-read:" + s.snapshotId) || "[]",
        );
      } catch {
        return [];
      }
    });
  const phases = [s.baseline, ...s.phases],
    head = phases.find((p) => p.sha === s.headSha) || s.baseline,
    phase = phases.find((p) => p.sha === u.commit) || head,
    mode = u.mode || "Graph",
    rawFile = phase.files.find((f) => f.id === u.file),
    comparisonSha = u.comparison || phase.comparisonFromSha,
    alternateComparison = comparisonSha !== phase.comparisonFromSha,
    a = result?.output.schemaVersion === "2" ? result.output : undefined,
    rich = result?.output.schemaVersion === "3" ? result.output : undefined;
  const parentComparison = phase.parentComparisons.find(
    (c) => c.fromSha === comparisonSha && c.toSha === phase.sha,
  );
  const oldPaths = [
    ...new Set(
      parentComparison?.hunks
        .filter(
          (h) =>
            h.newPath === rawFile?.path ||
            (rawFile?.status === "deleted" && h.oldPath === rawFile.path),
        )
        .map((h) => h.oldPath)
        .filter(Boolean),
    ),
  ];
  const beforeFile =
    oldPaths.length === 1
      ? phases
          .find((p) => p.sha === comparisonSha)
          ?.files.find(
            (f) =>
              f.path === oldPaths[0] && f.status !== "deleted" && f.retrieved,
          )
      : undefined;
  const file =
    rawFile && alternateComparison
      ? {
          ...rawFile,
          oldPath: beforeFile?.path || oldPaths[0] || null,
          oldBlobSha: beforeFile?.blobSha || null,
          oldContent: beforeFile?.content ?? null,
        }
      : rawFile;
  // Navigation labels only. Grounded payloads below are rendered intact, not
  // downgraded into legacy strings or stored as a compatibility projection.
  const steps = rich
    ? rich.tour.steps.map((t) => ({
        id: t.id,
        title: t.title.text,
        revisionSha: t.targetRevisionSha,
        comparisonFromSha: t.comparisonFromSha,
        fileIds: t.focusFileIds,
        evidenceIds: t.focusEvidenceIds,
      }))
    : a?.steps || [];
  const readKey =
    "live-read:" +
    s.snapshotId +
    (rich ? ":" + result!.cacheKey + ":" + rich.tour.tourId : "");
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(readKey) || "[]");
      setRead(
        Array.isArray(stored)
          ? stored.filter((x) => typeof x === "string")
          : [],
      );
    } catch {
      setRead([]);
    }
  }, [readKey]);
  const evidence = [
    ...s.evidence,
    ...(result?.evidence || []),
    ...(codeResult?.evidence || []),
    ...(result?.selectionEvidence || []),
    ...(codeResult?.selectionEvidence || []),
  ];
  const step =
    steps.find((t) => t.id === u.step) ||
    steps.find((t) => t.id === u.tourStep) ||
    steps[0];
  const scope = codeResult?.scope;
  const displayResult =
    mode === "Code Explorer" &&
    !alternateComparison &&
    scope?.kind === "code" &&
    scope.commitSha === phase.sha &&
    scope.fileId === u.file &&
    scope.side === u.side &&
    scope.lineStart === Number(u.start) &&
    scope.lineEnd === Number(u.end)
      ? codeResult
      : result;
  const explanation =
    displayResult?.output.schemaVersion === "2"
      ? displayResult.output
      : undefined;
  const richExplanation =
    displayResult?.output.schemaVersion === "3"
      ? displayResult.output
      : undefined;
  const gotoEvidence = (e: Evidence) =>
    nav({
      commit: e.commitSha,
      comparison: e.comparisonFromSha || "",
      file: e.fileId,
      side: e.side,
      start: String(e.lineStart),
      end: String(e.lineEnd),
      mode: "Code Explorer",
      step: "",
      tourStep: u.step || u.tourStep || "",
    });
  const buttons = (ids: string[]) =>
    ids.map((id) => {
      const e = evidence.find((e) => e.id === id),
        source = s.sourceEvidence.find((e) => e.id === id);
      return (
        <button
          key={id}
          title={
            e
              ? `${e.revisionSha} · ${e.path} · ${e.side} · L${e.lineStart}–${e.lineEnd}`
              : source?.version
          }
          disabled={!e && !source}
          onClick={() => (e ? gotoEvidence(e) : setSource(source))}
        >
          {e
            ? `${e.path}:${e.lineStart}–${e.lineEnd} (${e.side})`
            : source
              ? `${source.sourceKind} ${source.fieldPath}`
              : "유효 근거 없음"}
        </button>
      );
    });
  const chooseFile = (id: string) => {
    const f = phase.files.find((f) => f.id === id);
    const e = evidence.find(
      (e) =>
        e.commitSha === phase.sha &&
        e.fileId === id &&
        e.side === (f?.status === "deleted" ? "old" : "new") &&
        e.lineStart === 1,
    );
    if (e) gotoEvidence(e);
    else
      nav({
        file: id,
        start: "",
        end: "",
        side: f?.status === "deleted" ? "old" : "new",
        mode: "Code Explorer",
      });
  };
  const choosePhase = (p: LivePhase) => {
    nav({
      commit: p.sha,
      comparison: p.comparisonFromSha || "",
      file: "",
      side: "new",
      start: "1",
      end: "1",
      step: "",
      mode: "Graph",
    });
    setSource(undefined);
  };
  const chooseStep = (t: NonNullable<typeof step>) => {
    // Follow the validated ordered primary focus, not collector insertion
    // order (which commonly lists before/old evidence first).
    const e = t.evidenceIds.map((id) => evidence.find((e) => e.id === id))
      .find((e) => e?.commitSha === t.revisionSha);
    nav({
      commit: t.revisionSha,
      comparison: t.comparisonFromSha || "",
      file: e?.fileId || t.fileIds[0],
      side: e?.side || "new",
      start: String(e?.lineStart || 1),
      end: String(e?.lineEnd || 1),
      step: t.id,
      tourStep: t.id,
      tour: rich?.tour.tourId || "",
      mode: "Guided Flow",
    });
  };
  const content =
    u.side === "old"
      ? file?.oldContent
      : file?.status === "deleted"
        ? null
        : file?.content;
  const invalid =
    (u.commit && !phases.some((p) => p.sha === u.commit)) ||
    (u.file && !file) ||
    (u.side && !["old", "new"].includes(u.side)) ||
    (u.comparison !== undefined &&
      u.comparison !== "" &&
      u.comparison !== (phase.comparisonFromSha || "") &&
      !parentComparison) ||
    (u.mode && !["Graph", "Guided Flow", "Code Explorer"].includes(u.mode)) ||
    (u.step && (!step || step.id !== u.step)) ||
    (rich && u.tour && u.tour !== rich.tour.tourId) ||
    (mode === "Guided Flow" && (!step || step.revisionSha !== phase.sha)) ||
    (file &&
      (u.start || u.end) &&
      (!content ||
        !Number.isInteger(Number(u.start)) ||
        !Number.isInteger(Number(u.end)) ||
        Number(u.start) < 1 ||
        Number(u.end) < Number(u.start) ||
        Number(u.end) > content.replace(/\n$/, "").split("\n").length));
  if (invalid)
    return (
      <main className="workspace" role="alert">
        <h2>선택 상태가 고정 snapshot과 맞지 않습니다</h2>
        <p>다른 SHA/라인에 몰래 연결하지 않았습니다.</p>
        <button onClick={() => choosePhase(head)}>고정 head 열기</button>
      </main>
    );
  const allIds = [
    ...new Set(phases.flatMap((p) => p.files.map((f) => f.id))),
  ].sort();
  const neighbors = new Set([
    u.file,
    ...phase.edges
      .filter((e) => e.source === u.file || e.target === u.file)
      .flatMap((e) => [e.source, e.target]),
  ]);
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
      position: { x: (i % 3) * 255, y: Math.floor(i / 3) * 115 },
      data: {
        label: (
          <div>
            <b>{f.path}</b>
            <small>
              {f.status}
              {!f.retrieved ? " · 원문 제외" : ""}
              {f.status === "unchanged" ? " · 문맥" : ""}
            </small>
          </div>
        ),
      },
      style: {
        background: f.id === u.file ? "#234e5c" : "#172633",
        color: "#e2edf4",
        border: `1px ${f.status === "deleted" ? "dashed" : "solid"} ${f.status === "added" ? "#55ceaa" : "#405568"}`,
        width: 225,
        borderRadius: 8,
      },
      selected:
        mode === "Guided Flow"
          ? !!step?.fileIds.includes(f.id)
          : f.id === u.file,
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
      style: {
        stroke: "#5da7bd",
        strokeWidth:
          mode === "Guided Flow" &&
          rich?.tour.steps
            .find((t) => t.id === step?.id)
            ?.focusGraphEdgeIds.includes(e.id)
            ? 4
            : 1,
      },
      labelStyle: { fill: "#a9cbd6" },
      labelBgStyle: { fill: "#132330" },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#5da7bd" },
    }));
  const inferredEdges = (rich?.inferredEdgeSuggestions || [])
    .filter(
      (e) =>
        e.revisionSha === phase.sha &&
        visible.some((f) => f.id === e.fromFileId) &&
        visible.some((f) => f.id === e.toFileId),
    )
    .map((e) => ({
      id: e.id,
      source: e.fromFileId,
      target: e.toFileId,
      label: `${e.relationType} · inferred`,
      style: { stroke: "#edbd71", strokeDasharray: "7 5" },
      labelStyle: { fill: "#edbd71" },
      labelBgStyle: { fill: "#132330" },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#edbd71" },
    }));
  return (
    <main className="workspace live-workspace">
      <div className="timeline">
        {phases.map((p, i) => (
          <button
            key={p.sha}
            aria-pressed={phase.sha === p.sha}
            onClick={() => choosePhase(p)}
          >
            <b>{i ? "Phase " + i : "Baseline"}</b>
            <span>{p.subject}</span>
            <code>{p.sha.slice(0, 8)}</code>
          </button>
        ))}
      </div>
      <p className="revision">
        SHA {phase.sha} · 비교 {comparisonSha || "없음"} · 실제 부모{" "}
        {phase.parents.join(", ") || "root"}
        <br />
        {s.comparisonPolicy}
      </p>
      <nav className="modes">
        {["Graph", "Guided Flow", "Code Explorer"].map((m) => (
          <button
            key={m}
            disabled={m === "Guided Flow" && !step}
            aria-pressed={mode === m}
            onClick={() =>
              m === "Guided Flow" && step ? chooseStep(step) : nav({ mode: m })
            }
          >
            {m}
          </button>
        ))}
        <span>
          {result
            ? `분석 ${result.output.analysisStatus} · 위치 검증 통과 · 의미 감사 ${result.semanticAudit?.status || "not_performed"}`
            : "분석 미실행 · 원문 탐색만 가능"}
        </span>
      </nav>
      <div className="layout">
        <aside>
          <h3>파일 / 정확한 phase tree</h3>
          <input
            aria-label="실제 파일 검색"
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
            미변경 문맥 확장
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
              onClick={() => chooseFile(f.id)}
            >
              <span>{f.path}</span>
              <small>
                {f.status} {f.omission || ""}
              </small>
            </button>
          ))}
          <h3>Jira / 요구사항</h3>
          <p>{s.jiraStatus} · Jira 없이 PR 탐색 가능</p>
          {s.sourceEvidence
            .filter((e) => e.sourceKind === "jira")
            .map((e) => (
              <button key={e.id} onClick={() => setSource(e)}>
                {e.issueKey} {e.fieldPath}
              </button>
            ))}
          {a?.requirementMappings.map((r, i) => (
            <section key={i}>
              <b>{r.status}</b>
              <p>{r.explanation}</p>
              {buttons([r.requirementId, ...r.evidenceIds])}
            </section>
          ))}
          {rich && <GroundedRequirements output={rich} buttons={buttons} />}
        </aside>
        <article>
          <section data-testid="live-phase-message">
            <div className="eyebrow">원문 GIT · {phase.date}</div>
            <h3>{phase.subject}</h3>
            <pre>{phase.body || "(본문 없음)"}</pre>
            <details>
              <summary>원문 메시지와 작성자</summary>
              <pre>{phase.message}</pre>
              <p>{phase.author}</p>
            </details>
          </section>
          {mode !== "Code Explorer" && (
            <section>
              <div className="graph">
                <ReactFlow
                  nodes={nodes}
                  edges={[...edges, ...inferredEdges]}
                  fitView
                  nodesDraggable={false}
                  minZoom={0.2}
                  onNodeClick={(_, n) => chooseFile(n.id)}
                  onEdgeClick={(_, e) => {
                    const id =
                      phase.edges.find((x) => x.id === e.id)?.evidenceId ||
                      rich?.inferredEdgeSuggestions.find((x) => x.id === e.id)
                        ?.explanation.evidenceIds[0];
                    const ref = evidence.find((x) => x.id === id);
                    if (ref) gotoEvidence(ref);
                  }}
                >
                  <Background gap={22} color="#304657" />
                  <Controls />
                </ReactFlow>
              </div>
              <p className="legend">
                AST import는 호출/실행 순서가 아닙니다. 점선 테두리는 삭제 흔적;
                현재 파일이 아닙니다. 황색 점선 관계는 inferred, 정적 확인이
                아닙니다. 읽기 순서는 별도 StoryEdge입니다.
              </p>
            </section>
          )}
          {mode === "Guided Flow" && step && (
            <section data-testid="live-tour">
              {rich ? (
                <GroundedTourStep
                  output={rich}
                  step={rich.tour.steps.find((t) => t.id === step.id)!}
                  buttons={buttons}
                  choose={(id) => chooseStep(steps.find((t) => t.id === id)!)}
                />
              ) : (
                <>
                  <h2>{step.title}</h2>
                  <p>
                    지금 읽는 이유:{" "}
                    {a!.steps.find((t) => t.id === step.id)!.why}
                  </p>
                  <p>
                    이전 연결:{" "}
                    {a!.steps.find((t) => t.id === step.id)!.previous}
                  </p>
                  <p>
                    변경 전후:{" "}
                    {a!.steps.find((t) => t.id === step.id)!.beforeAfter}
                  </p>
                  {buttons(step.evidenceIds)}
                  <p>
                    사람이 확인할 질문:{" "}
                    {a!.steps.find((t) => t.id === step.id)!.question}
                  </p>
                  <p>
                    다음 이유: {a!.steps.find((t) => t.id === step.id)!.next}
                  </p>
                </>
              )}
              <div className="step-list">
                {steps.map((t, i) => (
                  <button
                    key={t.id}
                    aria-pressed={t.id === step.id}
                    onClick={() => chooseStep(t)}
                  >
                    {i + 1}. {t.title}
                    {read.includes(t.id) ? " ✓" : ""}
                  </button>
                ))}
              </div>
              <button
                disabled={steps.indexOf(step) === 0}
                onClick={() => chooseStep(steps[steps.indexOf(step) - 1])}
              >
                이전 단계
              </button>
              <button
                onClick={() => {
                  const next = read.includes(step.id)
                    ? read.filter((x) => x !== step.id)
                    : [...read, step.id];
                  setRead(next);
                  localStorage.setItem(readKey, JSON.stringify(next));
                }}
              >
                읽음 표시 / 취소
              </button>
              <button
                disabled={steps.indexOf(step) === steps.length - 1}
                onClick={() => chooseStep(steps[steps.indexOf(step) + 1])}
              >
                다음 단계
              </button>
              <p>
                읽음{" "}
                {read.filter((id) => steps.some((t) => t.id === id)).length} /{" "}
                {steps.length}
              </p>
            </section>
          )}
          {file && (
            <section>
              <h3>
                {file.path} · {file.status}
              </h3>
              {file.renameEvidence && (
                <p>
                  {file.oldPath} → {file.path} · {file.renameEvidence} · lineage{" "}
                  {file.lineage}
                </p>
              )}
              <div className="revision" data-testid="live-evidence-location">
                {u.side} · SHA {u.side === "old" ? comparisonSha : phase.sha} ·{" "}
                {u.side === "old" ? file.oldPath : file.path} · L{u.start}–
                {u.end}
              </div>
              {file.omission && (
                <p className="notice">
                  원문 정책 제외: {file.omission}. 빈 내용으로 분석하지
                  않았습니다.
                </p>
              )}
              <div className="diff-grid">
                {(["old", "new"] as const).map((side) => {
                  const content =
                    side === "old"
                      ? file.oldContent
                      : file.status === "deleted" || !file.retrieved
                        ? null
                        : file.content;
                  return (
                    <div
                      className="code-pane"
                      key={side}
                      data-testid={"live-code-" + side}
                    >
                      <h4>
                        {side} ·{" "}
                        {(side === "old" ? comparisonSha : phase.sha)?.slice(
                          0,
                          12,
                        )}
                      </h4>
                      {content === null ? (
                        <p>이 side에 내용 없음 / 확보 안 됨</p>
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
                                  onClick={(event) =>
                                    nav({
                                      side,
                                      start:
                                        event.shiftKey && u.side === side
                                          ? String(
                                              Math.min(
                                                Number(u.start) || 1,
                                                i + 1,
                                              ),
                                            )
                                          : String(i + 1),
                                      end: String(i + 1),
                                      mode: "Code Explorer",
                                      step: "",
                                    })
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
                })}
              </div>
              <p>
                라인 클릭 / Shift+클릭으로 범위 선택. 선택 범위만 Q&A에
                보냅니다.
              </p>
            </section>
          )}
          <details className="rawdiff">
            <summary>
              선택 커밋 실제 첫 부모 diff / hunks {phase.hunks.length}
            </summary>
            <pre>{phase.diff || "비교 없음 또는 수집 제외"}</pre>
          </details>
          {phase.parentComparisons.length > 1 && (
            <details>
              <summary>모든 실제 부모별 diff</summary>
              {phase.parentComparisons.map((c) => (
                <section key={c.fromSha}>
                  <p>
                    {c.fromSha} → {c.toSha} ·{" "}
                    {c.partial ? "partial" : "retrieved"}
                  </p>
                  <pre>{c.diff}</pre>
                </section>
              ))}
            </details>
          )}
          <details className="rawdiff">
            <summary>PR 전체 순변경 · merge-base → head</summary>
            <p>
              {s.chosenComparisonBaseSha ||
                "유일한 merge-base 없음; diff 만들지 않음"}{" "}
              → {s.headSha}
            </p>
            <pre>{s.netDiff}</pre>
          </details>
          <details>
            <summary>임의의 고정 revision 비교 (커밋 변화와 별개)</summary>
            <label>
              From
              <select value={from} onChange={(e) => setFrom(e.target.value)}>
                {[
                  ...new Set([
                    s.baseSha,
                    ...phases.flatMap((p) => [p.sha, ...p.parents]),
                  ]),
                ].map((sha) => (
                  <option key={sha}>{sha}</option>
                ))}
              </select>
            </label>
            <label>
              To
              <select value={to} onChange={(e) => setTo(e.target.value)}>
                {phases.map((p) => (
                  <option key={p.sha}>{p.sha}</option>
                ))}
              </select>
            </label>
            <button
              onClick={() =>
                api("/api/live/compare", "POST", {
                  snapshotId: s.snapshotId,
                  fromSha: from,
                  toSha: to,
                })
                  .then(setComparison)
                  .catch((e) => onError(String(e)))
              }
            >
              고정 SHA 비교
            </button>
            {comparison && (
              <>
                <p>
                  {comparison.policy} · {comparison.fromSha} →{" "}
                  {comparison.toSha}
                </p>
                <pre>{comparison.diff}</pre>
              </>
            )}
          </details>
        </article>
        <aside>
          <h3>위치 검증된 설명 / 근거 · 의미는 별도 확인</h3>
          {richExplanation && (
            <>
              <PipelineStatus
                result={displayResult as unknown as PipelineResult}
                buttons={buttons}
              />
              <GroundedDetails
                output={richExplanation}
                phaseSha={phase.sha}
                comparisonSha={comparisonSha}
                fileId={file?.id}
                side={u.side}
                start={Number(u.start)}
                end={Number(u.end)}
                evidence={evidence}
                buttons={buttons}
              />
            </>
          )}
          {explanation && (
            <section data-testid="live-analysis-status">
              프로세스 완료 · 분석 {explanation.analysisStatus} · 구버전 2 저장
              표시
            </section>
          )}
          {!explanation && !richExplanation && (
            <p>
              실제 AI 분석을 아직 실행하지 않았습니다. 위에서 모델과 범위를
              선택한 뒤 명시적으로 실행하세요. 모의 설명으로 대체하지 않습니다.
            </p>
          )}
          {explanation?.statements
            .filter((x) => x.commitSha === phase.sha)
            .map((x, i) => (
              <section key={i}>
                <span className="badge">{x.kind}</span>
                <p>{x.text}</p>
                {buttons(x.evidenceIds)}
                <small>
                  {x.limitation} · confidence {x.confidence} (모델 자기평가)
                </small>
              </section>
            ))}
          {explanation?.codeExplanations
            .filter(
              (x) =>
                evidence.find((e) => e.id === x.evidenceId)?.fileId ===
                  u.file &&
                evidence.find((e) => e.id === x.evidenceId)?.commitSha ===
                  phase.sha &&
                evidence.find((e) => e.id === x.evidenceId)?.side === u.side,
            )
            .map((x, i) => (
              <section key={i}>
                <h4>{x.role}</h4>
                <p>입출력: {x.inputsOutputs}</p>
                <p>{x.behavior}</p>
                <p>오류: {x.errors}</p>
                <p>부작용: {x.sideEffects}</p>
                {buttons([x.evidenceId])}
              </section>
            ))}
          {source && (
            <section data-testid="live-source">
              <h3>{source.sourceKind} 원문</h3>
              <p>
                {source.sourceId} · {source.fieldPath}
              </p>
              <pre>{source.text}</pre>
              <small>
                version {source.version} · hash {source.contentHash}
                <br />
                {source.fetchedAt} / updated {source.updatedAt}
                <br />
                현재 수집 시점, 커밋 당시 요구사항 보증 아님
              </small>
              <button onClick={() => setSource(undefined)}>원문 닫기</button>
            </section>
          )}
          <h3>선택 코드 질문</h3>
          <label>
            질문
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </label>
          <button
            disabled={
              !canRun ||
              !file ||
              !u.start ||
              !u.end ||
              alternateComparison ||
              !content
            }
            onClick={() =>
              runCode({
                kind: "code",
                commitSha: phase.sha,
                fileId: file!.id,
                side: u.side as "old" | "new",
                lineStart: Number(u.start),
                lineEnd: Number(u.end),
                question,
              })
            }
          >
            선택 범위 설명 실행
          </button>
          {alternateComparison && (
            <p className="notice">
              추가 부모의 정확한 원문을 표시합니다. 코드 Q&A 계약은 선택 Phase의
              첫 부모 비교만 지원하므로 이 비교에서는 실행하지 않습니다. 원하는
              부모 Phase를 명시적으로 선택하세요.
            </p>
          )}
          <p className="muted">
            실행 동의와 모델은 위에서 선택합니다. navigation / reload는 실행하지
            않습니다.
          </p>
          <h3>Coverage · partial 명시</h3>
          <p>
            head 발견 {s.coverage.discovered} · 원문 확보 {s.coverage.retrieved}{" "}
            · AST 파서 대상 {s.coverage.analyzed} (모델 분석 아님)
            <br />
            커밋 {s.coverage.commitsRetrieved}/{s.coverage.commitsDiscovered}
            <br />
            대상 테스트 실행: 안 함 · CI 조회: 안 함
          </p>
          <p>parser {s.coverage.parser}</p>
          {s.coverage.collection && (
            <details>
              <summary>수집 우선순위 / 직접 import 문맥 coverage</summary>
              <pre>{JSON.stringify(s.coverage.collection, null, 2)}</pre>
            </details>
          )}
          {explanation?.limitations.map((x, i) => (
            <p key={i}>{x}</p>
          ))}
          {explanation?.missingContext.map((x, i) => (
            <p key={i}>{x}</p>
          ))}
          {displayResult?.contextCoverage && (
            <section data-testid="live-context-coverage">
              <h4>모델 전송 범위 · 수집 coverage와 별개</h4>
              <p>
                JSON UTF-8 {displayResult.contextCoverage.serializedBytes}/
                {displayResult.contextCoverage.byteLimit} bytes · 전송 근거{" "}
                {displayResult.contextCoverage.transmittedEvidenceIds.length} ·
                제외 근거{" "}
                {displayResult.contextCoverage.missingEvidenceIds.length}
              </p>
              {displayResult.contextCoverage.contextOmissions.map((x, i) => (
                <p key={i}>{x}</p>
              ))}
              <details>
                <summary>전송 / 제외 ID 원문</summary>
                <pre>
                  {JSON.stringify(displayResult.contextCoverage, null, 2)}
                </pre>
              </details>
            </section>
          )}
          <details>
            <summary>정책상 제외 / 지원 범위</summary>
            {s.coverage.omitted.map((x, i) => (
              <p key={i}>{x}</p>
            ))}
          </details>
          <details>
            <summary>접근 / 이력 / API 누락</summary>
            {s.coverage.unavailable.map((x, i) => (
              <p key={i}>{x}</p>
            ))}
            <pre>{JSON.stringify(s.coverage.api, null, 2)}</pre>
          </details>
          <details>
            <summary>실행 출처 / 검증 한계</summary>
            <pre>
              {JSON.stringify(
                displayResult?.metadata || { status: "not_run" },
                null,
                2,
              )}
            </pre>
            <p>
              위치 검사는 의미적 지지를 증명하지 않습니다. 의미 감사{" "}
              {displayResult?.semanticAudit?.status || "not_performed"}. 테스트
              통과나 요구사항 충족을 확정하지 않습니다.
            </p>
          </details>
        </aside>
      </div>
    </main>
  );
}
