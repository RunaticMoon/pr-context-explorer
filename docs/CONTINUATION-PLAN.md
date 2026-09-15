# Stage 2–5 구현·검증 계획

2026-09-14 UTC. 사용자 요청: 1단계 이후 완성까지 계속. 현재 개발 경계는 로컬 개발 디렉터리이며 공개 배포·기존 서비스 변경을 포함하지 않는다.

## 병렬 소유권

- GitHub/Git·통합 담당: 기존 src/server/{git,contract,provider,http,...}.ts, src/main.tsx, src/style.css, 프로젝트 설정·공통 문서 및 integration tests. `src/server/ai/`, `src/server/jira/`는 수정하지 않는다.
- AI 담당: `src/server/ai/`, `tests/ai*.test.ts`, `docs/AI-ADAPTERS.md`, `artifacts/ai-*`만 소유. 독립 API는 아래와 같다. 기존 provider.ts는 통합 담당이 연결한다.
- Jira 담당: `src/server/jira/`, `tests/jira*.test.ts`, `docs/JIRA-ADAPTERS.md`, `artifacts/jira-*`만 소유. 기존 fixture Jira 타입은 통합 담당이 정리한다.

## AI 통합 계약

`src/server/ai/index.ts`에서 공개. 구체 타입은 담당자가 정의하고 문서화하되 외부 앱 모델에 의존하지 않는다.
- `probeProviders(config?)`: 설치/버전/인증/기능/격리 가능 여부와 blocker를 반환. 인증 확인 불가를 성공으로 표시하지 않는다.
- `runAnalysis(request)`: providerId(codex|claude), model, schema(object), context(unknown), trustedPrompt(string), signal?, onEvent? 및 로컬 실행 설정을 받는다. `{output:unknown, metadata:{providerId, model, cliVersion,...}}` 반환. 모델 출력 schema는 호출자가 제공하고 앱 참조 검증은 통합 계층이 수행한다.
- 실제 CLI executable + args 배열, stdin, bounded events/timeout/cancel/process tree cleanup, 명시적 no-fallback.
- 분석 대상 cwd/config를 실행 컨텍스트에 넣지 않는다. OS 격리 검증 없으면 실행을 fail-closed. 서비스 토큰 환경을 넘기지 않는다. 설정에 임의 shell command 허용 금지.

## Jira 통합 계약

`src/server/jira/index.ts`에서 공개.
- 후보 탐색: PR title/body, branch, commit subject/body, explicit links를 입력으로 받고 host+key로 dedupe하며 출처 보존. 설정 가능한 프로젝트 호스트 매핑·패턴.
- Cloud / Data Center adapters, 명시 등록 HTTPS endpoint, no redirects, read-only issue fetch. Custom acceptance criteria field mapping, raw+normalized, hash/fetchedAt/updatedAt.
- missing/unconnected/unknown_or_forbidden/communication_error를 구별. credential resolve는 서버의 provider callback 또는 명시 env 이름; 브라우저로 토큰을 반환하지 않음.
- 후보 제외/수동 연결은 통합 UI/로컬 상태가 담당.

## 실행 순서와 완료 판정

1. 각 담당은 제공된 references master/stages/output contract를 읽고 TDD 수직 슬라이스로 실제 코드를 완성한다.
2. GitHub 실제 HTTPS GET 어댑터 및 앱 전용 bare Git 캐시; snapshot 고정, 모든 커밋 부모/tree, 비교 정책, caps/partial/force-push, unsupported coverage.
3. UI에서 실제 연결→내 PR/URL→snapshot→선택 CLI 분석→검증된 설명/투어/근거 이동 연결. Jira 없이도 진행.
4. 기존 1단계 E2E 유지 + 실제 어댑터를 fake HTTP/CLI와 통합한 오류/보안 E2E. Fake runner 검증은 실엔진 결과와 구별.
5. 독립 검토, 반복 수정, 전체 테스트/빌드/브라우저 검증. 실계정 smoke는 사용자 인증·정책·PR 선택 필요.

## Core 통합 결과 (2026-09-14 후속)

Core의 구현/검증/미검증 표는 `CORE-STATUS.md`, 최신 테스트 stdout/actual public smoke는 `TEST-RESULTS.md`와 `artifacts/core-*.log`에 있습니다. 0.2.0은 Demo와 Live를 분리하여 실제 GitHub/Git/Jira/AI 모듈 호출 경로를 제공하며, 전체 98 unit/integration 및 7 Chromium E2E가 통과했습니다. 실제 공개 GitHub PR 수집/브라우저 탐색은 성공했습니다. 현재 native CLI는 project-local로 기능 탐지되지만 인증 미설정/namespace EPERM으로 실제 AI inference는 차단·미검증입니다. 초기 환경 기록은 아래에 역사적으로 보존합니다.

## 초기 환경 제약

확인: Linux, Node 24.20.0, npm 11.19.0, git 2.43.0. gh/codex/claude/bwrap 미설치, standalone Codex/GitHub CLI 인증 파일 없음. 다른 서비스/Hermes의 자격증명을 가져오거나 재사용하지 않는다. 조직 호스트·계정은 추측하지 않는다. OS sandbox 부재를 unsafe 옵션으로 우회하지 않는다. macOS 실행 검증은 별도 장치 필요.
