# 0.3.0 — Live V3 통합 릴리스 경계

## 실제 기본 실행 경로

`POST /api/live/run → executeAnalysis → analysis-v3.runPipeline → server-owned runner → ai.runAnalysis`가 기본 Live 경로다. V3는 사용되지 않는 병렬 라이브러리가 아니다. 데모의 MockProvider/V2 설명은 별도로 유지하며 Live의 실패를 데모로 대체하지 않는다.

- 실제 LiveSnapshot을 검증하고 변경 파일/커밋/원문을 bounded chunk로 나눈 뒤 각 출력을 검증한다. 검증된 요약과 **실제 원문 근거를 함께** 통합하고 별도 head tour를 생성한다.
- 동일한 선택 엔진/모델로만 선택 의미 감사를 수행한다. 별도 checkbox로 추가 전송/과금 최대 1회를 동의해야 한다. 전체 실행 상한은 52회/15분, 최대 48개 chunk다. 토큰 가격 추정값은 제공하지 않는다.
- `POST /api/live/plan`은 저장된 snapshot만으로 분할 수/직렬화 bytes/호출 상한/누락을 계산한다. 모델이나 추가 원격 source를 호출하지 않는다.
- 브라우저는 명시적 scope/provider/model/consent와 boolean 정책만 전달한다. runner/config/command/auth/path/budget/version override는 요청에서 거부한다. 엔진 설정 파일은 기존 private server-owned 설정 경로로만 읽는다.
- 작업 `processStatus`와 `output.analysisStatus`를 분리한다. 정상 프로세스가 `insufficient_context`를 반환해도 충분한 분석으로 표시하지 않는다. 실패/취소한 파이프라인의 coverage와 감사 실패도 job에 남긴다.

## 저장과 캐시

`analysis`에는 전체 V3 output, 정확한 최종 `validationContext`, 모든 navigation evidence, 선택 범위, 정책, 원본 stage metadata/audit/coverage를 저장한다. V2로 축소해 저장하지 않는다. GET/reload에서도 원본 snapshot/범위/입력·버전 identity와 스키마/근거를 재검증한다.

`chunk` private bucket은 파일/커밋/원문 분석, 통합, 투어, 감사의 검증된 stage 출력을 저장한다. pipeline key를 정확한 연결(호스트/API/계정) namespace로 감싼다. key에는 snapshot/base/head/PR/Jira/source hash/실제 context hash/provider/model/parser/planner/prompt 내용/schema 내용/앱 AI adapter 소스 fingerprint가 포함된다. 잘못된 chunk만 거부·재실행하며 유효한 다른 chunk는 재사용한다.

- 자동 분석 재사용/분할 cache TTL: 10분. 명시적 새 실행 checkbox는 모든 stage cache를 우회한다.
- 기록 열기/보존: 기존 30일 store 정책. 시작 시 prune 및 명시적 삭제에 `chunk`도 포함한다. 연결 설정은 보존한다.
- adapter 소스 fingerprint는 **설치 CLI 바이너리/실제 모델 가중치 fingerprint가 아니다**. CLI/observed model/usage는 실제 runner metadata를 보존한다. 움직이는 모델 alias의 변경을 자동 검출한다고 주장하지 않는다.
- 저장 실행의 `currentRunTransmittedEvidenceIds`와 과거 cache 재사용 포함 `transmittedEvidenceIds`, 인용 IDs를 구분한다. 화면 읽기/기록 복원은 새 전송 0회이며 과거 실행의 전송량을 이번 탐색의 전송으로 표시하지 않는다.
- 실행 중 작업 재시작 복구, 암호화, 다중 프로세스 admission lock은 없다.

## 화면 동작

`src/live-grounded.tsx`가 overview/phase/change groups/코드 동작/입출력/오류/부작용/전후/질문/후속 읽기/요구 매핑/불일치/감사의 GroundedStatement를 kind·근거·추정 rationale·limitation·confidence와 함께 렌더한다. confidence와 위치 검사 결과를 의미적 보증으로 표시하지 않는다.

