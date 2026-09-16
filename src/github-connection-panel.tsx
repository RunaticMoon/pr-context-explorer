import React, { useState } from "react";
import type { Connection } from "./server/github";
type API = (route: string, method?: string, body?: unknown) => Promise<any>;
export function GitHubConnectionPanel({
  api,
  ready,
  onConnected,
  webUrl: initialWebUrl = "https://github.com",
}: {
  api: API;
  ready: boolean;
  onConnected: (c: Connection) => Promise<void>;
  webUrl?: string;
}) {
  const [webUrl, setWebUrl] = useState(initialWebUrl),
    [token, setToken] = useState(""),
    [apiUrl, setApiUrl] = useState(""),
    [apiVersion, setApiVersion] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <section data-testid="github-simple-panel">
      <form
        autoComplete="off"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          const body = {
            webUrl,
            token,
            ...(apiUrl ? { apiUrl } : {}),
            ...(apiVersion ? { apiVersion } : {}),
          };
          setToken("");
          try {
            const result = await api("/api/connections/connect", "POST", body);
            await onConnected(result.connection);
          } catch {
            setError(
              "연결하지 못했습니다. Web URL, PAT 권한·만료, SSO 승인, VPN/CA 및 프록시 정책을 확인하세요.",
            );
          } finally {
            body.token = "";
            setBusy(false);
          }
        }}
      >
        <label>
          Web URL
          <input
            required
            type="url"
            value={webUrl}
            onChange={(e) => setWebUrl(e.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          Personal access token (PAT)
          <input
            required
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={busy}
          />
        </label>
        <p>
          토큰은 이 실행 세션의 서버 메모리에만 보관합니다 · 앱 종료 시 삭제.
          다시 시작하면 PAT를 다시 입력하세요. 브라우저 저장소나 설정 파일에
          저장하지 않습니다.
        </p>
        <details>
          <summary>고급 API 설정 (선택)</summary>
          <label>
            API base URL (자동 감지)
            <input
              type="url"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
            />
          </label>
          <label>
            API 버전 (기본 2022-11-28)
            <input
              placeholder="2022-11-28"
              value={apiVersion}
              onChange={(e) => setApiVersion(e.target.value)}
            />
          </label>
          <p>
            기본값은 문서화된 API 요청 버전이며 서버 호환성 보장은 아닙니다.
            HTTPS만 사용하며 호스트 간 리디렉션은 따르지 않습니다.
          </p>
        </details>
        <button className="primary" disabled={!ready || busy}>
          {busy ? "연결 확인 중…" : "연결 확인 및 저장"}
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
  );
}
export function GitHubVerifiedAccount({
  connection: c,
}: {
  connection?: Connection & { credentialState?: string };
}) {
  if (!c) return null;
  return (
    <section data-testid="github-verified-account">
      <p>
        계정: <strong>{c.account}</strong> ·{" "}
        {c.type === "github"
          ? "GitHub.com"
          : c.type === "ghe-cloud"
            ? "GitHub Enterprise Cloud"
            : "GitHub Enterprise Server"}
      </p>
      <p>
        Web: {c.webUrl} · API: {c.apiUrl} · 요청 API 버전: {c.apiVersion}
      </p>
      {c.type === "ghes" && (
        <p>
          GHES 서버 버전: {c.serverVersion || "알 수 없음 (서버 응답에 없음)"}
        </p>
      )}
      <p>
        {c.auth.kind === "session"
          ? c.credentialState === "session"
            ? "PAT 사용 가능 · 앱 종료 시 삭제"
            : "PAT 재입력 필요 · 이전 실행 세션 종료"
          : "기존 외부 인증 설정 · 사용자 확인 버튼으로 검증"}
      </p>
    </section>
  );
}
