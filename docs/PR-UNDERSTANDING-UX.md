# PR 이해 흐름 개선 · 검증 기록

기준 소스: `e1d239d60674c1240087078534a44c45aa72a3bc`. 작업 시작 시 Git 작업 트리는 깨끗했다. 원격 push, 릴리즈, 인증 구조 변경은 하지 않는다.

## 발견한 문제와 구현

| 우선순위 | 사용자 행동에서 드러난 문제 | 변경 |
| --- | --- | --- |
| P0 | merge의 다른 부모를 선택해도 파일 상태·변경 전 코드가 첫 부모에서 남음 | 실제 Git name-status와 선택한 before/after tree로 비교 화면을 구성. 확보하지 못한 원문은 명시적으로 제외 |
| P0 | diff의 old 줄 번호를 눌러도 new 코드가 선택됨 | 두 gutter를 각 side·line에 연결하고 존재하지 않는 줄/미확보 원문의 선택을 차단 |
| P0 | 빠른 비교·snapshot 전환 뒤 오래된 성공/실패 응답이 섞일 수 있음 | snapshot·from·to별 요청 키와 effect cleanup으로 현재 선택만 반영 |
| P1 | 첫 PR 열기가 마지막 커밋·빈 파일 선택·전체 그래프로 시작 | PR 목적·최종 변경·실제 커밋 흐름이 있는 개요, 처음부터 읽기와 특정 Phase 진입 제공 |
| P1 | AI head 투어와 실제 Git 커밋 흐름을 같은 Guided Flow로 이해할 수 있음 | 기본 Guided Flow는 실제 커밋 읽기. 별도 AI 코드 투어로 표시하고 기존 고정 revision 계약 유지 |
| P1 | 커밋을 옮긴 뒤 반복 수정 파일을 다시 찾아야 함 | 선택 파일의 실제 변경 Phase 이력, rename ID 계보 유지, 현재 위치와 바로 이동 |
| P1 | 1280px 창에서 3열이 코드 폭을 크게 줄임 | 기본 2열, 1600px 미만에서 보조 패널을 접히는 별도 영역으로 배치. 메타데이터와 세부 설명을 접음 |
| P1 | 필터·커밋 이동이 그래프 배치와 수동 zoom/pan을 초기화 | snapshot의 고정 좌표, 현재 revision 관계선만 렌더, viewport 복원. 표시 중인 파일 수와 관계 종류 명시 |
| P1 · Mac 추가 발견 | 좁은 창에서 관계 패널을 눌러도 그래프가 코드 아래 화면 밖에 남고, 그래프에서 고른 파일도 위쪽 화면 밖에 남음 | 명시적 패널 열기·노드 선택에만 해당 패널/reader로 이동하고 포커스 전달. 커밋·파일 전환 전체에 자동 스크롤을 적용하지 않음 |

| P1 · Mac 재검증 | 긴 PR의 관계 패널을 처음 열면 파일 노드가 위아래로 잘리고 선만 보임 | 전체 snapshot의 안정적인 격자 좌표로 파일을 배치하고 노드 측정 후 fit. 중복 초기 fit을 제거해 수동 viewport 복원 보존 |
| P1 · Mac 재검증 | 패널을 닫으면 읽던 버튼이 sticky header 위에 남음 | 패널 제거가 반영된 다음 프레임에 opener를 화면 중앙으로 복귀시키고 포커스 전달 |

## 기본 동선

저장된 PR 목록 → PR 전체 맥락 → 처음부터 따라 읽기 / 특정 실제 Phase → 변경 파일과 정확한 diff → 다음 커밋 또는 같은 파일의 다음 변경 → PR 전체 맥락 복귀. 분석 없이도 같은 동선으로 원문을 읽을 수 있다.

비교 범위는 **실제 부모 → 커밋**, **유일한 PR merge-base → 선택 커밋**, **유일한 PR merge-base → head**로 구분한다. 최종 범위를 선택하면 실제 head로 이동하며 화면에 그 SHA를 표시한다. merge 부모를 고를 수 있고, 위상 표시 순서와 직접 부모 관계가 다를 수 있음을 알린다.

