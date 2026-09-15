# 실제 검증 기록

## 부모 독립 재실행 및 소스 재현

0.3.0 최종 소스에서 `npm test` 276/276, build 성공, Chromium 12/12, 실제 공개 PR smoke를 별도로 재실행했다. 이어서 소스 ZIP을 새 디렉터리에 풀어 `npm ci`, build, 테스트 276/276, E2E 12/12를 확인했다. 상세 범위와 남은 경고/실계정 차단은 [SOURCE-DELIVERY.md](SOURCE-DELIVERY.md), 로그는 `artifacts/parent-release-*`와 `artifacts/clean-release-*`에 기록했다. 아래 통합·과거 기록은 각 시점 결과다.

## V3 최종 root 통합 검증 — 2026-09-14 UTC, 0.3.0

독립 V3 review-fixes 합류 후 실제 전체 명령을 재실행했다. 과거 숫자를 재사용하지 않았다.

- `npm test`: **276 tests, 276 pass, 0 fail/cancelled/skipped**; 78817.36615 ms. 기존 collector/core/AI/Jira/보안/V2 회귀, V3 모듈과 root 통합, 부모가 추가한 source-package 테스트를 포함한다. `artifacts/integration-final-unit.log`.
- `npm run build`: **tsc --noEmit + Vite 성공**, 2.88s. React Flow의 `use client` directive 무시 경고는 남는다. `artifacts/integration-final-build.log`.
- `npm run test:e2e`: **Chromium 12 passed (29.1s)**. 기존 Demo/V2/세션/한글 회귀를 유지하고, 실제 HTTP/session/CSRF/API/store/V3 orchestrator의 다중 chunk→통합→투어→Q&A(비동기+cache hit)→투어/reload/back/감사/취소/양쪽 근거/추가 부모 비교를 검증했다. Q&A 캐시만 만료/삭제되어도 유효한 PR 투어가 다시 열리고 오류를 별도로 표시하는 회귀도 포함한다. 모델 runner만 **명시 FAKE deterministic JSON**이며 실제 AI/의미 품질 성공이 아니다. `artifacts/integration-final-e2e.log`.
- root API 테스트: 전체 rich output/validationContext 재열기 검증, 선택 chunk 손상 재검증·단일 재실행, 전 단계 cache reuse/현재 전송 0, model/parser/prompt/schema/planner/adapter/PR본문/Jira hash/연결 계정 차원 무효화, invalid synthesis refs/insufficient/partial/cancel/no-browser-config/삭제를 검증했다. Jira hash 변경 fixture는 실제 Jira capture를 대신하지 않는다.
- `npm run smoke:public -- https://github.com/octocat/Hello-World/pull/1`: **실제 공개 unauthenticated HTTPS/API + Git fetch + 고정 재검사 성공**, 2047ms. snapshot `4e298e3cfaad170059f25ca1c4990ba2bc100223ed9407399ee931bdcfac6fe4`, PR commit 1개, README 확보/정적 언어 미지원으로 partial, 모델 전송 없음. `artifacts/integration-final-public.log`.
- `env -u PRCE_AI_CONFIG npm run probe:engines`: Codex **0.154.0**, Claude **2.1.270** 기능 탐지. 둘 다 auth `not_configured`, namespace/loopback **EPERM**, `ready=false`, `inferenceVerified=false`. `integration-final-probes.log`.
- `env -u PRCE_AI_CONFIG node_modules/.bin/tsx scripts/integration-guard.ts`: 기본 `executeAnalysis`가 V3→공식 AI adapter로 들어가 인증 없는 guard 조건에서 **all_chunks_failed로 거부**, 결과 생성/MockProvider 대체 없음. 이 음성 검증은 양성 production launcher/TLS/inference 증거가 아니다. `integration-final-guard.log`.
- 직접 확인한 최종 한글 캡처 `integration-final-v3-qa.png`, `integration-final-v3-evidence.png`: glyph 정상, source version/hash 및 revision ID 줄바꿈/패널 내 표시. E2E는 pageerror/외부 브라우저 요청 0을 검사했다. 긴 모델 설명은 긴 스크롤 패널이며 별도 주관적 품질 평가는 아니다.

