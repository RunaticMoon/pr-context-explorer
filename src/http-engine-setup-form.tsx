import React, { useState } from "react";
import type { HttpEngineView } from "./ai-contract.ts";
import { MODEL_ID_PATTERN } from "./commit-review.ts";

// CONTRACT (conductor-owned): pure presentational form for the
// openai-compatible HTTP engine. The API key lives only in this component's
// local state and is cleared right after a successful configure call; it is
// never lifted to parent state, storage, or the URL.
export type HttpEngineDraft = {
  baseUrl: string;
  model: string;
  apiKey: string;
};

const API_KEY_MAX_BYTES = 8192;
const API_KEY_FORBIDDEN = /[\p{Cc}\s]/u;

function parseBaseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function validateHttpDraft(
  d: HttpEngineDraft,
  view: HttpEngineView | null,
): string[] {
  const errors: string[] = [];
  const trimmed = d.baseUrl.trim();
  const url = trimmed ? parseBaseUrl(trimmed) : null;
  if (!trimmed) errors.push("Base URL을 입력하세요");
  else if (!url || (url.protocol !== "http:" && url.protocol !== "https:"))
    errors.push("Base URL은 http:// 또는 https:// 절대 URL이어야 합니다");
  else {
    if (url.username !== "" || url.password !== "")
      errors.push("Base URL에 사용자 이름·비밀번호를 포함할 수 없습니다");
    if (url.search !== "")
      errors.push("Base URL에 쿼리 문자열을 포함할 수 없습니다");
    if (url.hash !== "")
      errors.push("Base URL에 프래그먼트(#)를 포함할 수 없습니다");
  }
  if (!d.model.trim()) errors.push("모델 ID를 입력하세요");
  else if (!MODEL_ID_PATTERN.test(d.model.trim()))
    errors.push(
      "모델 ID 형식이 올바르지 않습니다 (영문·숫자·-_.:/ 1–120자, 공백 불가)",
    );
  const endpointChanged =
    view !== null && url !== null && url.host !== view.host;
  const keepsStoredKey =
    view !== null && view.hasApiKey && url !== null && !endpointChanged;
  if (!keepsStoredKey && d.apiKey === "")
    errors.push(
      endpointChanged
        ? "엔드포인트가 변경되었습니다 · API 키를 다시 입력하세요"
        : "API 키를 입력하세요",
    );
  if (d.apiKey !== "") {
    if (API_KEY_FORBIDDEN.test(d.apiKey))
      errors.push("API 키에 공백이나 제어 문자를 포함할 수 없습니다");
    if (new TextEncoder().encode(d.apiKey).length > API_KEY_MAX_BYTES)
      errors.push("API 키는 최대 8KiB까지 허용됩니다");
  }
  return errors;
}

export function httpDraftWarning(d: HttpEngineDraft): string | null {
  const url = parseBaseUrl(d.baseUrl.trim());
  return url !== null && url.protocol === "http:"
    ? "암호화되지 않은 연결입니다 · API 키가 평문으로 전송될 수 있습니다"
    : null;
}

const VERIFICATION_TEXT: Record<HttpEngineView["verification"], string> = {
  not_checked: "연결 확인 전",
  checking: "연결 확인 중…",
  verified: "연결 확인됨",
  failed: "연결 확인 실패",
};

const BLOCKER_TEXT: Record<string, string> = {
  auth_required: "API 키가 등록되지 않았습니다",
  auth_invalid: "등록된 API 키가 거부되었거나 만료되었습니다",
  invalid_request: "엔진 설정이 완전하지 않습니다",
  provider_unavailable: "제공자에 연결할 수 없습니다",
  provider_failed: "제공자 요청이 실패했습니다",
  model_unavailable: "선택한 모델을 사용할 수 없습니다",
  quota_exceeded: "제공자 과금·할당량 한도에 도달했습니다",
  rate_limited: "제공자 요청 한도에 도달했습니다",
  timeout: "연결 확인 시간을 초과했습니다",
  network_denied: "네트워크 정책이 이 대상을 거부했습니다",
  cancelled: "작업이 취소되었습니다",
};

