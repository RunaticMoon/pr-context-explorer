import React, { useEffect, useRef, useState } from "react";
export interface DesktopUpdateSnapshot {
  version: string;
  preferences: { autoCheck: boolean; autoDownload: boolean };
  publicUpdates: {
    enabled: boolean;
    channel: string;
    phase: string;
    version?: string;
    received?: number;
    total?: number;
    errorCode?: string;
    errorStage?: string;
    reason?: string;
    lastChecked?: string;
  };
}
export interface DesktopUpdateBridge {
  status(): Promise<DesktopUpdateSnapshot>;
  checkUpdate(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  cancelUpdate(): Promise<unknown>;
  installUpdate(): Promise<unknown>;
  updatePreferences(
    autoCheck: boolean,
    autoDownload: boolean,
  ): Promise<unknown>;
}
const labels: Record<string, string> = {
  idle: "확인 대기",
  checking: "업데이트 확인 중",
  available: "새 버전 있음",
  current: "최신 버전",
  downloading: "다운로드 중",
  downloaded: "설치 준비됨 · 분석이 끝나면 설치하세요",
  preparing: "검증 및 설치 준비 중",
  ready: "재시작 준비됨",
  cancelled: "취소됨",
  error: "업데이트 실패",
  unavailable: "사용 불가",
};
const PERMISSION_GUIDANCE =
  "앱 소유권과 설치 폴더 권한을 확인하세요. Finder로 사용자 소유의 ~/Applications에 설치한 뒤 재시도하세요. sudo나 권한 변경은 필요하지 않습니다.";
/** Exact transport codes only; compound install/helper codes must not be classified as network faults. */
const NETWORK_CODES = new Set([
  "NETWORK",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
]);
const TIMEOUT_CODES = new Set(["TIMEOUT", "ETIMEDOUT"]);
/** Maps the backend update step to its user-visible Korean label. */
export function updateStageLabel(stage?: string): string | undefined {
  switch (stage) {
    case "check":
      return "업데이트 확인 중";
    case "download":
      return "다운로드 중";
    case "prepare":
      return "설치 준비(검증) 중";
    case "install":
      return "설치 중";
    case "cancel":
      return "취소 처리 중";
    case "preferences":
      return "설정 저장 중";
    default:
      return undefined;
  }
}
/** Only well-formed, bounded uppercase codes are rendered; anything else collapses to UPDATE_FAILED. */
export function safeUpdateErrorCode(code?: string): string | undefined {
  if (!code) return undefined;
  return /^[A-Z][A-Z0-9_]{2,31}$/.test(code) ? code : "UPDATE_FAILED";
}
export function updateError(code: string) {
  if (code === "BUSY")
    return "진행 중인 수집·분석을 마친 뒤 다시 설치하세요. 분석은 취소되지 않았습니다.";
  if (code === "CANCELLED")
    return "업데이트가 취소되었습니다. 다시 확인할 수 있습니다.";
  if (code === "UNSAFE_DNS")
    return "DNS가 공개 GitHub 주소가 아닌 주소(사설·예약 대역)를 반환해 보안 정책상 차단했습니다. VPN·프록시의 fake-IP/가상 DNS 모드를 끄거나 github.com·api.github.com·release-assets.githubusercontent.com을 직접 연결(DIRECT)로 설정한 뒤 다시 시도하세요.";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "DNS_FAILED")
    return "DNS 조회에 실패했습니다. 인터넷 연결과 DNS·VPN 설정을 확인한 뒤 다시 시도하세요.";
  if (NETWORK_CODES.has(code))
    return "업데이트 서버에 연결하지 못했습니다. 연결 상태를 확인하고 다시 시도하세요.";
  if (TIMEOUT_CODES.has(code))
    return "업데이트 요청이 제한 시간을 초과했습니다. 잠시 후 다시 시도하세요.";
  if (code === "TLS_FAILED")
    return "보안 연결(인증서) 검증에 실패했습니다. 시스템 시간이 정확한지, 회사 네트워크의 TLS 검사나 보안 프로그램이 연결을 가로막지 않는지 확인한 뒤 다시 시도하세요.";
  if (code === "RATE_LIMITED")
    return "GitHub 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.";
  if (code === "HTTP_STATUS")
    return "GitHub 응답 오류로 업데이트하지 못했습니다. 잠시 후 다시 시도하세요.";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS")
    return PERMISSION_GUIDANCE;
  if (code === "ENOSPC" || code === "EDQUOT")
    return "저장 공간이 부족해 업데이트하지 못했습니다. 디스크 공간을 확보한 뒤 다시 시도하세요.";
  if (/PERMISSION|OWNER|ACL|UNSAFE|MODE|DIRECTORY|PATH/.test(code))
    return PERMISSION_GUIDANCE;
  if (/HASH|CHECKSUM|ZIP|SIGNATURE|MANIFEST|VERSION|INVALID/.test(code))
    return "검증에 실패했습니다. 설치하지 않았습니다. 다시 확인·다운로드하거나 공식 공개 배포를 확인하세요.";
  if (/LOCK|RECOVERY|HELPER|STARTUP|HANDOFF|EXIT/.test(code))
    return "안전한 설치를 완료하지 못했습니다. 기존 앱과 백업을 보존하세요. 잠금 파일을 임의로 지우지 말고 복구 안내를 확인하세요.";
  return "원인을 특정하지 못한 실패입니다. 다시 시도하고, 계속 실패하면 앱을 재시작하세요. 분석 데이터는 보존됩니다.";
}
/** Step + code header with the matching guidance, without echoing unvalidated strings. */
export function UpdateErrorNotice({
  code,
  stage,
}: {
  code?: string;
  stage?: string;
}) {
  const safe = safeUpdateErrorCode(code);
  if (!safe) return null;
  const label = updateStageLabel(stage);
  return (
    <p role="alert">
      <strong>
        {label ? `${label} 실패` : "업데이트 실패"} · <code>{safe}</code>
      </strong>
      <br />
      {updateError(safe)}
    </p>
  );
}
export function updateBytes(n?: number) {
  return n === undefined
    ? "—"
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KiB`
      : `${(n / 1048576).toFixed(1)} MiB`;
}
export function UpdatePanel() {
  const bridge = (window as Window & { prceDesktop?: DesktopUpdateBridge })
    .prceDesktop;
  const [snapshot, setSnapshot] = useState<DesktopUpdateSnapshot>();
  const [failed, setFailed] = useState(false),
    [acting, setActing] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await bridge?.status();
        if (!stopped) {
          setSnapshot(next);
          setFailed(false);
        }
      } catch {
        if (!stopped) setFailed(true);
      }
      if (!stopped && bridge) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      stopped = true;
      mounted.current = false;
      clearTimeout(timer);
    };
  }, [bridge]);
  const run = async (action: () => Promise<unknown>) => {
    setActing(true);
    try {
      await action();
      const next = await bridge!.status();
      if (mounted.current) {
        setSnapshot(next);
        setFailed(false);
      }
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      if (mounted.current) setActing(false);
    }
  };
  const s = snapshot?.publicUpdates,
    prefs = snapshot?.preferences;
  const enabled = !!s?.enabled && !failed;
  const busy =
    acting ||
    ["checking", "downloading", "preparing", "ready"].includes(s?.phase || "");
  return (
    <section className="update-panel">
      <h2>앱 업데이트</h2>
      <p>
        공개 배포 저장소 RunaticMoon/pr-context-explorer에서 익명으로
        확인합니다. gh·Python·GitHub PAT가 필요하지 않습니다.
      </p>
      <p className="muted">
        개인용 ad-hoc 배포는 Apple Developer ID 서명·공증을 제공하지 않습니다.
        다운로드 해시 및 앱 무결성을 검증하지만 Apple의 배포자 신뢰 인증은
        아닙니다. 앱과 포함된 Node·런타임만 교체합니다. 분석 데이터·설정은
        유지되며 Gatekeeper와 격리 속성은 해제하지 않습니다.
      </p>
      {!bridge ? (
        <p>
          브라우저에서는 업데이트를 실행할 수 없습니다. 설치된 macOS Apple
          Silicon 앱에서 열어 주세요.
        </p>
      ) : (
        <>
          <dl>
            <dt>설치 버전</dt>
            <dd>{snapshot?.version || "확인 중"}</dd>
            <dt>새 버전</dt>
            <dd>{s?.version || "—"}</dd>
            <dt>마지막 확인</dt>
            <dd>
              {s?.lastChecked
                ? new Date(s.lastChecked).toLocaleString()
                : "아직 확인하지 않음"}
            </dd>
          </dl>
          <p role="status">
            {failed
              ? "앱 상태를 읽을 수 없습니다. 재시작 후 다시 시도하세요."
              : labels[s?.phase || "idle"]}
          </p>
          {!s?.enabled && (
            <p>
              {s?.channel === "signed-private"
                ? "이 앱은 별도의 서명된 비공개 업데이트 채널을 사용합니다. 앱 메뉴에서 확인하세요."
                : s?.reason}
            </p>
          )}
          {s?.errorCode && (
            <UpdateErrorNotice code={s.errorCode} stage={s.errorStage} />
          )}
          {s?.total !== undefined && (
            <p>
              다운로드 {updateBytes(s.received)} / {updateBytes(s.total)}{" "}
              <progress value={s.received || 0} max={s.total || 1} />
            </p>
          )}
          <div className="update-actions">
            <button
              disabled={!enabled || busy}
              onClick={() => void run(() => bridge.checkUpdate())}
            >
              지금 확인
            </button>
            <button
              disabled={!enabled || busy || s?.phase !== "available"}
              onClick={() => void run(() => bridge.downloadUpdate())}
            >
              다운로드
            </button>
            <button
              disabled={
                !enabled ||
                !["checking", "downloading", "preparing"].includes(
                  s?.phase || "",
                )
              }
              onClick={() => void run(() => bridge.cancelUpdate())}
            >
              취소
            </button>
            <button
              disabled={!enabled || busy || s?.phase !== "downloaded"}
              onClick={() => void run(() => bridge.installUpdate())}
            >
              설치 및 재시작…
            </button>
          </div>
          <label>
            <input
              type="checkbox"
              checked={prefs?.autoCheck ?? true}
              disabled={!enabled || busy}
              onChange={(e) =>
                void run(() =>
                  bridge.updatePreferences(
                    e.target.checked,
                    prefs?.autoDownload ?? false,
                  ),
                )
              }
            />{" "}
            시작 시 및 6시간마다 자동 확인
          </label>
          <label>
            <input
              type="checkbox"
              checked={prefs?.autoDownload ?? false}
              disabled={!enabled || busy}
              onChange={(e) =>
                void run(() =>
                  bridge.updatePreferences(
                    prefs?.autoCheck ?? true,
                    e.target.checked,
                  ),
                )
              }
            />{" "}
            새 버전 자동 다운로드 (설치는 항상 직접 승인)
          </label>
        </>
      )}
    </section>
  );
}
