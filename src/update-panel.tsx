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
export function updateError(code: string) {
  if (code === "BUSY")
    return "진행 중인 수집·분석을 마친 뒤 다시 설치하세요. 분석은 취소되지 않았습니다.";
  if (/PERMISSION|OWNER|ACL|UNSAFE|MODE|DIRECTORY|PATH/.test(code))
    return "앱 소유권과 설치 폴더 권한을 확인하세요. Finder로 사용자 소유의 ~/Applications에 설치한 뒤 재시도하세요. sudo나 권한 변경은 필요하지 않습니다.";
  if (/HASH|CHECKSUM|ZIP|SIGNATURE|MANIFEST|VERSION|INVALID/.test(code))
    return "검증에 실패했습니다. 설치하지 않았습니다. 다시 확인·다운로드하거나 공식 공개 배포를 확인하세요.";
  if (/LOCK|RECOVERY|HELPER|STARTUP|HANDOFF/.test(code))
    return "안전한 설치를 완료하지 못했습니다. 기존 앱과 백업을 보존하세요. 잠금 파일을 임의로 지우지 말고 복구 안내를 확인하세요.";
  if (code === "CANCELLED")
    return "업데이트가 취소되었습니다. 다시 확인할 수 있습니다.";
  return "연결 상태를 확인하고 다시 시도하세요. 계속 실패하면 앱을 재시작하세요. 분석 데이터는 보존됩니다.";
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
            <p role="alert">
              {updateError(s.errorCode)} <code>{s.errorCode}</code>
            </p>
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
