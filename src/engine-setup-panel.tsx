import React, { useEffect, useRef, useState } from "react";
import type { EngineSetupStatus } from "./server/engine-setup.ts";
import type { HttpEngineView, ProviderId } from "./ai-contract.ts";
import {
  HttpEngineSetupForm,
  type HttpEngineDraft,
} from "./http-engine-setup-form.tsx";

// CONTRACT (conductor-owned): GET/POST `/api/engines/setup` additionally
// carries an optional `http` view and the configure/verify/forget actions
// below. API keys travel only inside the serialized request body — never in
// state, props, storage, the URL, or logs — and raw server error text is
// never shown.
type EngineSetupHttpStatus = EngineSetupStatus & {
  http?: HttpEngineView | null;
};
export type HttpActionResult =
  { ok: true; view: HttpEngineView | null } | { ok: false; text: string };
type HttpSetupPost = (
  serializedBody: string,
) => Promise<{ http?: HttpEngineView | null }>;

export function buildConfigureHttpBody(
  draft: HttpEngineDraft,
  view: HttpEngineView | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    action: "configure-http",
    providerId: "openai-compatible",
    baseUrl: draft.baseUrl.trim(),
    model: draft.model.trim(),
  };
  // Present only when the user typed a key; an empty field means "keep the
  // stored key" on an unchanged endpoint and is never sent.
  if (draft.apiKey !== "") body.apiKey = draft.apiKey;
  if (view !== null) {
    body.configId = view.configId;
    body.expectedRevision = view.revision;
  }
  return body;
}

/** Extracts a sanitized failure code only; arbitrary messages are ignored so
 * raw server text can never reach the screen. */
export function httpFailureCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return code;
  const body = (error as { body?: unknown }).body;
  if (typeof body === "object" && body !== null) {
    const bodyCode = (body as { code?: unknown }).code;
    if (typeof bodyCode === "string") return bodyCode;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /^[a-z_]+$/.test(message)
    ? message
    : undefined;
}

export function httpSetupErrorText(
  action: "configure" | "verify" | "forget",
  code: string | undefined,
): string {
  if (code === "invalid_request")
    return "입력값 또는 설정 버전이 맞지 않습니다. 새로고침 후 다시 시도하세요";
  if (action === "configure")
    return code === "auth_required"
      ? "엔드포인트를 바꾸면 API 키를 다시 입력해야 합니다"
      : "설정을 저장하지 못했습니다";
  return action === "verify"
    ? "연결 확인을 완료하지 못했습니다"
    : "키를 삭제하지 못했습니다";
}

/** C7: a verify response that lands after the committed revision moved on is
 * stale and must be discarded entirely, including failure details. */
export function isStaleHttpVerify(
  requestRevision: number,
  current: HttpEngineView | null,
): boolean {
  return current === null || current.revision !== requestRevision;
}

async function postHttpAction(
  post: HttpSetupPost,
  action: "verify" | "forget",
  body: Record<string, unknown>,
): Promise<HttpActionResult> {
  try {
    const res = await post(JSON.stringify(body));
    return { ok: true, view: res.http ?? null };
  } catch (error) {
    return {
      ok: false,
      text: httpSetupErrorText(action, httpFailureCode(error)),
    };
  }
}

export async function configureHttpEngine(
  post: HttpSetupPost,
  view: HttpEngineView | null,
  draft: HttpEngineDraft,
): Promise<HttpActionResult> {
  const body = buildConfigureHttpBody(draft, view);
  // Serialize first, then drop the local reference so the key exists only in
  // the request payload (and the form-owned draft) for the rest of the call.
  const serialized = JSON.stringify(body);
  delete body.apiKey;
  try {
    const res = await post(serialized);
    return { ok: true, view: res.http ?? null };
  } catch (error) {
    return {
      ok: false,
      text: httpSetupErrorText("configure", httpFailureCode(error)),
    };
  }
}

export async function verifyHttpEngine(
  post: HttpSetupPost,
  request: { configId: string; revision: number },
  currentView: () => HttpEngineView | null,
): Promise<HttpActionResult | "stale"> {
  const result = await postHttpAction(post, "verify", {
    action: "verify-http",
    configId: request.configId,
    revision: request.revision,
    consent: true,
  });
  if (isStaleHttpVerify(request.revision, currentView())) return "stale";
  return result;
}

export async function forgetHttpEngine(
  post: HttpSetupPost,
  request: { configId: string; revision: number },
): Promise<HttpActionResult> {
  return postHttpAction(post, "forget", {
    action: "forget-http",
    configId: request.configId,
    revision: request.revision,
  });
}

