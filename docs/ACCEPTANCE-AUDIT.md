# 제품 수용 기준 감사 — 0.2.0 원본 / 0.3 통합 보완

## 0.3.0 통합 보완 기록 (원본 읽기 전용 감사와 구별)

아래 원본 감사는 당시 0.2 소스의 발견을 보존한 역사 기록이다. 현재 상태/새 실행 증거는 [RELEASE-0.3.md](RELEASE-0.3.md), [TEST-RESULTS.md](TEST-RESULTS.md) 및 `artifacts/integration-final-*`가 우선한다.

상위 5개 중 1–4의 V3 실행/전체 grounded payload/선택 의미 감사/기본 head 투어·StoryEdge/분할 캐시/분석 상태는 **실제 Live API와 UI에 연결**했다. 단순 라이브러리 존재가 아니라 실제 HTTP·Git·store·orchestrator·Chromium으로 검증하며 runner만 명시 FAKE JSON이다. 수집 우선순위(5)는 별도 collector 수정과 회귀 테스트가 함께 통과해야 한다. SHA/side/range, 원문 양쪽 근거, 이전 PR 투어와 별도 코드 Q&A 보존, 자동 모델 재실행 금지, 전체 output/validationContext 재검증이 통합 게이트다.

이는 실제 계정 인증, 실제 모델 설명 품질, semantic global correctness, 사내 프록시/SSO/macOS 구현, 모든 후속 수용 항목을 완료했다는 의미가 아니다. 아래 §13 외부 게이트 및 상위 5개 외의 심볼 색인/fork 엔티티/복잡한 Git·대형 pack 등의 범위는 별도 보존한다. 독립 V3 재감사 수정은 `V3-REVIEW-FIXES.md` 참조.

## 원본 0.2 감사

## 판정과 감사 범위

**현재 판정: 실제 연동 경로와 탐색기는 구현되어 있으나, 원본 요구사항 전체 완료는 아니다. 계정만 연결하면 끝나는 상태도 아니다.** 의미 설명 계약, 대형 PR 분석, 기본 투어 계약, 분석 상태 표시, 관련 문맥 수집에 계정 없이 고칠 수 있는 구현 공백이 남아 있다.

- 기준: `references/pr-context-reviewer-prompts/01-project-master.md` 전체 §1–14, `02-implementation-stages.md`, 원본 `docs/OUTPUT-CONTRACT.md` 및 `runtime/01`–`05`. 현재 README와 `docs/CORE-STATUS.md`의 한계를 그대로 재분류하지 않고 아래 실제 구현/테스트 소스를 대조했다.
- 감사 대상은 `package.json`의 **0.2.0 작업 디렉터리 소스**다. 앱 루트에 `.git`이 없어 기준 commit SHA를 제시할 수 없다. 동시 수정 중인 작업 디렉터리이므로 아래 줄 번호는 읽은 시점의 보조 위치이며 **파일·함수·필드 이름이 주 식별자**다.
- **읽기 전용 소스 감사**다. 앱·대상 저장소·테스트·CLI·외부 API를 실행하지 않았고 인증정보도 조회하지 않았다. 산출물은 이 문서뿐이다.
- `docs/TEST-RESULTS.md:3–19`와 `CORE-STATUS.md`에는 기존 98개 단위/통합 테스트, Chromium 7개, 빌드, 공개 GitHub smoke 성공이 기록되어 있다. 이것은 **이전 실행 기록**이며 이번 감사 또는 동시 수정 이후의 새 실행 결과가 아니다. 테스트 제목만으로 범위를 확대하지 않고 실제 assertion과 구현을 확인했다.
- 병행 담당 범위인 세션 bootstrap 경쟁, rename 후 경로 재사용, 직렬화 Context 누락/AST edge 전달, scoped Q&A 상태, escaped credential reflection, reserved IP, unknown CLI event, auth mode, ADF shape 수정은 **새 발견이나 아래 우선순위에 포함하지 않는다**. 이 문서는 그 수정의 완료·회귀 통과를 인증하지 않는다.
- 주관적 화면 미감·배치 취향·디자인 개선은 평가하지 않는다. 데이터 상태가 숨겨지거나 잘못된 revision/주장으로 보일 가능성은 기능 수용 기준이므로 평가한다.

### 상태 범례

| 표기 | 의미 |
|---|---|
| **구현·fixture 기록** | 실행 경로와 해당 assertion이 소스에 있고 기존 실행 기록이 있다. 표에 적힌 범위에서만 구현 완료로 분류하며 이번 재실행 또는 실계정 검증을 뜻하지 않는다. |
| **외부 미검증** | 실행 경로는 있으나 승인된 계정·조직 설정·실제 엔진/지원 환경에서 검증이 필요하다. 코드가 없다는 뜻은 아니다. |
| **구현 미완** | 요구 동작 또는 강제 계약/렌더링이 실제 소스에 없다. 인증정보 제공만으로 해결되지 않는다. |
| **추가 fixture 필요** | 정책/코드는 있으나 해당 경계 사례의 assertion 또는 실행 근거가 부족하다. 외부 계정 없이 보완 가능하다. |
| **선택·비필수** | 원문이 제안한 기술이나 선택 기능, 혹은 명시적으로 축소 가능한 지원 범위다. 그것의 부재 자체를 필수 미완으로 세지 않는다. |

