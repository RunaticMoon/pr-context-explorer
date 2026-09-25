# 커밋 단위 리뷰 흐름과 로컬 CLI 분석 UX

## 목적

리뷰어가 PR을 커밋 1→2→3 순서로 무엇이·왜 바뀌었는지 읽고, 로컬에 설치된 Claude Code/Codex CLI로 분석을 실행·확인하기 위한 화면 변경입니다. 기존 고정 Git snapshot과 1회 PR 분석 결과를 커밋 단위로 재배치해 보여주며 새 추론을 추가하지 않습니다.

컴포넌트: `src/commit-timeline.tsx`(타임라인), `src/commit-review.ts`(파생 로직·차단 이유), `src/commit-review-panel.tsx`(선택 커밋 리뷰), `src/live-analysis-controls.tsx`(로컬 CLI 분석). `src/main.tsx`의 데모 워크스페이스는 타임라인을 사용합니다. 실제 PR 워크스페이스(`src/live.tsx`) 연결은 통합 브랜치에서 병합 중입니다.

## 커밋 타임라인

- Baseline(비교 기준) 카드와 각 커밋 카드를 Git 위상 순서로 나열하고 사이에 → 흐름 화살표를 표시합니다.
- 커밋 카드: 실제 첫 부모 기준 변경 파일 수 · hunk 수, 부분 diff 표시, 투어 단계 읽음 수(분석이 있을 때만), subject, SHA 앞 8자리.
- 상단에 위치(`커밋 N / 전체` 또는 `Baseline · 비교 기준`)와 **이전 커밋 / 다음 커밋** 버튼이 있고, 선택 카드는 화면 안으로 스크롤됩니다.
- 접근성 이름은 기존 E2E가 의존하는 `Baseline (비교 기준)`과 `Phase N`을 유지합니다(`aria-label`, `aria-pressed`, `aria-describedby`).
- 하단 고지: "Git 위상 순서 · 변경 비교는 실제 첫 부모 기준".

## 선택 커밋 리뷰 패널

- 헤더: 위치, 커밋 subject, 선택 SHA · 비교 기준 SHA(없으면 `root`). 추가 부모 비교 중에는 "아래 파일 상태는 첫 부모 기준입니다", 부분 diff일 때는 "일부 변경만 캡처되었을 수 있습니다" 경고를 표시합니다.
- **AI 요약**: `(commitSha, comparisonFromSha)` 쌍이 정확히 일치하는 단계 요약이 있을 때만 제목 · 변경 전 · 변경 내용 · 이유 · 한계를 표시합니다. 다른 부모 기준으로 작성된 요약을 이 커밋의 첫 부모 리뷰로 보여주지 않습니다. 없으면 "이 커밋의 AI 요약 없음 · Git 원문만 표시"(분석 미실행이면 "분석 미실행 · Git 원문만 표시").
- **변화 묶음**: 이 커밋을 포함하는 change group을 표시하며 여러 커밋에 걸치면 "여러 커밋에 걸친 묶음" 배지를 붙입니다. 묶음 안 파일 버튼은 이 커밋에 실제 존재하는 파일로만 제한합니다.
- **변경 파일**: "변경 파일 N · hunk M". 삭제는 old side로 취급하고, rename은 `old → new` 경로를 모두 표시합니다. 원문 미확보/omission 같은 수집 한계 주석을 유지하며, hunk가 0이어도 변경 파일로 취급합니다(모드 변경 · 잘린 diff · 바이너리). Baseline 선택 시에는 변경 통계를 표시하지 않습니다.
- **투어 단계**: 분석이 있을 때만 표시합니다. 이 revision에 고정된 단계만 나열하고 "이 커밋의 투어 단계 R/S 읽음"과 단계별 ✓를 표시합니다. 단계가 없으면 "이 revision의 투어 단계 없음"과 함께 **고정 head 투어 열기** 버튼을 제공합니다.

## 항상 보이는 로컬 CLI 분석 영역

분석 실행 여부와 무관하게 항상 표시되며, 이 영역의 상태 확인 자체는 모델을 호출하지 않습니다.