추가 RED→GREEN: 실제 API가 V2 단일 호출로 남아 있던 실패, rich status 미렌더, source/hash clipping, 유효한 추가 부모 비교의 URL 거부, **collector old-first 저장 순서를 primary tour focus로 잘못 쓰던 old 선택**을 실제 테스트로 재현 후 수정했다. ordered focus[0]를 사용하므로 old 근거가 보조로 존재해도 기본 투어는 head/new에서 열린다. 로그는 `integration-final-*-red.log`에 남긴다.

실제 인증된 GH/GHE/Jira, 실제 모델 추론/설명 품질, namespace 허용 환경의 production launcher 양성 검증은 미수행이다. **macOS AI 어댑터는 미구현**, 사내 HTTPS proxy는 fail-closed다. 전역 독립 보안 승인/원본 전체 제품 수용 완료를 주장하지 않는다. 앱 루트는 Git 저장소가 아니므로 commit은 생성하지 않았다. 배포/방화벽/서비스를 변경하지 않았으며 source ZIP 전달 검증은 상위 담당자가 별도로 수행한다.

## Stage 2–5 core 통합 검증 (2026-09-14 UTC, 0.2.0)

현재 명령의 원본 stdout은 `artifacts/core-unit.log`, `core-build.log`, `core-e2e.log`, `core-public.log`, `core-probes.log`에 있습니다. 아래 Stage1 기록은 이전 baseline이며 현재 전체 결과와 구별합니다.

- `npm test`: **98 tests, 98 pass, 0 fail, 0 cancelled, 0 skipped**; 26579.869012 ms. GitHub/core/AI/Jira의 전체 병렬 구현 테스트를 함께 실행했습니다.
- `npm run build`: tsc --noEmit + Vite 성공; Vite 2.85s. React Flow `use client` 무시 경고는 남습니다.
- `npm run test:e2e`: **7 passed (12.9s)**. 기존 5개 + Live 연결/Jira 설정/URL 거부 + intercepted real-Git Live workspace/투어/범위/캐시/재실행 금지.
- `npm run smoke:public -- https://github.com/octocat/Hello-World/pull/1`: **실제 공개 HTTPS/API + Git fetch + tree/부모/diff/재검사 성공**, 1 PR commit, 2050ms, 모델 전송 없음. 최종 snapshot `583675a81736da8a4ec4f32ab7a7d0e1bb8614bad9f12834dd3afb222f0562de`. README 1개 확보, 정적 언어 미지원으로 partial. 인증 사용자/사내 시스템 검증이 아닙니다.
- 실제 별도 4393 서버에서 공개 PR 작업공간/README L1–6 탐색 성공. `artifacts/core-browser-check.json`: pageerror 0, 외부 브라우저 요청 0. `core-public-workspace.png` / `core-public-code.png` 캡처. Browser Use는 지원하지 않는 configured real profile 오류로 막혔으므로 이번 core 캡처의 직접 시각 판독은 수행하지 못했습니다. Playwright DOM/console/실제 navigation을 검증했습니다. 임시 서버 종료 후 4393 연결 거부를 확인했습니다.
- `npm run probe:engines`: 실제 project-local Codex 0.154.0 / Claude 2.1.270 기능 탐지; 인증 미설정, namespace/loopback EPERM, ready=false, inferenceVerified=false. 실제 AI inference는 실행하지 않았습니다.
- `npm audit --json`: 현재 root package dependency advisory **0**. 이것은 코드 전체 보안 감사가 아닙니다.

### 새 수직 RED→GREEN 근거

GitHub endpoint/URL 검증 → 인증 user/페이지/redirect/rate-limit → private durable store → DAG/tree/모든 부모/rename/delete/revert/coverage → metadata race 수집 → live source/output/범위 검증 → CSRF/API/asset → UI 연결 → Jira source bridge → 설정/캐시/선택 통합을 차례로 테스트하고 구현했습니다. 별도 behavioral RED는 누락 account/id 허용, 잘못된 API PR identity, credential reflection, root 비교 null, Git C-quoted hunk path 손상, 계정간 file ID 충돌, Jira normalized 원문 위조, head/base 없는 context, PR title 근거 누락, Live resume 미저장을 관찰했고 각각 GREEN을 확인했습니다. 테스트 transport/CLI/intercepted UI 결과는 명시적 fixture이며 live inference로 표시하지 않습니다.

별도 전문 어댑터 테스트/보안 근거는 AI/Jira 담당 문서를 참조하세요. 앱 루트에 .git이 없으므로 diff 기반 독립 리뷰/커밋은 하지 않았습니다. 상위 통합 담당자의 독립 review와 private-account smoke가 남습니다.