## 원본 마스터 전체 수용 행렬

| 원본 절 | 요구 범위 | 판정 | 소스/테스트 근거와 남은 경계 |
|---|---|---|---|
| §1 제품 목적 | 배경·의도·전략·커밋 변화·읽기 순서·Jira·원문/코드 불일치 설명 | **구현 미완 + 외부 미검증** | 탐색/설명 UI는 있다. `live-analysis.ts`의 일반 `statements`는 문제/명시 의도/추론 의도/전략/변화 묶음/불일치의 구분과 존재를 보장하지 않는다. 실제 모델의 설명 품질도 미검증. 우선순위 1–3. |
| §2 기본 범위 | 로컬 개인용·한국어·원문 보존·읽기 전용·명시 엔진·전송 동의·안전한 실행 거부 | **구현·fixture 기록 + 외부 미검증** | `live.tsx`, `github.ts`, `source-bridge.ts`, `ai/index.ts`; 실제 모드에 mock 자동 대체 없음. fixture 원문·한국어 글꼴 E2E 있음. 로컬 CLI가 외부 모델에 전송한다는 안내/동의 있음. 실제 추론 가능성은 별도 외부 조건. macOS 지원으로 확대 해석 금지. |
| §3 연결 | github.com/GHE Cloud/GHES, Web/API/버전/계정, gh/env 어댑터 | **구현·fixture 기록 + 외부 미검증** | `github.ts:validateConnection/verify`, `transport.ts:resolveCredential`; `github.test.ts`, `live-api.test.ts`, `e2e/live.spec.ts`. 실사용 gh 활성 계정, GHES 버전/SSO는 미검증. |
| §3 네트워크 | VPN/프록시/CA/SSO 안내, TLS 유지 | **부분 구현 + 조건부 구현 미완** | `transport.ts:httpsGet`, `ingest.ts:fetchObjects`, `source-bridge.ts:captureForSnapshot`은 HTTPS 프록시를 명시적으로 거부한다. 이는 **프록시 구현 부재**이지 인증 후 검증만 남은 것이 아니다. 직접/VPN 및 추가 CA 경로는 있고 사내 환경 확인 필요. SSO/네트워크 세부 원인을 항상 구별하는 진단은 아님. |
| §3 PR 목록 | 내 작성 PR 기본, 리뷰 요청, 필터, URL, 페이지/상한/partial | **구현·fixture 기록 + 외부 미검증** | `github.ts:GitHubClient.list/pages/parsePullURL`, `live.tsx` 목록; `/user`로 작성자 기준 결정. 공개 URL smoke는 **인증된 내 PR 목록**의 완료 증거가 아니다. |
| §3 수집 메타데이터 | PR/커밋 원문, 저장소·브랜치·SHA, 코드, 경쟁 조건 | **부분 구현·fixture 기록** | `ingest.ts`, `live-git.ts`; 제목/본문/작성자/URL/브랜치/SHA와 Git 메시지 보존, 수집 전후 fingerprint 비교 있음. **base/head 저장소 별도 엔티티/식별자 보존은 미완**: fork의 `head.repo.full_name`을 fetch/fingerprint에는 쓰지만 `collectGit` 입력 및 저장 `LiveSnapshot`에는 head 저장소를 남기지 않는다. 전체 GitHub raw JSON 저장 자체가 필수라는 뜻은 아님. |
| §4 Jira 수집 | 후보 출처·동일 키 다중 호스트·수동/제외·Cloud/DC·필드 매핑·원문/정규화/시점/실패 상태 | **구현·fixture 기록 + 외부 미검증** | `jira/*`, `source-bridge.ts`, `source-ui.tsx`; `jira-discovery.test.ts`, `jira-capture.test.ts`, `integration-sources.test.ts`. 현재 수집 시점과 커밋 당시를 구별하며 PR-only 가능. 실제 조직 필드/인증/권한은 미검증. 병행 ADF 수정은 별도 승인 필요. |
| §4 Jira 요구 추적 | 요구↔커밋↔파일↔코드 다대다, 다섯 상태, 없는 수용 기준 생성 금지 | **부분 구현·fixture 기록 + 구현 미완** | `RequirementMapping`의 배열과 다섯 상태, Jira/code ref 존재 검사 및 UI는 있다. 그러나 requirement ID는 모든 `sourceKind:jira`를 허용하고 제목/설명/명시 AC의 역할을 강제하는 별도 요구 엔티티가 없다. 매핑 설명의 주장 종류/근거 지지와 양쪽 충돌 근거 검사도 미완. 우선순위 1. |
| §4 선택 수집 | 필요한 댓글·상위/관련 이슈를 제한된 범위로 선택 | **어댑터 구현·core UI 미연결 / 선택 기능** | `jira/optional.ts` 및 어댑터 범위는 있으나 `captureForSnapshot`은 core UI의 optional scope를 전달하지 않는다. 필수 기본 이슈 연동 부재로 계산하지 않되, 제품 UI에서 선택 수집 가능하다고 표시하면 안 된다. |
| §5A Graph/Evolution | 실제 Phase/tree, 파일 노드·변화·rename·삭제·revert·검색/문맥·정적/추정/story 구분 | **부분 구현·fixture 기록 + 구현 미완** | `live-git.ts`, `live.tsx:LiveWorkspace`; 실제 DAG/tree/부모 diff, 별도 Baseline, 안정적인 ID 기반 좌표, 검색/집중/확대/범례/근거 이동 있음. 정적 edge는 제한된 AST import뿐. AI 추정 edge/story edge의 별도 모델·검증·표시는 없음. 문맥 확장은 직접 이웃만이 아니라 전체 확보 tree 파일을 노출한다. 우선순위 3, 5. |
| §5B Guided Flow | 개발 순서와 독립된 추천 순서·이유·고정 head 기본·과거 예외·다중 파일/구간·이어보기 | **부분 구현·fixture 기록 + 구현 미완** | Step 배열, why/previous/next/beforeAfter/question/prerequisites, 다중 file/evidence, 이전/다음/읽음/진행/복원 있음. Mock fixture는 head 고정이며 Live E2E도 그 결과를 사용한다. **실제 Live 검증기는 임의의 유효 Phase 투어를 허용**하고 tourId/tourRevisionSha/storyEdges가 없다. 우선순위 3. |
| §5C Code Explorer | 파일/함수/블록, 역할·입출력·동작·오류·부작용·전후/주변 구분·Q&A·근거 이동 | **부분 구현·fixture 기록 + 구현 미완 + 외부 미검증** | old/new 코드·선택 범위 질문·실행 동의·캐시·정확한 SHA/path/side/range는 있다. 구조화된 심볼 목록/함수 선택, 변경 구간과 기존 문맥 설명의 구분, 관계·전후·Jira·후속 읽기 payload는 축소되어 있다. `CodeExplanation`은 하나의 evidence와 `kind:observed`를 모든 설명에 강제한다. 사용자가 수동으로 함수 범위를 선택할 수는 있다. 우선순위 1, 2, 5. |
| §5 공통 선택 | snapshot/commit/comparison/file/side/range/tour/step, 모드/back/reload 일관성 | **부분 구현·fixture 기록** | `live.tsx` URL 상태, `e2e/live-workspace.spec.ts`의 head 투어/phase/back/reload/무단 모델 재호출 금지. tourId는 없고 읽음 key는 snapshot뿐. 병행 scoped Q&A 및 세션 수정 범위는 이 판정으로 승인하지 않음. |
| §6 Git 정확성 | merge-base 순변경/실제 부모/결정적 DAG/tree/root/shallow/fork/rename/delete/revert/partial | **구현·fixture 기록 + 추가 fixture 필요** | `live-git.ts:collectGit/compareGit`, `tests/live-git.test.ts`, `hunks.test.ts`, `ingest.test.ts`. root empty-tree·두 부모 merge·rename/delete/revert·큰 파일·binary·미지원 언어·shallow assertion 있음. criss-cross 복수 merge-base, 동일 blob 다중 rename 후보, 거대 pack/많은 Phase는 별도 충분한 검증 필요. `ingest.test.ts` 제목의 force-push와 달리 직접 mutation assertion은 body-only race이므로 모든 rebase/fork 시나리오를 검증했다고 보지 않는다. |
| §6 수집 범위 | 실제 커밋 Phase 보존, 모든 파일 상세 분석을 보장하지 않음 | **정책 구현·fixture 기록 + 구현 미완** | Phase metadata는 유지하되 상세 tree 상한, 파일/총량 제한으로 partial. 상한 그 자체는 허용되는 제한이지만 현재 tree-order 예산은 PR 변경 코드보다 무관한 파일을 먼저 읽을 수 있다. 우선순위 5. 선택 로컬 worktree 연결 기능은 없으며 임의 사용자 저장소를 자동 읽지 않는 현재 방식은 필수 위반이 아님. |
| §7 파이프라인/도메인 | 결정적 수집→bounded Context→구조화 분석→참조 검증→렌더/cache, 중요한 모든 진술 분류 | **부분 구현·fixture 기록 + 구현 미완** | `live-analysis.ts:Scope/buildContext/trustedPrompt/executeAnalysis`는 PR 또는 선택 코드 작업 한 번을 실행한다. JSON Schema/근거 검증은 실제 코드이며 자유 장문 하나를 파싱하는 UI는 아니다. 그러나 작업별 분석 역할, GroundedStatement 전면 적용, StoryEdge/의미 감사 모델은 미완. 우선순위 1–3. |
| §8 로컬 CLI 계층 | 탐지/버전/인증/구조화 event·결과/timeout/cancel/오류/격리/no fallback | **구현·fixture 기록 + 외부 미검증** | `ai/index.ts`, `cli.ts`, `events.ts`, `runner.ts`, `sandbox.ts` 및 `ai-*.test.ts`. 실제 CLI probe 기록과 실제 inference는 별개. 승인 인증 미설정·Linux namespace EPERM은 현재 외부 검증 blocker. 출력 parser 경계 병행 수정은 별도 테스트 필요. |
| §9 보안/데이터 경계 | 수집기/AI 분리, source는 비신뢰 데이터, loopback/session/CSRF, 원격 read-only, private cache | **구현·fixture 기록 / 독립 보안 승인 별도** | `http.ts`, `transport.ts`, `ingest.ts`, `ai/*`, `store.ts` 및 경계 테스트. 대상 install/test/build 실행 안 함, 기본 telemetry/공유 없음. 이 감사는 병행 보안 결함을 재발견하거나 전체 안전성을 인증하지 않는다. |
| §10 캐시·성능 | 범위/모델/버전/소스별 무효화, on-demand 재사용, 대형 PR 분할/통합 | **부분 구현·fixture 기록 + 구현 미완** | `live-api.ts:/api/live/run`, `store.ts`; key에 connection/account/repo/PR/base/head/PR metadata/Jira/scope/provider/model/prompt/schema/TS parser/snapshot 있음. 일치 결과 재사용·만료·삭제는 구현. **검증된 commit/file/symbol 요약을 재사용하는 chunk→merge pipeline은 없음**. 정확한 입력 모델 ID와 CLI/관측 모델 metadata를 보존하는 것과 새 모델 버전/프롬프트 내용에 대한 재사용 정책은 구분해야 함. 우선순위 2. |
| §10 Coverage·상태·품질 | discovered/retrieved/analyzed/omitted/unavailable, 실행/분석/검증 별도, 테스트 읽기/CI/실행 구분 | **부분 구현·fixture 기록 + 구현 미완** | Git Coverage와 테스트/CI false 표시는 구현. 그러나 `analyzed`는 지원 확장자 head 파일 수이지 모델 분석 완료 수가 아니다. `insufficient_context` job이 succeeded로 합쳐지고 UI가 analysisStatus/missingContext를 별도로 렌더하지 않는다. 실행 성공과 분석 충분성의 분리 필요. 우선순위 4. |
| §11 초기 기술안/화면 | React/TS/local backend/Graph/Code/JSON Schema/저장/테스트, 세 화면 | **구현·fixture 기록 / 기술 선택은 비필수** | `package.json`, `main.tsx`, `live.tsx`, `store.ts`, `contract.ts`. Monaco·SQLite는 초기 제안이므로 자체 old/new viewer·atomic JSON 채택 자체는 결함이 아니다. UI 색상·스타일은 감사 제외. |
| §12 단계별 구현 | 실행되는 작은 기능으로 1→5 완성, mock을 실연동으로 보고하지 않기 | **1단계 구현·fixture 기록 / 2–4 부분 / 5 미완** | 공개 GitHub·Jira/CLI 어댑터·Live 탐색 실제 코드가 있음. 하지만 계약/분할/투어/품질 공백 및 실계정/inference 검증이 남아 Stage 2–5 전체 완료로 표시할 수 없다. |
| §13 완료 조건 | 아래 완료 체크리스트 전체 | **미완** | 소스 구현 완료와 실제 사용자 경로 검증을 합쳐 판정해야 함. |
| §14 최초 수행/보고 | 문서·실제 Git fixture 기반 초기 경험·설정 검증·정직한 인계 | **구현·fixture 기록** | PRODUCT/ARCHITECTURE/OUTPUT-CONTRACT/계획/보안/검증 문서, 실제 baseline+3 commit fixture와 MockProvider, README 실행법 존재. 최초 Stage 1 납품과 현재 전체 제품 수용은 다른 범위다. |

