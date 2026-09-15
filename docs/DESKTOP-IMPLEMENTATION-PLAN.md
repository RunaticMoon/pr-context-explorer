# Apple Silicon 데스크톱 구현 계약

기준: 사용자 요청 macOS Apple Silicon 설치 앱 + 자동 업데이트. 기존 private GitHub 저장소와 로컬 우선/read-only 대상 분석 경계를 유지한다. 기본 배포는 Electron `.app`/DMG, Homebrew/npm는 보조 설치 진입점이다. npm public publish나 소스/릴리스 공개 전환을 하지 않는다.

## 사용자 확인에 따른 기본 경로 변경

사용자는 Apple Developer Program/Developer ID 인증서가 없다고 확인했다. 따라서 기본은 개인용 unsigned/ad-hoc arm64 앱 + private GitHub 릴리스의 외부 설치·업데이트 관리자다. 서명된 Electron/Squirrel 자동 업데이트는 선택적인 미래 경로로 남기며, 미서명 앱에서 활성화하지 않는다.

배포 담당의 `prce` 도구가 `install/check/update`와 명시적 opt-in per-user launchAgent 자동 확인/업데이트를 제공한다. 실행 중 앱은 교체하지 않고 다음 종료 상태까지 미루며, user Applications 아래 atomic 교체/복구와 Application Support 데이터 보존을 검증한다. 사용자 본인의 GitHub read 인증으로 정확한 private repository/tag/asset을 확인하고 checksum/파일 구조/크기 검사를 한다. checksum 검사를 Apple 서명/공증 보증으로 부르지 않는다. Gatekeeper 전역 해제, quarantine 속성 제거, 임의 privileged install은 금지한다. 첫 실행은 사용자가 macOS에서 별도 승인해야 할 수 있다.

Unsigned personal 릴리스는 수동 승인된 CI 산출물만 private GitHub Release에 올릴 수 있다. signed production update feed와 구분하며 Apple secret 부재로 개인용 빌드 전체를 막지 않는다. 실제 schedule은 사용자의 Mac에서 opt-in할 때만 등록한다.

## 소유권

1. Electron 통합 담당: `desktop/**`, build configuration, root package/lock/scripts, 기존 UI/server의 패키징에 필요한 통합 변경, `tests/desktop*.test.ts`, `tests/e2e/desktop*`, docs/DESKTOP.md. `src/server/ai/**`와 `.github/workflows/**`, `distribution/**`는 수정하지 않는다.
2. macOS AI 담당: `src/server/ai/**`, `tests/ai-macos*.test.ts`, docs/MACOS-ISOLATION.md. 기존 Linux guard를 유지하면서 Darwin 분기/공식 CLI 탐지/실제 sandbox probe/실행을 구현한다. 다른 루트/패키지/데스크톱 파일은 수정하지 않는다.
3. 배포 담당: `.github/workflows/**`, `distribution/**`, `tests/distribution*.test.ts`, docs/MACOS-RELEASE.md. 빌드·서명·공증·릴리스 자동화를 담당하며 main/ai 소스·루트 package는 수정하지 않는다.

## 데스크톱 원칙

- Electron BrowserWindow: contextIsolation, sandbox, nodeIntegration=false, 좁은 preload/IPC, sender 검증, 외부 navigation/new-window/webview/permission 요청 차단. source가 임의 IPC/shell/filesystem에 접근하지 못하게 한다.
- 기존 backend는 app-owned loopback 서버로 시작하고 정확한 origin/세션/CSRF를 유지한다. 사용자 설정/캐시는 macOS Application Support 아래, app bundle/asar는 읽기 전용으로 취급한다. 종료 시 작업과 자식 서버를 정상 종료하며 single instance.
- bundling은 tsx/소스 checkout/개발 node_modules를 요구하지 않는 실제 앱 산출물을 만들어야 한다. 필요하면 checksum 확인한 공식 Node ARM64 sidecar를 포함해 Electron의 process.execPath를 Node라고 가정하지 않는다. Git/선택 AI CLI 등 사용자 설치 의존성은 탐지/설정 경로를 제공한다.
- 자동 업데이트는 서명한 패키지에서만 허용하며 unsigned 개발 빌드는 상태를 명시하고 설치를 거부한다. publisher token은 앱/renderer/config manifest에 내장하지 않는다. 업데이트용 사용자 read-only 인증은 main-only OS 보호 저장소/승인된 gh 또는 credential 파일로 취급하고 AI/backend 환경과 분리한다.
- auto-check/download, 진행률/오류, 재시작 적용 승인, 중복 실행/취소/복구, version/channel/downgrade/signature 체크를 검증한다. 업데이트 오류로 사용 중 데이터나 앱을 지우지 않는다.

## macOS AI 원칙

Electron화는 Linux bwrap를 대체하지 않는다. Darwin용 OS 강제 경계를 별도 구현하고 실제 probe를 통과해야 실행한다. sandbox-exec/Seatbelt를 사용한다면 지원 여부/프로필/파일·네트워크/서브프로세스 제한을 실제 macOS에서 검증한다. 제거·미지원 시 fail-closed. target checkout/home 전체를 읽기 허용하지 않는다. SourceBundle은 stdin, 깨끗한 임시 HOME/cwd, source credentials 미상속, 공식 CLI 설정 자동 로드 제한 유지. Linux에서는 Mac 프로필 생성 테스트를 Mac 실행 검증으로 부르지 않는다.

## 배포/검증 공통 명령 계약

루트 통합 담당이 제공할 명령:
- `npm run desktop:build`: 웹 및 패키징 가능한 desktop/backend JS 빌드.
- `npm run desktop:pack:mac`: Darwin arm64 앱 디렉터리 빌드 (서명 없는 검증용 허용).
- `npm run desktop:dist:mac`: Darwin arm64 DMG/ZIP 산출, publish 기본 never.
- `npm run test:desktop`: 데스크톱 수명주기/IPC/updater 경계 테스트.
- 일반 `npm test`, `npm run build`, `npm run test:e2e`는 기존 0.3 회귀 보존.

배포는 `macos-15` arm64 hosted runner가 공식적으로 존재함을 확인했고 워크플로에서 `uname -m`을 assert한다. 서명 없는 CI는 private Actions artifact만 만들고 production update feed에 publish하지 않는다. Signed/notarized 릴리스는 보호된 수동 release 절차와 Apple Developer 인증서/공증 secret을 필요로 한다. 두 경로 모두 검사/테스트 실제 결과를 보존한다.

## 외부 설정 게이트

- Apple Developer ID 인증서 및 공증 인증은 사용자 소유이며 추측/차용하지 않는다.
- 기존 GitHub PAT는 Contents push가 확인됐지만 Workflows/Actions 권한은 아직 미확인. 거부되면 필요한 최소 권한을 안내한다.
- private hosted Actions는 계정 제공 분량/과금 정책을 따르므로 무료라고 보장하지 않는다. 임의 예산/계정 설정 변경 금지.
- Mac 앱 런칭/실제 업데이트는 Mac runner/장치에서 실제 실행을 확인한 범위만 완료로 표시한다. 서명·실계정이 없으면 unsigned build/runtime 및 negative updater 검증과 구분한다.
