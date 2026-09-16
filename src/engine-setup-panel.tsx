import React, { useEffect, useRef, useState } from "react";
import type { EngineSetupStatus } from "./server/engine-setup.ts";
import type { ProviderId } from "./server/ai/events.ts";
export interface EngineSetupPanelProps {
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  ready: boolean;
  active?: boolean;
  providerId: ProviderId;
  onProviderChange: (id: ProviderId) => void;
  onStatus?: (status: EngineSetupStatus) => void;
}
export function EngineSetupPanel({
  api,
  ready,
  active = true,
  providerId,
  onProviderChange,
  onStatus,
}: EngineSetupPanelProps) {
  const [status, setStatus] = useState<EngineSetupStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const apiRef = useRef(api),
    statusRef = useRef(onStatus);
  apiRef.current = api;
  statusRef.current = onStatus;
  const generation = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!active)
      panelRef.current
        ?.querySelectorAll<HTMLInputElement>('input[type="password"]')
        .forEach((input) => {
          input.value = "";
        });
  }, [active, providerId]);
  async function load(body?: object) {
    const current = ++generation.current;
    setBusy(true);
    setError(false);
    setStatus(undefined);
    // Invalidate parent readiness immediately, including failed token rotations.
    statusRef.current?.({ engines: [] });
    try {
      const next = await apiRef.current<EngineSetupStatus>(
        "/api/engines/setup",
        body
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          : undefined,
      );
      if (current === generation.current) {
        setStatus(next);
        statusRef.current?.(next);
      }
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (ready) void load();
    return () => {
      generation.current++;
    };
  }, [ready]);
  return (
    <section
      ref={panelRef}
      className="engine-setup"
      aria-label="로컬 AI 엔진 설정"
    >
      <header>
        <h3>로컬 AI 엔진</h3>
        <button
          type="button"
          disabled={!ready || busy}
          onClick={() => void load({ action: "rescan" })}
        >
          {busy ? "검색 중…" : "다시 검색"}
        </button>
      </header>
      <p>
        설치된 Codex · Claude를 자동으로 찾습니다. 검색과 선택만으로 분석하지
        않습니다.
      </p>
      <p>
        로컬 CLI도 오프라인 AI가 아닙니다. 분석을 시작하면 선택한 계정으로
        코드와 문맥이 OpenAI 또는 Anthropic에 전송되며 요금이 발생할 수
        있습니다.
      </p>
      {error && (
        <p role="alert">
          엔진 상태를 확인하지 못했습니다. 연결을 확인하고 다시 검색하세요.
        </p>
      )}
      {!status && !error && (
        <p role="status">
          {ready ? "설치 상태 확인 중…" : "서버 연결을 기다립니다."}
        </p>
      )}
      {status?.engines.map((engine) => (
        <article key={engine.providerId}>
          <label>
            <input
              type="radio"
              name="local-engine"
              value={engine.providerId}
              checked={providerId === engine.providerId}
              disabled={busy}
              onChange={() => onProviderChange(engine.providerId)}
            />
            {engine.providerId === "codex" ? "Codex" : "Claude Code"}
          </label>
          <p className={engine.ready ? "engine-state" : "engine-state warning"}>
            {engine.ready
              ? "준비됨 · 모델 호출 미검증"
              : !engine.installed
                ? "설치 필요 · 공식 CLI를 설치한 뒤 다시 검색하세요."
                : !engine.isolation.available ||
                    !engine.isolation.runtimeVerified
                  ? "격리 실행 불가 · 안전한 실행 환경이 필요합니다."
                  : !engine.capabilities.supported
                    ? "호환성 확인 필요 · 지원되는 CLI 버전을 확인하세요."
                    : "인증 확인 필요 · 아래 인증 설정을 확인하세요."}
          </p>
          {providerId === engine.providerId && (
            <div className="engine-selected">
              <details>
                <summary>상세 진단 · 설치 / 호환성 / 격리 / 인증</summary>
                <dl>
                  <dt>설치</dt>
                  <dd>
                    {engine.installed ? "감지됨" : "지원하는 설치를 찾지 못함"}
                  </dd>
                  <dt>버전</dt>
                  <dd>{engine.cliVersion ?? "확인되지 않음"}</dd>
                  <dt>안전 기능 호환성</dt>
                  <dd>
                    {engine.capabilities.supported
                      ? "확인됨"
                      : `지원되지 않음 (${engine.capabilities.missing.join(", ")})`}
                  </dd>
                  <dt>격리 실행</dt>
                  <dd>
                    {engine.isolation.available &&
                    engine.isolation.runtimeVerified
                      ? "확인됨"
                      : `사용 불가 (${engine.isolation.blocker ?? "미검증"})`}
                  </dd>
                  <dt>인증</dt>
                  <dd>
                    {engine.authentication.status === "authenticated"
                      ? "격리된 CLI 인증 확인됨 (서버 권한·결제는 미검증)"
                      : engine.localAuth === "available"
                        ? "로컬 인증 파일 발견 · 재사용 동의 필요"
                        : engine.localAuth === "unsupported"
                          ? "Claude 로그인 / Keychain 자동 재사용은 지원하지 않습니다. 공식 setup token을 선택적으로 입력하세요."
                          : engine.localAuth === "session"
                            ? "세션 토큰 등록됨 · 인증 확인 필요 · 앱 종료 시 삭제"
                            : engine.localAuth === "reused"
                              ? "재사용 동의됨 · 인증 확인 필요"
                              : engine.localAuth === "advanced"
                                ? "서버 고급 인증 설정 · 상태 확인 필요"
                                : "로컬 인증 파일 없음. 터미널에서 codex login 후 다시 검색하세요."}
                  </dd>
                </dl>
              </details>
              {engine.providerId === "claude" &&
                engine.installed &&
                engine.localAuth !== "advanced" && (
                  <form
                    autoComplete="off"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const input = event.currentTarget.elements.namedItem(
                        "setupToken",
                      ) as HTMLInputElement;
                      const token = input.value;
                      input.value = "";
                      void load({
                        action: "set-session-auth",
                        providerId: "claude",
                        candidateId: engine.candidateId,
                        token,
                      });
                    }}
                  >
                    <p>
                      터미널에서 <code>claude setup-token</code>을 직접 실행해
                      발급한 공식 토큰을 입력하세요. 자동 로그인이나 Keychain
                      읽기는 하지 않습니다.
                    </p>
                    <a
                      href="https://code.claude.com/docs/en/authentication"
                      target="_blank"
                      rel="noreferrer"
                    >
                      공식 인증 안내
                    </a>
                    <label>
                      Claude setup token
                      <input
                        name="setupToken"
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={32768}
                        required
                        disabled={busy || !engine.candidateId}
                      />
                    </label>
                    <button
                      type="submit"
                      disabled={busy || !engine.candidateId}
                    >
                      이번 세션에 토큰 사용
                    </button>
                    <p>
                      앱 종료 시 삭제 · 브라우저 저장소 및 영구 설정에 저장하지
                      않습니다.
                    </p>
                    {engine.localAuth === "session" && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void load({
                            action: "forget-session-auth",
                            providerId: "claude",
                            candidateId: engine.candidateId,
                          })
                        }
                      >
                        세션 토큰 삭제
                      </button>
                    )}
                  </form>
                )}
              {engine.localAuth === "available" && (
                <button
                  type="button"
                  disabled={busy || !engine.candidateId}
                  onClick={() =>
                    void load({
                      action: "reuse-auth",
                      providerId: engine.providerId,
                      candidateId: engine.candidateId,
                    })
                  }
                >
                  기존 Codex 로그인 재사용에 동의
                </button>
              )}
              <p>
                {engine.ready
                  ? "분석 준비됨 · 실제 모델 호출은 아직 검증하지 않았습니다."
                  : "분석 불가 · 설치, 호환성, 격리 및 인증 조건을 확인하세요."}
              </p>
              {!engine.installed && (
                <a
                  href={
                    engine.providerId === "codex"
                      ? "https://developers.openai.com/codex/cli/"
                      : "https://code.claude.com/docs/en/setup"
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  공식 설치 안내
                </a>
              )}
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