### §13 최종 완료 조건별 판정

| 원문 완료 조건 | 현재 수용 판정 |
|---|---|
| 인증된 GitHub/GHES 사용자의 PR을 찾아 열기 | 코드·fixture는 있으나 **실계정 외부 미검증**. 공개 URL만으로 대체할 수 없음. |
| PR/커밋/Jira 원문과 출처 표시 | **기본 경로 구현·fixture 기록**. 실제 Jira 접근은 외부 미검증, 요구/추론 의미 구분은 미완. |
| 선택한 실제 Codex/Claude 분석 실행 | 어댑터 존재, **현재 환경에서 실제 inference 차단·미검증**. |
| 각 커밋 Phase의 파일/관계/diff 정확성 | **지원 범위 구현·fixture 기록**. 큰 이력/복잡한 rename·merge의 추가 fixture와 관련 코드 수정 승인 필요. |
| 파일명과 독립된 읽기 순서 및 이유 | **Mock fixture에서 검증 기록**, 실제 기본 head 투어 계약/생성·품질은 미완/미검증. |
| 투어·그래프·코드가 동일 snapshot 지칭 | **기본 fixture 기록**, Live tourId/head 정책 미완 및 병행 상태 수정 검증 별도. |
| 주요 설명·관계의 정확 revision 근거 확인 | **위치 검증 구현**, 모든 중요 진술의 근거 분류 및 의미적 지지 확인/실패 표시는 미완. |
| Jira 미연결/API 제한/누락/엔진 오류/미지원 언어 구분 | **다수 경로 구현·fixture 기록**, 분석 insufficient_context/missingContext 표시 미완. |
| 대상 코드 및 원격 PR/Jira를 수정하지 않음 | **읽기 전용 설계·fixture 기록**. 이 감사가 독립 보안 승인이나 모든 실제 조직 정책 준수를 보증하지는 않음. |
| 대표 fixture·자동화 테스트·설치/연결/실행/문제해결 문서 | **존재·기존 실행 기록 확인**. 최종 수정본 재실행 및 빠진 수용 fixture가 필요. |

