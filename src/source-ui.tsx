import React, { useEffect, useState } from "react";
import type { JiraSettings } from "./server/source-bridge";
import type { CandidateDiscovery, JiraConnection } from "./server/jira/index";
import type { Job } from "./server/live-api";
import type { LiveSnapshot } from "./server/live-git";
export function SourcePanel({
  api,
  ready,
  snapshot,
  onJob,
}: {
  api: (route: string, method?: string, body?: unknown) => Promise<any>;
  ready: boolean;
  snapshot?: LiveSnapshot;
  onJob?: (job: Job) => void;
}) {
  const [settings, setSettings] = useState<JiraSettings>({
      connections: [],
      projectHosts: {},
    }),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [discovery, setDiscovery] = useState<CandidateDiscovery>(),
    [manual, setManual] = useState(""),
    [site, setSite] = useState(""),
    [projects, setProjects] = useState(""),
    [fields, setFields] = useState(""),
    [envName, setEnvName] = useState(""),
    [scheme, setScheme] = useState<"Bearer" | "Basic">("Bearer"),
    [authentication, setAuthentication] = useState<
      "token" | "anonymous" | "env"
    >("token"),
    [email, setEmail] = useState(""),
    [token, setToken] = useState(""),
    [customCaPem, setCustomCaPem] = useState(""),
    [summary, setSummary] =
      useState<import("./server/jira-onboarding").JiraConnectionSummary>(),
    [busy, setBusy] = useState(false),
    [form, setForm] = useState<JiraConnection>({
      id: "jira",
      deployment: "cloud",
      webBaseUrl: "",
      apiBaseUrl: "",
      accountContextId: "",
    });
  const act = async (fn: () => Promise<void>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    if (ready) act(async () => setSettings(await api("/api/jira/settings")));
  }, [ready]);
  useEffect(() => setDiscovery(undefined), [snapshot?.snapshotId]);
  if (snapshot)
    return (
      <section>
        <h3>Jira 후보 / 선택 수집</h3>
        <p>{snapshot.jiraStatus} · 이슈 접근 실패는 PR 분석을 막지 않습니다.</p>
        <button
          onClick={() =>
            act(async () =>
              setDiscovery(
                await api("/api/jira/candidates", "POST", {
                  snapshotId: snapshot.snapshotId,
                }),
              ),
            )
          }
        >
          PR / 커밋에서 Jira 후보 탐색
        </button>
        {discovery && (
          <>
            <p>
              후보 {discovery.candidates.length} · 제외는 원래 발견 출처를
              보존합니다.
            </p>
            {discovery.candidates.map((c) => (
              <div key={c.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={!c.excluded}
                    onChange={(e) =>
                      act(async () =>
                        setDiscovery(
                          await api("/api/jira/candidates/edit", "POST", {
                            snapshotId: snapshot.snapshotId,
                            candidateId: c.id,
                            excluded: !e.target.checked,
                          }),
                        ),
                      )
                    }
                  />
                  {c.key} · {c.host || "미연결 호스트"}
                </label>
                <details>
                  <summary>발견 근거</summary>
                  {c.provenance.map((p, i) => (
                    <p key={i}>
                      {p.fieldPath} [{p.start}–{p.end}] {p.matchedText} ·{" "}
                      {p.method}
                    </p>
                  ))}
                </details>
              </div>
            ))}
            <label>
              수동 Jira 연결
              <select value={site} onChange={(e) => setSite(e.target.value)}>
                <option value="">선택</option>
                {settings.connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} · {c.webBaseUrl}
                  </option>
                ))}
              </select>
            </label>
            <label>
              수동 이슈 키
              <input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                placeholder="TEAM-123"
              />
            </label>
            <button
              disabled={!site || !manual}
              onClick={() =>
                act(async () =>
                  setDiscovery(
                    await api("/api/jira/candidates/edit", "POST", {
                      snapshotId: snapshot.snapshotId,
                      connectionId: site,
                      key: manual,
                    }),
                  ),
                )
              }
            >
              수동 후보 연결
            </button>
            <button
              onClick={() =>
                act(async () => {
                  const j = await api("/api/jira/capture", "POST", {
                    snapshotId: snapshot.snapshotId,
                  });
                  onJob?.(j);
                  setMessage("Jira 원문 수집 시작 · 새 snapshot 생성");
                })
              }
            >
              선택 Jira 원문 수집
            </button>
          </>
        )}
        {error && <p role="alert">{error}</p>}
        <p>{message}</p>
        {snapshot.jiraData && (
          <details>
            <summary>Jira 수집 상태 / 원문 / 시점</summary>
            {snapshot.jiraData.batch.items.map((item, i) => (
              <section key={i}>
                <h4>
                  {item.candidate.key} · {item.result.state}
                </h4>
                {item.result.state === "captured" ? (
                  <>
                    <p>{item.result.snapshot.title.text}</p>
                    <p>{item.result.snapshot.description.text}</p>
                    <small>
                      fetched {item.result.snapshot.fetchedAt} · updated{" "}
                      {item.result.snapshot.updatedAt}
                      <br />
                      raw hash {item.result.snapshot.sourceHash}
                    </small>
                    <details>
                      <summary>raw source (untrusted text)</summary>
                      <pre>{item.result.snapshot.source.rawResponse}</pre>
                    </details>
                  </>
                ) : (
                  <p>{item.result.reason}</p>
                )}
              </section>
            ))}
          </details>
        )}
      </section>
    );
  return (
    <section>
      <h3>Jira 연결 (선택 사항)</h3>
      <p>
        Cloud Enterprise는 요금제이며 Enterprise 서버 (Data Center)와 다릅니다.
        인스턴스 Web URL을 입력하면 API와 계정을 자동 확인합니다.
      </p>
      <p>
        토큰은 메모리에만 보관 · 앱 종료 시 삭제 · 재시작 후 다시 연결하세요.
        Jira는 선택 사항이며 실패해도 PR 분석을 계속할 수 있습니다.
      </p>
      <form
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setSummary(undefined);
          setMessage("");
          const submittedToken = token;
          setToken("");
          act(async () => {
            try {
              const result = await api("/api/jira/connect", "POST", {
                deployment: form.deployment,
                webUrl: form.webBaseUrl,
                authentication,
                ...(authentication === "token"
                  ? {
                      token: submittedToken,
                      ...(form.deployment === "cloud" ? { email } : {}),
                    }
                  : {}),
                advanced: {
                  ...(form.apiBaseUrl ? { apiBaseUrl: form.apiBaseUrl } : {}),
                  ...(customCaPem ? { customCaPem } : {}),
                  // Preserve malformed/empty list tokens so validation can reject them, not silently repair.
                  ...(projects ? { projectKeys: projects.split(",") } : {}),
                  ...(fields
                    ? {
                        acceptanceCriteriaFields: fields
                          .split(",")
                          .map((id) => ({ id })),
                      }
                    : {}),
                  ...(authentication === "env"
                    ? { credential: { kind: "env", variable: envName, scheme } }
                    : {}),
                },
              });
              setSettings(result.settings);
              setSummary(result.summary);
              setMessage(
                result.summary.status === "connected"
                  ? "Jira 연결 확인 완료 · 계정 자동 매핑"
                  : "익명 접근 · 계정 인증 없음 · 이슈 권한은 수집 시 확인",
              );
            } finally {
              setBusy(false);
            }
          });
        }}
      >
        <label>
          Jira 배포
          <select
            value={form.deployment}
            onChange={(e) => {
              setForm({ ...form, deployment: e.target.value as any });
              setToken("");
              setSummary(undefined);
            }}
          >
            <option value="cloud">Cloud (Enterprise 플랜 포함)</option>
            <option value="data_center">Enterprise 서버 (Data Center)</option>
          </select>
        </label>
        <label>
          Jira Web URL
          <input
            required
            type="url"
            value={form.webBaseUrl}
            onChange={(e) => setForm({ ...form, webBaseUrl: e.target.value })}
            placeholder={
              form.deployment === "cloud"
                ? "https://team.atlassian.net"
                : "https://jira.company.example/jira"
            }
          />
        </label>
        <label>
          Jira 인증
          <select
            value={authentication}
            onChange={(e) => {
              setAuthentication(e.target.value as any);
              setToken("");
            }}
          >
            <option value="token">
              {form.deployment === "cloud"
                ? "이메일 + API 토큰"
                : "PAT (Bearer)"}
            </option>
            <option value="anonymous">
              공개 이슈만 (익명, 계정 인증 없음)
            </option>
            <option value="env">고급: 서버 환경변수</option>
          </select>
        </label>
        {authentication === "token" && (
          <>
            {form.deployment === "cloud" && (
              <label>
                Jira 이메일
                <input
                  required
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
            )}
            <label>
              {form.deployment === "cloud" ? "Jira API 토큰" : "Jira PAT"}
              <input
                required
                type="password"
                autoComplete="new-password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            {form.deployment === "cloud" && (
              <p>
                일반 API 토큰을 사용하세요. api.atlassian.com / cloud ID가
                필요한 scoped 토큰은 이 연결 방식에서 지원하지 않습니다. 외부
                호스트로 자동 재시도하지 않습니다.
              </p>
            )}
          </>
        )}
        <details>
          <summary>고급 설정 (선택)</summary>
          <label>
            Jira API base URL
            <input
              type="url"
              value={form.apiBaseUrl}
              onChange={(e) => setForm({ ...form, apiBaseUrl: e.target.value })}
              placeholder="자동 · 같은 origin만 지원 · /rest/api 제외"
            />
          </label>
          <label>
            프로젝트 키 목록
            <input
              value={projects}
              onChange={(e) => setProjects(e.target.value)}
              placeholder="TEAM,APP"
            />
          </label>
          <p>
            키만 있는 후보의 호스트 매핑은 명시적으로 설정합니다. 링크 후보는
            등록한 Web URL과 대조합니다.
          </p>
          <label>
            수용 기준 필드 ID
            <input
              value={fields}
              onChange={(e) => setFields(e.target.value)}
              placeholder="customfield_10001"
            />
          </label>
          <label>
            Jira 사용자 CA PEM
            <textarea
              value={customCaPem}
              onChange={(e) => setCustomCaPem(e.target.value)}
            />
          </label>
          <p>
            TLS 검증은 항상 유지됩니다. 프록시는 자동 사용하지 않습니다. 사내
            VPN / 승인된 직접 연결 또는 서버 관리자가 구성한 전송을 사용하세요.
          </p>
        </details>
        {authentication === "env" && (
          <>
            <label>
              Jira 시크릿 환경변수 이름
              <input
                required
                value={envName}
                onChange={(e) => setEnvName(e.target.value)}
                placeholder="PRCE_JIRA_TOKEN"
              />
            </label>
            <label>
              인증 헤더 방식
              <select
                value={scheme}
                onChange={(e) => setScheme(e.target.value as any)}
              >
                <option>Bearer</option>
                <option>Basic</option>
              </select>
            </label>
            <p>
              기존 서버 환경변수 방식입니다. Cloud Basic 값은 이메일:토큰의
              base64이며 Data Center 기본값은 PAT Bearer입니다.
            </p>
          </>
        )}
        <button disabled={!ready || busy}>
          {busy ? "Jira 확인 중…" : "Jira 연결 및 자동 확인"}
        </button>
      </form>
      {summary && (
        <dl data-testid="jira-connection-summary">
          <dt>인증 상태</dt>
          <dd>{summary.authentication}</dd>
          <dt>Web URL</dt>
          <dd>{summary.webBaseUrl}</dd>
          <dt>자동 API URL</dt>
          <dd>
            {summary.apiBaseUrl}/rest/api/{summary.apiVersion}
          </dd>
          <dt>확인된 계정</dt>
          <dd>{summary.accountId ?? "없음 (익명)"}</dd>
          <dt>서버 버전 (/serverInfo)</dt>
          <dd>
            {summary.serverVersion ?? "확인 불가"} · {summary.metadataStatus}
          </dd>
        </dl>
      )}
      <p data-testid="jira-settings-status">{message}</p>
      {error && <p role="alert">{error}</p>}
      {settings.connections.map((c) => (
        <p key={c.id}>
          {c.id} · {c.deployment} · {c.webBaseUrl}
          <button
            onClick={() =>
              act(async () => {
                const projectHosts = Object.fromEntries(
                  Object.entries(settings.projectHosts).map(([k, ids]) => [
                    k,
                    ids.filter((id) => id !== c.id),
                  ]),
                );
                setSettings(
                  await api("/api/jira/settings", "POST", {
                    ...settings,
                    connections: settings.connections.filter(
                      (x) => x.id !== c.id,
                    ),
                    projectHosts,
                  }),
                );
                setMessage("Jira 연결 삭제됨");
              })
            }
          >
            Jira 연결 삭제
          </button>
        </p>
      ))}
    </section>
  );
}
