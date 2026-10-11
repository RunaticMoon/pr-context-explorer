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

Mac 실행 결과와 최종 테스트 수치는 작업 완료 시 갱신한다. 이 문서의 구현 설명만으로 Mac 검증 완료를 주장하지 않는다.
