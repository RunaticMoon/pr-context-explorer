# PR Context Explorer — 개발·분석 프롬프트 모음

이 모음은 GitHub/GitHub Enterprise PR을 파일별 목록이 아니라 의도와 변화의 맥락을 따라 이해하는 도구를 만들기 위한 것이다. 구현된 애플리케이션이나 실행 가능한 연동 코드는 아니다.

## 사용 순서

1. 새 프로젝트에서 Codex 또는 Claude Code에 `01-project-master.md`의 본문을 전달한다. 이 문서는 **도구를 개발하는 AI**에게 주는 지시다.
2. 개발을 나눠 진행할 때 `02-implementation-stages.md`의 해당 단계 프롬프트를 추가한다. 이전 단계 결과와 현재 코드에 맞춰 사용한다.
3. 제품 내부에서 PR을 분석할 때는 `runtime/00-common-system.md`와 해당 작업 프롬프트를 조합한다. 이 문서들은 **PR을 읽고 설명하는 런타임 AI**의 지시다. 개발용 마스터 프롬프트를 PR 분석 요청에 그대로 넣지 않는다.
4. `docs/OUTPUT-CONTRACT.md`를 바탕으로 실제 JSON Schema와 앱 측 검증기를 구현한다. 프롬프트의 JSON 지시만으로 검증을 대체하지 않는다.
5. `docs/TECHNICAL-NOTES.md`는 구현 시 재확인할 공식 문서와 주의점이다.

## 파일 구성

- `01-project-master.md`: 제품 목표, 기능, UX, 데이터 모델, 보안, 완료 기준.
- `02-implementation-stages.md`: 단계별로 바로 전달할 후속 개발 지시.
- `runtime/00-common-system.md`: 근거·불확실성·보안·출력 공통 규칙.
- `runtime/01-pr-analysis.md`: PR 전체 의도와 요구사항 추적.
- `runtime/02-phase-explanation.md`: 커밋별 변화와 그래프 설명.
- `runtime/03-guided-tour.md`: 사람에게 맞는 추천 읽기 순서.
- `runtime/04-code-explanation.md`: 파일·함수·코드 구간 설명.
- `runtime/05-evidence-audit.md`: 근거와 설명의 의미적 일치 점검.
- `docs/OUTPUT-CONTRACT.md`: 입력/출력 계약과 결정적 검증 규칙.
- `docs/TECHNICAL-NOTES.md`: 공식 문서 확인 사항과 구현 주의점.

## 런타임 입력 조합

공통 시스템 지시는 신뢰된 앱 코드에서 관리한다. `{{OUTPUT_SCHEMA_JSON}}` 등 출력 계약은 앱이 제공하며, PR/Jira/코드 자료는 JSON으로 직렬화한 별도 데이터 입력에 넣는다. 소스 본문을 명령행 문자열 또는 상위 권한 지침에 직접 삽입하지 않는다.

템플릿 변수는 파일마다 정의되어 있다. 변수 이름을 치환하는 것만으로 안전한 연동이 완성되는 것은 아니다. 프로세스 격리, 도구 권한, 인증 분리, schema 검증, 실제 SHA/라인 검증은 애플리케이션이 수행해야 한다.

## 기본 가정

로컬 우선 개인용 웹앱, Claude Code CLI, 한국어 설명, 읽기 전용 연동을 기본값으로 둔다. 프레임워크·프로젝트 이름은 제안이다. 로컬에서 CLI를 실행하더라도 선택한 AI 제공자에게 코드가 전송될 수 있으며, 실제 전송/보존/사용 조건은 계정과 조직 정책에 따라 확인해야 한다.

문서 기준일: 2026-09-15. 특정 CLI 버전이나 사내 서비스에 대한 실제 실행 검증은 수행하지 않았다. 설치된 버전의 공식 문서와 기능 탐지 결과를 우선한다.