## 우선 구현할 코드 수정 — 상위 5개

아래는 보안 병행 수정과 별개의 **필수 제품 동작 공백**이다. 계정/네트워크 권한을 기다리지 않고 fixture와 주입형 실행기로 구현·검증할 수 있다. 번호는 권장 구현 순서이며 보안 취약점 심각도 번호가 아니다.

### 1. 모든 중요한 설명의 GroundedStatement와 원문/추론/불일치·의미 점검 계약

**근거:** `src/server/contract.ts:3–35,64–109`, `live-analysis.ts:RequirementMapping/LiveOutput/validateLiveOutput`, `live.tsx`의 requirement/step/code 설명 렌더. 원본 §1·§4·§5C·§7, 원본 출력 계약 §3–5, 구현 단계 5의 “실재하지만 주장과 무관한 근거” 검사.

**현재 공백:** 일반 statements에는 observed/inferred/unknown·confidence·근거 검사가 있으나, Step의 why/previous/beforeAfter, CodeExplanation의 role/behavior/errors 등은 독립 문자열이다. CodeExplanation은 `kind:observed`만 허용하며 하나의 evidenceId를 여러 중요한 주장에 공유한다. RequirementMapping도 설명은 문자열이고 Jira source라는 조건만 검사한다. 위치가 실재하는 근거 하나로 관련 없는 동작·작성자 의도·수용 기준을 서술해도 이 구조는 표현상 반박하거나 unknown으로 내릴 수 없다. `semanticAudit`는 실행 결과에서 항상 `not_performed`; discrepancy와 양쪽 원문/코드 근거를 담는 명시적 payload/화면이 없다.