export interface EngineSetupPanelProps {
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  ready: boolean;
  active?: boolean;
  providerId: ProviderId;
  /** Method syntax on purpose: callers may pass a handler typed for only the
   * local provider ids, which a wider property signature would reject under
   * strictFunctionTypes. */
  onProviderChange(id: ProviderId): void;
  onStatus?: (status: EngineSetupStatus) => void;
  /** Latest public view of the "openai-compatible" engine (null = not
   * configured); published on load, on each setup action, and projected as
   * not-ready while a draft edit is unsaved. */
  onHttpView?(view: HttpEngineView | null): void;
}
export function EngineSetupPanel({
  api,
  ready,
  active = true,
  providerId,
  onProviderChange,
  onStatus,
  onHttpView,
}: EngineSetupPanelProps) {
  const [status, setStatus] = useState<EngineSetupStatus>();
  const [httpView, setHttpView] = useState<HttpEngineView | null>(null);
  const [httpError, setHttpError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const apiRef = useRef(api),
    statusRef = useRef(onStatus),
    httpNotifyRef = useRef(onHttpView),
    httpViewRef = useRef<HttpEngineView | null>(null);
  apiRef.current = api;
  statusRef.current = onStatus;
  httpNotifyRef.current = onHttpView;
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
  function publishHttpView(next: HttpEngineView | null) {
    httpViewRef.current = next;
    setHttpView(next);
    httpNotifyRef.current?.(next);
  }
  function postHttpSetup(serialized: string) {
    return apiRef.current<{ http?: HttpEngineView | null }>(
      "/api/engines/setup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serialized,
      },
    );
  }
  async function configureHttp(draft: HttpEngineDraft): Promise<boolean> {
    const current = ++generation.current;
    setBusy(true);
    setHttpError(undefined);
    const result = await configureHttpEngine(
      postHttpSetup,
      httpViewRef.current,
      draft,
    );
    if (current !== generation.current) return false;
    setBusy(false);
    if (result.ok) {
      publishHttpView(result.view);
      return true;
    }
    setHttpError(result.text);
    return false;
  }
  function verifyHttp(): void {
    const view = httpViewRef.current;
    if (view === null) return;
    const { configId, revision } = view;
    const current = ++generation.current;
    setBusy(true);
    setHttpError(undefined);
    void verifyHttpEngine(
      postHttpSetup,
      { configId, revision },
      () => httpViewRef.current,
    ).then((result) => {
      if (current !== generation.current) return;
      setBusy(false);
      if (result === "stale") return;
      if (result.ok) publishHttpView(result.view);
      else setHttpError(result.text);
    });
  }
  function forgetHttp(): void {
    const view = httpViewRef.current;
    if (view === null) return;
    const { configId, revision } = view;
    const current = ++generation.current;
    setBusy(true);
    setHttpError(undefined);
    void forgetHttpEngine(postHttpSetup, { configId, revision }).then(
      (result) => {
        if (current !== generation.current) return;
        setBusy(false);
        if (result.ok) publishHttpView(result.view);
        else setHttpError(result.text);
      },
    );
  }
  // An unsaved draft edit immediately invalidates upstream run readiness and
  // consent: the committed view is projected as not-ready until the next
  // successful configure/verify publishes the server's view again.
  function invalidateHttpView(): void {
    const view = httpViewRef.current;
    publishHttpView(view === null ? null : { ...view, ready: false });
  }
  async function load(body?: object) {
    const current = ++generation.current;
    setBusy(true);
    setError(false);
    setStatus(undefined);
    // Invalidate parent readiness immediately, including failed token rotations.
    statusRef.current?.({ engines: [] });
    const committed = httpViewRef.current;
    if (committed !== null) publishHttpView({ ...committed, ready: false });
    try {
      const next = await apiRef.current<EngineSetupHttpStatus>(
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
        if ("http" in next) publishHttpView(next.http ?? null);
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
      <article>
        <label>
          <input
            type="radio"
            name="local-engine"
            value="openai-compatible"
            checked={providerId === "openai-compatible"}
            disabled={busy}
            onChange={() => onProviderChange("openai-compatible")}
          />
          OpenAI 호환 API
        </label>
        <p
          className={httpView?.ready ? "engine-state" : "engine-state warning"}
        >
          {httpView === null
            ? "설정 필요 · 엔드포인트·모델·API 키를 등록하세요."
            : httpView.ready
              ? "준비됨 · 연결 확인됨"
              : "준비 안 됨 · 아래 설정과 연결 확인을 완료하세요."}
        </p>
        {providerId === "openai-compatible" && (
          <div className="engine-selected">
            <HttpEngineSetupForm
              view={httpView}
              busy={busy}
              onConfigure={configureHttp}
              onVerify={verifyHttp}
              onForget={forgetHttp}
              onInvalidate={invalidateHttpView}
            />
            {httpError && <p role="alert">{httpError}</p>}
          </div>
        )}
      </article>
    </section>
  );
}