PR 개요의 분석 없는 목적은 작성자 본문 발췌다. 본문이 없으면 의도 미확인으로 표시한다. 최종 Git tree 통계는 중간 변경을 합산하지 않아 revert를 최종 변경으로 세지 않는다. rename은 통계에서 전후 두 경로로 집계한다고 명시한다. 모델 추정은 근거·추정 이유·한계와 함께 구별한다.

## 검증 자료

- `artifacts/ux-before/`: 기준 소스의 Linux Chromium 캡처. 1280×800 목록, 첫 열기, Phase 1.
- `artifacts/ux-after/`: 수정 소스의 Linux Chromium 캡처. Mac 캡처와 구분한다.
- `tests/e2e/ux-journey.spec.ts`: 실제 Git 객체로 만든 명시적인 작은/긴 테스트 PR. 3/18 커밋, 반복 수정, exact rename, 삭제, 긴 경로·180줄 diff. AI 추론·실제 사용자 테스트가 아니다.
- `tests/e2e/live-comparison-state.spec.ts`: 실제 비교 API와 늦은 응답의 선택 일치 검증.
- `tests/live-git.test.ts`, `tests/commit-file-reader.test.ts`, `tests/commit-review.test.ts`, `tests/pr-overview.test.ts`: 비교·계보·gutter·최종 tree 회귀.
- `.maclab/tests/ui-review.json`, `scripts/maclab/`: before/after 소스 해시 → 실제 Mac 빌드 → 별도 설치 → 동일 fixture 조작·캡처. 실행 결과는 아래에 추가한다.

## 검증 경계

원문·diff를 수집하지 못한 큰 파일·binary·누락 부모는 확보했다고 표시하지 않는다. 유일한 merge-base가 없는 경우 누적/최종 diff를 생성하지 않는다. 기존 제품은 dark UI이며 별도 light theme는 구현하지 않았다. 실제 사내 GHE/Jira 인증, 모델 추론 품질, 실제 사용자의 이해 속도는 fixture로 검증하지 않는다.

## 자동 검증 결과

- 첫 구현 `f7645e7`, 비교 상태 보완 `288e95c`, Mac source 묶음 보완 `9a8e10a`, 첫 Mac 피드백 반영 `5289b5b`. 후속 그래프·복귀 수정은 아래 최종 검증 기록을 따른다.
- `npm run build`: 통과. Mac 업로드 tar를 별도 디렉터리에 추출한 before/after도 각각 `tsc --noEmit` 통과.
- 비교 상태 관련 단위 테스트 46개 통과. 실제 Git의 여러 부모·rename·삭제·원문 미확보와 응답 순서 역전을 검증했다.
- 관련 브라우저 시나리오 11개 통과. `5289b5b`의 작은/긴 PR 및 패널 진입 추가 여정 3개 통과했다. Linux Chromium 결과이며 Mac GUI 검증과 구분한다.
- `v3-*.test.ts` 6개 파일의 잔여 검사 29개 통과. `tmpdir-portability`는 재실행 통과했다.
- 전체 `npm test` 단일 실행은 1,282개의 통과 출력 후 종료 코드 143으로 끝났으며 전체 통과로 계산하지 않는다. 중간 `tmpdir-portability` 실패는 내부 assertion이 아니라 기존 30초 watchdog이었다. 동일 내부 검사 33개는 29.68초에 통과했고, 현재 원본 재실행은 29.53초, 기준 소스는 26.74초에 통과했다. 제한에 가까운 실행시간 변동은 남은 검증 한계다.
- Mac 재발견 후 최종 빌드 통과. 그래프 단위 13/13, 핵심 UX 여정 4/4 통과: 초기 노드 실제 화면 좌표·읽기 폭, Phase 간 좌표 유지, 수동 viewport 재진입 보존, 긴 경로 비겹침, 패널 닫기 버튼 가시성·포커스 복귀 포함.
- 전체 로그와 인계 기록: `artifacts/verification/`. 초기 실패와 수정 뒤 성공 로그를 함께 보존했다.