**수정 hook:**
- `contract.ts`에 공통 GroundedStatement 스키마/검증기를 만들고 코드 동작, 전후 차이, 매핑 설명, 투어의 사실 주장까지 적용한다. 질문/일반 읽기 제안은 사실 주장과 구별한다.
- `live-analysis.ts`에서 PR의 statedIntent/inferredIntent, phase 요약, discrepancies(양쪽 source/code refs), requirement의 출처 역할(`explicit_acceptance_criteria`, 원문에서 추출한 요구, 해석 제안)을 표현한다. 제목/설명이라는 이유만으로 **명시 AC**로 승격하지 않도록 한다. 원본의 다섯 payload 역할을 충족하는 판별 가능한 계약 또는 동등한 구조가 필요하며, 파일을 정확히 다섯 개로 나누는 것 자체가 목표는 아니다.
- 결정적 위치 검사와 semantic audit를 분리한다. `targetJsonPointer/category/reason/evidenceIds/action` 및 `unableToVerify`를 저장/표시하고 `reject/downgrade/needs_context`를 처리한다. **모든 답변에 두 번째 LLM 호출을 강제하라는 뜻은 아니다**. 선택적 점검이나 사람의 점검으로도 의미 실패를 남길 수 있어야 하며, 검사하지 않았으면 미수행이다.

**필요 테스트:** 각 설명 필드에서 근거 없는 observed/inferred 거부, unknown+limitation 허용, inferred 이유 요구, 제목/설명을 AC로 둔갑시키는 출력, PR 원문과 코드 충돌의 양쪽 ref, 실제 라인을 가리키지만 무관한 주장에 의미 실패/보류 표시. 정상적인 “테스트를 실행하지 않아 통과 여부 모름”은 유지하고 테스트 파일 존재를 실행 성공으로 바꾸지 않는 fixture. 실제 엔진의 품질 평가만 외부 단계다.

### 2. 대형 PR의 단계별 분할→검증→통합과 재사용 가능한 요약 캐시

**근거:** `live-analysis.ts:Scope/buildContext/trustedPrompt/executeAnalysis`, `live-api.ts:/api/live/run`, `store.ts`, `ai/index.ts:runAnalysis`. 원본 §7의 단일 장문 의존 금지, §10의 큰 PR commit/file/symbol 분할·통합 및 요약 재사용.

**현재 공백:** PR 실행은 baseline/여러 Phase의 관련 파일 old/new를 하나의 Context에 모아 `runAnalysis`를 **한 번** 호출한다. 출력은 실제 bounded JSON Schema이므로 “자유로운 거대 장문 UI”라고 부르는 것은 부정확하다. 하지만 입력 상한에서 제외하거나 요청을 거부할 뿐, chunk별 분석/검증 후 통합하는 경로는 없다. `Scope`도 pr/code뿐이며 `trustedPrompt`는 runtime 01 또는 04만 선택한다. 02/03/05 파일이 존재한다고 단계 실행이 구현된 것은 아니다. 같은 scope 결과 캐시는 있지만 검증된 개별 파일/커밋 요약을 PR 통합과 on-demand 설명이 공유하지 않는다.

