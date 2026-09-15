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
        Cloud / Data Center를 구분합니다. 서버 환경변수 이름만 저장하며 실제
        이슈는 workspace에서 명시적으로 수집합니다.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          act(async () => {
            const c: JiraConnection = {
              ...form,
              ...(envName
                ? { credential: { kind: "env", variable: envName, scheme } }
                : {}),
              acceptanceCriteriaFields: fields
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean)
                .map((id) => ({ id })),
            };
            const next: JiraSettings = {
              ...settings,
              connections: [
                ...settings.connections.filter((x) => x.id !== c.id),
                c,
              ],
              projectHosts: { ...settings.projectHosts },
            };
            for (const key of projects
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean))
              next.projectHosts[key] = [
                ...new Set([...(next.projectHosts[key] || []), c.id]),
              ];
            setSettings(await api("/api/jira/settings", "POST", next));
            setMessage(
              "Jira 연결 저장 완료 · 인증 확인은 실제 후보 수집 시 수행",
            );
          });
        }}
      >
        <label>
          Jira 연결 ID
          <input
            required
            value={form.id}
            onChange={(e) => setForm({ ...form, id: e.target.value })}
          />
        </label>
        <label>
          Jira 배포
          <select
            value={form.deployment}
            onChange={(e) =>
              setForm({ ...form, deployment: e.target.value as any })
            }
          >
            <option value="cloud">Cloud REST v3</option>
            <option value="data_center">Data Center REST v2</option>
          </select>
        </label>
        <label>
          Jira Web URL
          <input
            required
            type="url"
            value={form.webBaseUrl}
            onChange={(e) => setForm({ ...form, webBaseUrl: e.target.value })}
          />
        </label>
        <label>
          Jira API base URL
          <input
            required
            type="url"
            value={form.apiBaseUrl}
            onChange={(e) => setForm({ ...form, apiBaseUrl: e.target.value })}
          />
        </label>
        <label>
          Jira 계정 맥락
          <input
            required
            value={form.accountContextId}
            onChange={(e) =>
              setForm({ ...form, accountContextId: e.target.value })
            }
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
        <label>
          수용 기준 필드 ID
          <input
            value={fields}
            onChange={(e) => setFields(e.target.value)}
            placeholder="customfield_10001"
          />
        </label>
        <label>
          Jira 시크릿 환경변수 이름
          <input
            value={envName}
            onChange={(e) => setEnvName(e.target.value)}
            placeholder="PRCE_JIRA_TOKEN (없으면 미연결)"
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
        <button disabled={!ready}>Jira 연결 저장</button>
      </form>
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