- 투어는 고정 `tourId`/`tourRevisionSha`, 검증된 **첫 primary focus evidence 순서**를 따른다. collector가 old 근거를 먼저 저장했더라도 기본 투어는 head/new에서 시작한다. 과거 단계는 명시 정책으로만 허용한다.
- StoryEdge는 단계 사이 읽기 연결이며 코드 관계가 아니다. 실제 AST import는 청색 실선, inferred 관계는 황색 점선과 명시 provenance로 구별한다.
- 원문/코드 불일치는 양쪽 evidence 버튼과 확인 방향을 표시한다. 실제 source의 버전/hash/필드와 코드의 SHA/path/side/range를 확인할 수 있다.
- PR `analysis`와 Q&A `codeAnalysis`는 별도 상태/URL/cache다. 비동기 완료·cache hit·reload·back 이후도 PR tour를 보존한다. Q&A cache만 만료/삭제/검증 거부되어도 유효한 PR 투어와 snapshot은 열고 오류를 따로 표시한다. 선택 SHA/file/side/range가 다르면 Q&A를 같은 코드의 답변으로 표시하지 않는다.
- 추가 부모 비교의 old evidence는 그 부모의 확보된 실제 tree/hunk mapping으로 표시한다. 현재 Q&A scope 계약은 Phase 첫 부모 비교만 지원하므로 **추가 부모 비교에서 Q&A 실행은 비활성화하고 이유를 표시**한다. 첫 부모 원문으로 대체하지 않는다.
- 읽음 저장 key는 snapshot/result-version/tour identity로 분리한다. 상태·근거 URL 변경만으로 모델을 호출하지 않는다.
- 한국어 글꼴/metadata font 고정 수정은 유지한다. 긴 source version/hash/ID는 줄바꿈한다.

## 실제 검증과 외부 게이트

최종 명령/숫자는 `docs/TEST-RESULTS.md` 상단 및 `artifacts/integration-final-*.log`를 기준으로 한다. 이전 core/review 로그를 최신 실행으로 재사용하지 않는다.

| 범위 | 이번 증거 | 완료로 확대할 수 없는 것 |
|---|---|---|
| V3 API/runner/cache/store | 실제 Git 객체 + 실제 API + 명시 FAKE JSON runner; 여러 chunk/통합/투어/감사, 선택 무효화/손상 캐시/부족/실패/취소 검증 | 실제 모델 inference/설명 품질 |
| Browser | 실제 loopback HTTP/session/CSRF/Chromium, Live V3→Q&A→tour/reload/back/양쪽 근거/추가 부모; 기존 Demo 및 V2 회귀 유지 | 실제 계정으로 인증된 PR 목록 |
| 공개 GitHub | octocat/Hello-World#1 실제 HTTPS/API/Git fetch/원문 snapshot; 모델 전송 없음 | GitHub/GHE 계정, 사내 SSO/fork 권한 |
| CLI probe/guard | Codex 0.154.0 / Claude 2.1.270 기능 탐지, 인증 미설정, namespace EPERM; 기본 V3 실행도 fail-closed | 양성 production launcher/TLS/model inference |
| Linux AI | strict bwrap/별도 엔진 인증 경로 구현 | 현재 호스트에서 실제 실행 가능하다는 보증 |
| macOS AI | **지원 어댑터 미구현** | 단순 미검증/설정만 필요한 상태 아님 |
| Jira | 기존 adapter/transport/정규화 경계 fixture 회귀 유지 | 실제 Cloud/DC 계정/조직 필드 확인 |

실제 GH/GHE/Jira 인증, 승인된 모델 전송 및 의미 품질 평가, namespace가 허용되는 호스트에서 production launcher 양성 실행은 아직 외부 게이트다. 다른 서비스/Hermes 인증을 읽거나 격리를 끄지 않았다. 사내 HTTPS 프록시는 여전히 미구현 fail-closed다.

상위 5개 통합 공백을 보완했다고 **원본 제품 전체 수용 완료/production-ready**라고 선언하지 않는다. 별도 심볼/함수 색인, 모든 언어·동적 call graph, 복잡한 rename ambiguity, 대형 pack quota, Jira optional scope UI, fork 저장소 별도 엔티티 등 원본 감사의 추가 범위는 이 V3 통합으로 구현되었다고 주장하지 않는다. 소스 ZIP 작성/검증은 상위 전달 담당자가 수행하며 공개 배포는 하지 않는다.