**수정 hook:**
- Core에 작업 계획/분할기와 단계별 결과 manifest를 둔다. 예: Phase/file/symbol 분석 → 각 결과 결정적 검증 → PR 통합 → head tour. 작은 PR은 단일 structured 작업이 가능해도 **큰 PR은 조용한 잘림이 아닌 다단계 처리**여야 한다.
- 각 chunk의 원문 EvidenceRef·누락·parser 범위와 이전/현재 revision을 유지한다. 통합 요약은 원문을 대체하지 않으며, 새 주장에 원문 refs가 다시 필요하다. 실패한 일부 chunk는 전체 성공으로 합치지 않는다.
- `live-api.ts`/`store.ts`에 chunk/task 유형·파일 blob/범위·문맥 dependency hash·모델 ID·프롬프트/스키마/파서/계획 버전별 캐시를 둔다. 실행 metadata의 실제 CLI 버전/관측 모델과 요청 모델 ID를 계속 분리한다. 움직이는 모델 alias의 버전을 확인할 수 없으면 고정 버전이라고 주장하지 말고 명시 새 실행/만료 정책을 둔다.
- 현 key는 이미 모델·프롬프트 문자열 버전·스키마·TS 버전을 포함한다. **기존 캐시 전체가 무효라는 결론은 아니다.** 다만 runtime 파일 내용은 별도 읽기이고 promptVersion은 수동 상수다. 내용 hash 또는 필수 version bump 테스트로 프롬프트 변경을 놓치지 않게 하고, CLI event parser/분할기 변경도 재사용 정책에 반영한다. 저장된 결과 재개와 실행 중 프로세스의 durable resume는 다른 기능이다.

**필요 테스트:** 충분히 큰 다중 commit/file fixture에서 여러 bounded 호출 및 통합 1회, 한 파일 여러 Phase 재사용, chunk 실패/취소/누락 통합, merge 결과의 unknown refs 거부, 같은 입력 재실행은 cache hit. PR 본문만/Jira만/model/prompt/schema/parser 변경을 **실제 `/api/live/run` 경로**에서 무효화 검증한다. `store.test.ts`의 임의 객체 hash 차이만으로 전체 라우트 동작을 검증했다고 보지 않는다. 병행 직렬화 byte cap 수정은 이 다단계 구현을 대신하지 않는다.

### 3. Live 기본 head 투어·과거 예외·StoryEdge의 명시적 계약

**근거:** `contract.ts:validateAnalysis`는 Mock head tour를 강제하지만, `live-analysis.ts:validateLiveOutput`의 step 검사는 임의 Phase와 그 comparison이면 허용한다. `Step`, `live.tsx:chooseStep/LiveWorkspace`, 원본 §5A/B 및 GuidedTour/PhaseExplanation 계약.

**현재 공백:** 실제 결과에는 tourId/tourRevisionSha/과거 예외 종류가 없고 step 배열·prerequisites만 있다. 이 데이터는 읽기 순서를 코드 import와 혼동하지 않게 돕지만 **독립 StoryEdge 엔티티**는 아니다. UI의 “별도 story 단계” 안내를 storyEdges 구현으로 세면 안 된다. 실제 그래프는 `phase.edges` import만 렌더하므로 추정 관계 제안·이유·한계·별도 표현과 focusGraphEdgeIds도 없다. 읽음 저장은 snapshot만 key로 써 같은 snapshot의 새 모델/새 투어가 step ID를 재사용하면 이전 읽음 상태를 구별하지 못한다.

**수정 hook:** `live-analysis.ts`의 tour 작업 계약에 tourId, 기본 `tourRevisionSha=headSha`, 명시 historical step + comparison, storyEdges, focus 대상, 선행 개념을 넣는다. 일반 step을 과거 revision으로 돌릴 수 없게 검증하되 명시 예외는 허용한다. `GraphEdge`(관계 유형·provenance) / `inferredEdgeSuggestion` / `StoryEdge`를 분리하고 static 승격을 거부한다. `live.tsx`의 선택/읽음/이어보기에는 tour ID·분석 버전을 포함한다. inferred edge 편집기의 화려한 UX가 아니라 **데이터·검증·근거를 갖춘 구분**이 필수다.

**필요 테스트:** 기본 Live tour가 전부 과거 SHA인 출력 거부, 명시 과거 단계 허용 및 다시 head로 복귀, step/story 사이클·없는 graph/hunk/file ID 거부, 동일 파일의 두 구간과 다중 파일 단계, AST import와 story/inferred 시각·의미 구분, 재생성 tour의 읽음 상태 분리. Live E2E에는 Mock head-only 결과뿐 아니라 이 계약의 성공·실패 fixture가 필요하다.

### 4. 실행 성공·분석 충분성·위치 검사·의미 검사 상태를 UI에서 분리