## Mac 실행 기록

- 최초 run `7499e9eb-7ffe-4e6f-99fd-8e40e865fe14`: 중단된 로컬 스케줄러 때문에 할당 전 대기. 취소·서비스 복구 후 `settled/canceled`, 유료 Mac 할당 없음.
- run `16223c73-68cf-42f6-bdb6-cf4e3a6a50c2`: 실제 Mac 준비 후 양쪽 빌드가 공개 Jira integration fixture 누락으로 실패했다. 앱 설치·GUI 검증 결과로 사용하지 않는다. 정확한 파일만 source allowlist에 추가하고 추출 소스 검사를 통과시켰다. 종료 확인, 정산 완료 비용 $0.04.
- 수정 패키지: `9a8e10ae8f063af07ba2cb6dc7aa15ac0b9aea95`, tar SHA-256 `2d91e35cc3fb122b762cb8c5e56df9e734138304af700b875cca2c832c7f5cb2`, manifest 725개 파일. 기준 소스는 위와 동일하다.
- 재검증 run `f008d8a0-3b31-483b-9ff1-3a8d3602df02`: 두 실제 앱의 빌드·설치·서명 검사 통과. 같은 작은 PR의 첫 화면/Phase 2를 비교하고 긴 PR의 rename·후속 수정·삭제·단일/누적/최종 범위 화면을 육안 확인했다. 추가로 발견한 패널 가시성 문제는 위 표에 기록하고 후속 수정했다. 직접 이전/다음, 반복 변경 Phase 12→3, rename·삭제·비교 범위 이동 확인. cleanup confirmed, 정산 matched, 확정 $0.20.
- 이 run의 baseline `open small/long` 자동 assertion 2건은 `.commit-review`라는 잘못된 대기 선택자로 실패했다. 실제 화면은 열렸으며 원문 stderr는 `review.mjs:142`의 30초 timeout이다. 두 버전에 존재하는 `data-testid`로 수정했고, Phase 선택은 파일 이력 버튼과 혼동하지 않도록 timeline 내부로 한정했다. 기존 실패를 자동 통과로 소급하지 않는다.

이 문서의 구현 설명이나 자동 검사만으로 Mac GUI 검증 완료 또는 실제 사용자의 이해 속도 향상을 주장하지 않는다.

- `33a1e17d-2ad1-410c-821e-c278c32c9d5b`: 계정의 당일 사용액과 기본 run 예약 $0.50 때문에 할당 전 대기. 취소 settled, provider 활동 없음, 비용 없음.
- 재검증 `70cee351-e8f8-445b-961c-74b19f1810c9`: 앱 `5289b5b`, tar `a01392b92559f064f1eedaaa1f5fd107dee1cebc99e1d70fa94b7b16fb5c422d`. before/after 실제 빌드·설치·서명 확인 통과. 자동 assertion 14 pass / 1 unknown, 전체 `inconclusive`. baseline 긴 PR 열기의 20초 운용 제한에서 exit code를 받지 못했으며 원문 오류가 없어 앱 실패로 단정하지 않는다. 일반 운용 제한을 45초로 복원하고 숨긴 timeline을 visible 대신 attached 상태로 기다리도록 개선했다. 과거 unknown을 소급 통과시키지 않는다.
- 이 재검증에서 관계 패널 표시·포커스, Phase 이동 시 화면 유지, 노드 클릭→정확한 diff, 패널 제거를 실제 Mac에서 확인했다. 초기 fit과 닫기 후 opener 가시성 결함은 화면으로 재발견하고 후속 수정했다. cleanup confirmed, 정산 matched, 확정 $0.106667. 여기까지 총 $0.346667.