- 분석 엔진 선택(Codex CLI / Claude Code CLI), 설치 여부 · CLI 버전 · 준비 상태 한 줄 표시, **분석 엔진 설정** 이동 버튼.
- **엔진 준비 차단 이유**를 코드와 함께 모두 나열합니다: 미설치(`not-installed`), 미검토/미지원 버전(`unsupported-version`, 누락 capability 포함), 격리 실행 불가(`isolation`, 상세 포함), 인증 계열 — 로컬 인증 파일 재사용 동의 필요(`auth-reuse-consent`) · 로컬 인증 파일 없음(`auth-file-missing`) · 수동 인증 필요(`auth-manual`) · 인증 미설정(`auth-not_configured`) · 미인증(`auth-not_authenticated`), 상태 미확인(`status-unknown` · `auth-<기타>`). 미확인 상태를 인증 실패로 단정하지 않습니다.
- **분석 모델 ID (필수)**: 설치 CLI가 지원하는 정확한 ID를 직접 입력하며 자동 추정이 없습니다. 엔진 설정 화면의 **모델 식별자**와 같은 값입니다.
- 동의 항목: 선택 범위의 PR/코드/Jira 전송 동의(필수), 동일 엔진 · 모델 의미 감사 추가 전송/과금 최대 1회 동의(선택), 과거 revision 투어 예외 허용, 검증 캐시 우회 새 실행.
- **PR 전송 계획 확인 · 모델 호출 없음**: 예정 분할 수 · 제공자 호출 상한 · 추가 감사 호출 수 · 직렬화 bytes · 전송 scope을 표시합니다.
- **PR 맥락 분석 실행** 버튼은 비활성 이유를 목록으로 표시합니다: 다른 작업 진행 중 · 모델 ID 미입력 · 제공자 전송 동의 없음 · 선택 엔진 미준비.
- 코드 Q&A는 같은 실행 차단에 더해 파일 미선택 · 라인 범위 미선택 · 추가 부모 비교 중(첫 부모 비교만 지원) · 선택 side 내용 없음을 비활성 이유로 표시합니다. 전송 범위는 선택 SHA/side/라인과 해당 커밋 원문 문맥, PR · Jira 원문입니다.
- 고지: 로컬 CLI는 오프라인 추론이 아니며 GitHub/Jira 토큰은 전달하지 않습니다. 격리 · 인증 · 기능이 없으면 실행이 차단되고, 화면 이동은 모델을 실행하지 않습니다.

## 변경하지 않은 것

- 서버 API, V3 출력 schema, trusted 프롬프트, CLI pin 버전(Codex 0.154.0 / Claude Code 2.1.270), 인증 파일 형식, 격리 정책은 변경하지 않았습니다.
- 커밋별 새 추론은 없습니다. 1회 PR 분석 결과(phaseSummaries · changeGroups)를 커밋별로 재배치해 표시할 뿐입니다.
- **읽음**은 투어 진행률 표시이며 승인이나 검토 완료가 아닙니다.

## Linux 개발 호스트 준비 (실행 사실)

로컬 CLI를 실제로 실행 가능 상태로 만들기 위해 이 개발 호스트에서 수행한 준비입니다. 프로젝트 코드가 아닌 호스트 변경입니다.

- `bubblewrap` 설치 → `/usr/bin/bwrap`.
- Ubuntu 24.04의 비특권 userns 제한으로 bwrap이 막혀 있어 `/etc/apparmor.d/bwrap`(bwrap 전용 `userns` 허용 프로필)을 추가했습니다. 되돌리기는 파일 삭제 + `apparmor_parser -R`.
- `npm install --prefix .tools/ai-clis @openai/codex@0.154.0 @anthropic-ai/claude-code@2.1.270` 후 `chmod -R go-w .tools`.
- 실행 파일 신뢰에는 모든 상위 디렉터리가 group/other 쓰기 불가여야 하므로 저장소 상위 디렉터리 권한을 775 → 755로 조정했습니다.
- 결과: 엔진 탐색에서 두 CLI 모두 installed · supported · isolation runtimeVerified로 확인되고, 남은 준비 차단은 인증뿐입니다.
- 실제 추론 결과(성공 실행 · 응답 품질)는 별도 검증 기록이 나오기 전까지 주장하지 않습니다.

## 검증

- 단위 테스트: `tests/commit-review.test.ts`, `tests/commit-timeline.test.ts`, `tests/commit-review-panel.test.ts`, `tests/live-analysis-controls.test.ts`, `tests/v3-fixture-summaries.test.ts`.
- E2E: `tests/e2e/commit-flow.spec.ts`(통합 브랜치에 추가). FAKE deterministic runner를 사용하며 실제 추론이나 의미 품질 검증이 아닙니다.