**근거:** `live-api.ts:Job/start`의 상태 선택은 `analysisStatus === "partial"`만 partial로 보고 `insufficient_context`는 succeeded로 둔다. `live.tsx:LiveWorkspace`는 모델 결과가 있으면 위치 검증/의미 감사 안내와 limitations를 보여주지만 `analysisStatus`, `missingContext`를 별도 렌더하지 않는다. 원본 §7·§10 및 출력 계약 AnalysisEnvelope.

**현재 공백:** 프로세스가 성공적으로 “자료 부족”을 반환할 수 있다는 구분 자체는 맞다. 문제는 별도 분석 상태가 사라져 사용자가 정상 충분한 분석으로 오해할 수 있다는 점이다. 실제 모델 analyzed 범위도 없고 현재 Coverage의 AST 파일 수만 표시된다. 따라서 단순히 job enum을 바꾸는 것만으로 완료되지 않는다.

**수정 hook:** Job의 processStatus와 결과 analysisStatus, deterministicValidation, semanticAudit, task별 analyzed/omitted/unavailable 범위를 분리한다. Live UI와 cached reload에서 `insufficient_context`, `partial`, 구조화된 missingContext(대상/이유/사용 목적)를 항상 표시한다. 기존 Git/AST Coverage를 모델이 읽고 설명한 범위라고 이름 바꾸지 않는다. 자료 추가 요청을 자동 실행하지 않고 명시 bounded 동작 또는 부족 안내로 처리한다.

**필요 테스트:** 정상 JSON+insufficient_context, partial+빈 steps, failed/cancelled, cached 부족 결과 재열기, AST만 수행한 snapshot과 실제 모델 분석 결과의 구분. 충분성은 낮지만 프로세스는 성공인 경우를 E2E에서 동시에 확인한다. 병행 context 누락 accounting 수정과 독립적으로 UI 상태 assertion이 필요하다.

### 5. PR 변경 우선의 bounded 수집과 직접 관련 미변경 문맥 검색

**근거:** `live-git.ts:collectGit/tree`는 `ls-tree` 순서로 내용을 읽고 `treeFiles` 및 전역 `totalBytes`를 소모한다. `relatedFileIds`는 이후에 변경 파일 집합으로 만든다. `live-analysis.ts:buildContext` PR 경로는 이 변경 집합만 포함하고, `live.tsx`의 문맥 확장은 해당 Phase의 확보 파일 전체를 대상으로 한다. 원본 §3의 필요한 주변 코드/직접 관련 미변경 파일, §5A/C, §7·§10.

**현재 공백:** 변경 metadata보다 전체 tree 내용 수집이 먼저여서 무관한 앞쪽 파일 또는 이전 tree가 예산을 쓰고 핵심 head 변경 파일은 제외될 수 있다. 반대로 이미 확보한 직접 import 대상 미변경 파일도 PR 모델 Context에서는 제외될 수 있다. 제한을 표시하는 것은 맞지만, 최소 관련 문맥 검색을 구현한 것과 같지는 않다. “더 큰 cap”이나 전체 저장소 전송은 해결책이 아니다.

**수정 hook:** tree metadata와 blob 내용을 분리하고 변경 path/old/new/hunk → 명시적으로 필요한 직접 이웃 순서로 예산을 예약한다. 동일 blob 읽기 재사용, head 핵심 파일 우선순위, 한정된 1-hop/심볼 문맥 확장과 origin/reason/evidence를 기록한다. UI 문맥 확장도 직접 관련 후보와 나머지 파일을 구별한다. 언어 parser가 지원하지 않는 경우 텍스트/diff 근거와 부족 상태를 유지하며 import를 call graph로 승격하지 않는다.

**필요 테스트:** 수백 개 무관한 선행 파일 뒤에 있는 단일 핵심 변경, 많은 과거 tree 뒤의 head 변경, 미변경 직접 import 대상 포함/무관한 파일 제외, 순환 import 예산 종료, 같은 blob의 중복 비용, 미지원 언어/alias/dynamic target의 미확인 표시. 병행 AST edge **전달** 수정과 달리 여기서는 무엇을 **수집·선택**하는지 검증한다.

## 외부 blocker와 선택 사항을 혼동하지 않기