export function HttpEngineSetupForm(props: {
  view: HttpEngineView | null;
  busy: boolean;
  onConfigure(draft: HttpEngineDraft): Promise<boolean>;
  onVerify(): void;
  onForget(): void;
  onInvalidate(): void;
}): React.ReactElement {
  const { view, busy, onConfigure, onVerify, onForget, onInvalidate } = props;
  const [draft, setDraft] = useState<HttpEngineDraft>(() => ({
    baseUrl: "",
    model: view?.model ?? "",
    apiKey: "",
  }));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const errors = validateHttpDraft(draft, view);
  const warning = httpDraftWarning(draft);
  const disabled = busy || saving;

  function update(patch: Partial<HttpEngineDraft>) {
    setTouched(true);
    setDraft((d) => ({ ...d, ...patch }));
    onInvalidate();
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);
    if (errors.length > 0 || disabled) return;
    setSaving(true);
    try {
      if (await onConfigure(draft)) setDraft((d) => ({ ...d, apiKey: "" }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="http-engine-setup" aria-label="OpenAI 호환 API 설정">
      <h3>OpenAI 호환 API</h3>
      <p className="muted">
        OpenAI 호환 /chat/completions 제공자의 주소·모델·키를 직접 등록합니다.
        저장 버튼을 누르기 전까지 서버로 아무것도 전송하지 않습니다.
      </p>
      {view && (
        <p className="http-engine-state">
          {view.host} · 모델 {view.model} ·{" "}
          {view.hasApiKey ? "등록됨 ••••" : "키 미등록"} ·{" "}
          {VERIFICATION_TEXT[view.verification]} ·{" "}
          {view.ready ? "준비됨" : "준비 안 됨"}
        </p>
      )}
      {view !== null && view.blockers.length > 0 && (
        <ul className="http-engine-blockers" aria-label="엔진 준비 차단 이유">
          {view.blockers.map((code) => (
            <li key={code} data-code={code}>
              {BLOCKER_TEXT[code] ?? "엔진 준비를 완료하지 못했습니다"}
            </li>
          ))}
        </ul>
      )}
      <form autoComplete="off" onSubmit={(e) => void submit(e)}>
        <div>
          <label>
            Base URL
            <input
              type="url"
              value={draft.baseUrl}
              placeholder="https://api.example.com/v1"
              autoComplete="off"
              spellCheck={false}
              required
              disabled={disabled}
              aria-describedby="http-engine-url-help"
              onChange={(e) => update({ baseUrl: e.target.value })}
            />
          </label>
          <small id="http-engine-url-help" className="muted">
            끝에 /chat/completions가 붙습니다
          </small>
          {warning !== null && (
            <p className="http-engine-warning" role="status">
              {warning}
            </p>
          )}
        </div>
        <div>
          <label>
            모델 ID
            <input
              value={draft.model}
              placeholder="제공자의 정확한 모델 ID"
              autoComplete="off"
              spellCheck={false}
              required
              disabled={disabled}
              aria-describedby="http-engine-model-help"
              onChange={(e) => update({ model: e.target.value })}
            />
          </label>
          <small id="http-engine-model-help" className="muted">
            영문·숫자·-_.:/ 1–120자
          </small>
        </div>
        <div>
          <label>
            API 키{view?.hasApiKey ? " (교체할 때만 입력)" : ""}
            <input
              type="password"
              value={draft.apiKey}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              aria-describedby="http-engine-key-help"
              onChange={(e) => update({ apiKey: e.target.value })}
            />
          </label>
          {view?.hasApiKey && (
            <p className="http-engine-key-state">등록됨 ••••</p>
          )}
          <small id="http-engine-key-help" className="muted">
            {view?.hasApiKey
              ? "비워 두면 같은 엔드포인트에서 등록된 키를 유지합니다 · 엔드포인트를 바꾸면 새 키가 필요합니다"
              : "저장 성공 직후 이 입력에서 지워집니다 · 브라우저 저장소에 보관하지 않습니다"}
          </small>
        </div>
        {touched && errors.length > 0 && (
          <ul className="http-engine-errors" role="alert" aria-label="입력 오류">
            {errors.map((message, i) => (
              <li key={i}>{message}</li>
            ))}
          </ul>
        )}
        <button
          type="submit"
          className="primary"
          disabled={disabled || errors.length > 0}
        >
          저장
        </button>
      </form>
      <div className="http-engine-actions">
        <button
          type="button"
          disabled={!view?.hasApiKey || disabled}
          onClick={onVerify}
          aria-describedby="http-engine-verify-help"
        >
          연결 확인
        </button>
        <small id="http-engine-verify-help" className="muted">
          연결 확인은 작은 요청 1건(최대 4회 시도)을 보냅니다
        </small>
        <button
          type="button"
          disabled={!view?.hasApiKey || disabled}
          onClick={onForget}
        >
          키 삭제
        </button>
      </div>
    </section>
  );
}