실제 Mac 화면은 1440×900이고 앱 콘텐츠 viewport는 1280×757 / 1440×757이었다. 요청한 800/900 높이는 메뉴·Dock 때문에 제한됐으므로 **Mac에서 콘텐츠 높이 900 검증 완료로 보고하지 않는다**. Linux 브라우저에서는 1280×800 및 1440×900을 별도로 확인했다.

## 비교 가능한 실제 Mac 화면

모두 명시적 합성 Git PR을 실행한 실제 Mac의 원본 캡처다. 합성 PR이나 AI 미분석 상태를 실제 사용자 저장소 분석 결과처럼 표시하지 않았다. 이미지별 commit/run/evidence/SHA-256은 [manifest](ux-review-evidence/manifest.json)에 있다.

| 장면 | 개선 전 | 개선 후 |
| --- | --- | --- |
| 같은 작은 PR의 Phase 2 | [3열·전체 그래프 중심](ux-review-evidence/before-phase-2.jpg) | [현재 위치·비교 SHA·넓은 diff](ux-review-evidence/after-phase-2.jpg) |
| 첫 화면 | 기존 첫 열기는 코드·관계 중심 | [목적·최종 결과·실제 커밋 개요](ux-review-evidence/after-overview.jpg) |
| rename 근거 | — | [실제 Phase 4와 old/new 경로](ux-review-evidence/after-rename.jpg) |

## 주요 변경 파일과 판단

- `src/pr-overview.tsx`, `src/pr-overview.css`: 작성자/분석 근거를 구분한 목적, 최종 tree 결과, 실제 Phase 진입. 긴 본문과 전체 그래프는 첫 화면에서 접는다.
- `src/live.tsx`, `src/live.css`: 개요·커밋·비교·파일 선택을 연결하고 요청 키로 지연 응답을 차단. 좁은 창은 커밋 흐름과 코드 2열, 관계·보조 화면은 명시적으로 연다.
- `src/comparison-state.ts`, `src/server/live-git.ts`: 실제 부모/merge-base/head 비교 및 rename·삭제·누락 원문 계약.
- `src/commit-timeline.tsx`, `src/commit-review-panel.tsx`, `src/commit-file-reader.tsx`: 현재 N/전체, 이전/다음, 반복 파일 이력, 근거 gutter와 파일별 읽기 위치 복원.
- `src/graph-layout.ts`, `src/graph-autofit.tsx`: 커밋을 바꿔도 같은 파일 좌표 유지. 노드 위치 자체에는 시간·의존 의미를 부여하지 않고, 현재 SHA의 확인된 관계선과 추정 관계선을 구분한다.
- `scripts/ux-fixture.ts`, `tests/e2e/ux-journey.spec.ts`, `.maclab/tests/`, `scripts/maclab/`: 실제 Git fixture와 재현 가능한 설치·비교 시나리오. 새 의존성·프레임워크 교체 없음.

## 남은 검증 경계

실제 사용자 연구는 수행하지 않았으므로 이해 속도 향상을 단정하지 않는다. Mac 직접 조작, Mac 자동 assertion, 이미지 육안 확인, Linux 자동 검사는 별도 결과다. 실제 GHE/Jira 계정 권한·네트워크 오류, Codex/Claude 실제 분석 실패·대기, 비선형 merge의 Mac GUI 여정은 이번 합성 fixture에서 직접 확인하지 않았다. merge 비교와 늦은 응답은 자동 검사로 확인했다. Mac에서 긴 diff의 가로·세로 스크롤과 전체 Tab 순서를 완주하지 못한 항목은 Linux 검증으로 대체했다고 표현하지 않는다.

저장된 PR 목록이 초기 설정 영역 아래에 있어 스크롤이 필요한 점은 남은 편의 문제다. 기존 라이트 테마는 없으며 dark UI를 검증했다. 전체 테스트 단일 실행도 위의 watchdog/종료 제약이 있어 전체 통과로 주장하지 않는다.