## Stage 1 이전 기록

## TDD 수직 슬라이스

실제 도구 실행에서 확인한 순서입니다. RED를 숨기거나 최종 결과로 합성하지 않았습니다.

| 슬라이스 | RED 관찰 | GREEN 관찰 |
|---|---|---|
| 실제 Git 수집 | `Git 수집기 구현 필요`, 0/1 통과 | baseline + 3 commits/tree/rename/delete/revert/AST 테스트 통과 |
| 계약/MockProvider | `검증기 구현 필요`, 1/2 통과 | 위조 snapshot/SHA/path/blob/side/range, 중요 주장 무근거, 없는 file/evidence, 투어 순환/중복 거부 |
| 보안 HTTP | `보안 서버 구현 필요`, 2/3 통과 | Host/Origin/세션/임의 파일 API 거부 통과 |
| 전체 UI | 빈 HTML에서 `연결 설정` heading 없음 | 실제 서버/Chromium으로 연결→PR→Graph→Phase→투어→코드/재열기/뒤로 통과 |
| URL/투어 그래프 | 잘못된 end 범위 미거부, 투어 그래프 없음 (2 실패) | 잘못된 범위 거부, old 삭제/rename ID/edge 단일 라인, 문맥 확장/다중 강조 통과 |
| 구조화 hunk | 파일별 hunk 위치 없음 | 실제 old/new SHA/path/start/count/text 보존 통과 |
| 코드 설명 | codeExplanations 없음 | old/new 별 역할/입출력/오류 근거 통과 |
| 코드 UI | code-explanation 영역 없음 | new ok:false와 old 정규화 없음/catch 없음 전환 통과 |
| 테스트 fixture | assert.deepEqual 소스 없음 | 실제 node:test assertion 소스 추가, **실행하지 않고** 수집 확인 |
| 쿠키 파서 | 경계 파서 없음 | 64자리 hex 외 입력 거부 통과 |
| 근거 품질 | 함수 설명이 import 한 줄만 인용 | 전체 파일 근거로 제한 후 통과 |
| 한국어 글꼴 | font-family에 Noto Sans KR 없음; 캡처에서 네모 glyph 발견 | 자체 호스팅 폰트, 외부 요청 0, 한국어 캡처 확인 |

Node fetch는 Host 헤더 override를 보존하지 않아 보안 테스트를 raw node:http 요청으로 수정했습니다. 서버 Host 검사를 약화하지 않았습니다. 최초 브라우저 도구는 지원 Chromium 기본 프로필이 없어 연결 불가였으나 Playwright 설치 Chromium을 실제로 실행해 E2E와 캡처를 확보했습니다.

최종 명령의 실제 표준 출력은 `artifacts/unit-integration.log`, `artifacts/build.log`, `artifacts/e2e.log`에 저장했습니다.

## Stage 1 당시 최종 검증

- `npm test`: 앱 단위/통합 7 passed, 0 failed.
- `npm run build`: TypeScript strict 검사 및 Vite 생산 빌드 성공. React Flow `use client` 무시 경고는 알려진 잔여 경고.
- `npm run test:e2e`: 실제 loopback 서버 + Chromium 5 passed.
- `npm run cache:clear` 후 `npm run fixture`: 실제 재생성, Git 총 커밋 4 (baseline 1 + PR 3).
- `curl http://127.0.0.1:4317/`: 실제 별도 실행 서버 HTTP 200 확인 후 종료.
- 캡처 `artifacts/tour.png`: 한국어 폰트 및 3패널/그래프/투어/코드 레이아웃 직접 확인.
- 대상 fixture 내부 테스트를 실행한 결과가 아닙니다. targetTestsExecuted / externalCIQueried 모두 false.

검증하지 않은 것: 실계정, CLI 인증/실행, 사내 서비스 호환, 자동 의미 감사, 부하/성능 상한, 복잡한 Git 이력. 부모 에이전트가 2026-09-14 UTC에 `npm test`(7 통과), `npm run build`(성공, 동일 경고), `npm run test:e2e`(Chromium 5 통과)를 독립 재실행했습니다. HTTP 경계 및 Git tree 수집 코드 일부와 한국어 UI 캡처를 확인했습니다. 전체 코드 보안 감사는 수행하지 않았습니다. 앱 루트는 Git 저장소가 아니므로 Git diff 기반 pre-commit 리뷰/커밋은 수행하지 않았습니다 (fixture Git 저장소와 구분).