| 항목 | 올바른 분류 | 완료에 필요한 증거 |
|---|---|---|
| 인증된 GitHub.com/GHE 목록, 실제 gh 활성 계정 | **외부 미검증** | 승인 계정으로 `/user` 일치 → 내 PR/리뷰 요청 목록 → 선택 PR 고정 수집. 토큰을 문서·브라우저·채팅에 남기지 않음. |
| 실제 GHES/Enterprise Cloud, 사내 VPN/CA/SSO, fork 권한 | **외부 미검증** | 명시 배포/버전/endpoint에서 해당 조직의 읽기 권한·CA·네트워크 경로 검증. 공개 GitHub smoke로 갈음하지 않음. |
| 실제 Jira Cloud/DC, custom field, 권한 | **외부 미검증** | 승인 연결에서 필드/원문/정규화/hash/시점/읽기 실패 상태 검증. 로컬 HTTPS harness는 계정 smoke가 아님. |
| Linux namespace EPERM + 엔진 인증 없음 | **환경/승인 blocker** | 격리가 실제로 통과하는 Linux 환경, 명시 승인 credential, 지원 모델에서 선택 엔진 inference 및 결과 검증. 격리 해제·다른 서비스 credential 재사용·mock 대체 금지. 현재 호스트에서는 inference 완료 주장 불가. |
| macOS | **지원 어댑터 미구현; 단순 실기기 미검증이 아님** | `ai/sandbox.ts:probeSandbox`는 Linux 이외 `unsupported`를 반환한다. macOS 준비 완료/설정만 하면 실행 가능 주장 금지. 원문에 필수 OS 목록이 없으므로 Linux 범위 출시의 별도 차단 조건은 아니지만 Mac 지원을 선언하려면 구현과 실검증 모두 필요. |
| HTTPS 프록시 필수 조직 | **조건부 구현 blocker** | 현재 명시 거부 경로뿐. 필요한 조직이라면 transport/Git/Jira 프록시 어댑터와 CA/CONNECT/credential 경계를 구현·검증해야 함. 일반 직접 연결 경로까지 미구현으로 분류하지 않음. |
| Monaco, SQLite, 특정 layout 라이브러리 | **선택 기술** | 원문 §11은 제안. 자체 viewer/JSON 저장으로 요구 동작을 충족할 수 있으므로 교체 자체를 수용 조건에 넣지 않음. |
| 모든 언어/alias/동적 dispatch/전체 call graph | **비필수 확장** | 지원 언어를 명시하고 diff 중심 축소·미확인 표시를 하면 됨. import 사실과 호출·타입·테스트 대상·설정 영향 추정의 유형/근거 구분은 여전히 필수. TS 구문 AST 사용만으로 type checker/호출 분석 완료가 되지 않음. |
| Jira 댓글·상위/관련 이슈 UI | **선택 기능 core 미연결** | 어댑터 기능은 이미 있음. 노출할 경우 명시 범위·취소·coverage·source refs의 core 연결 테스트 필요. |
| 암호화·다중 프로세스 DB·실행 중 작업 durable resume | **초기 필수 아님 / 정확한 한계 필요** | 민감 cache 권한/보존/삭제는 필수이고 구현되어 있다. atomic JSON·메모리 job의 현재 보증을 SQLite transaction·암호화·재시작 후 active job 복구라고 부르지 않음. |

## 상위 5개 외에 남겨둘 객관적 수용 항목

새 우선순위 목록이 아니라 위 행렬의 후속 체크 항목이다.

- **fork 메타데이터 보존:** `ingest.ts`가 획득/재확인한 base/head repository 식별자를 `LiveSnapshot`에 고정하고 원문 패널 및 캐시 차원에 연결한다. 삭제된 fork는 명시 null/접근 불가로 보존한다. `ingest.test.ts`에서 서로 다른 base/head 저장소가 snapshot 재열기 후에도 남는지 확인한다.
- **복잡한 Git 검증:** 기존 DAG fixture를 criss-cross, 동일 blob 다중 rename 후보, rebase/force-push 이전 snapshot 재사용 금지, 실제 fork fallback 실패, Phase 상한과 거대 pack 자원 한계로 확장한다. 기존 root/shallow/merge 성공을 이 모든 사례의 완료로 확장하지 않는다. rename 경로 재사용 병행 수정을 중복 수행하라는 뜻은 아니다.
- **코드 의미 탐색의 단위:** 심볼/함수 목록, change hunk와 주변 코드의 역할, next-reading 대상은 현재 수동 라인 선택/일반 문자열보다 좁게 구현되어 있다. 우선순위 1·2·5의 계약·수집 확장과 함께 수용 테스트를 만든다.
- **선택 설정의 UI 완결성:** Jira project key pattern은 서버 설정/검증 필드가 있으나 기본 SourcePanel 폼에는 입력이 없다. “UI에서 모든 후보 패턴 설정 가능”으로 안내하려면 입력/저장/복원 테스트를 추가한다.

## 릴리스 판정 규칙

1. 상위 구현 공백은 **미구현을 외부 미검증으로 옮겨 적어 닫지 않는다**. 새 단위·통합·E2E 출력으로 요구 동작을 검증한다.
2. 병행 core/adapter 수정의 결과를 통합한 뒤 앱 자체 테스트/빌드를 새로 실행한다. 이 문서의 이전 fixture 기록은 최종 소스의 pass 보증이 아니다.
3. 실제 계정 smoke, 실제 엔진 inference, 의미 품질 평가는 각각 별도 증거다. 계정이 없어도 schema/상태/분할/투어/수집 fixture 개발은 계속 가능하다.
4. 가능한 완료 표현은 **“0.2 기반의 로컬 탐색·실연동 경로, 명시된 fixture 범위 검증; 제품 수용 일부 미완·실계정/추론 미검증”**이다. 현재 자료로 **전체 Stage 5 완료, 전체 요구 충족, production-ready, macOS-ready**라고 표현할 수 없다.
