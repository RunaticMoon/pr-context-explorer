# 공식 문서 확인 사항과 구현 주의점

기준일: 2026-09-15. 아래는 공식 문서 확인 결과이며 사용자의 로컬 CLI, 사내 GitHub/Jira, 계정 권한에서 직접 실행한 결과가 아니다. 설치 버전과 조직 정책이 최종 기준이다. 구체적 옵션은 기능 탐지 후 사용한다.

## 1. Codex 비대화형 실행

공식 문서는 `codex exec`를 스크립트/자동화용 비대화형 실행 방식으로 안내한다. `--json` 이벤트 스트림과 `--output-schema`를 통한 최종 구조화 출력을 구분해야 한다. 읽기 전용 sandbox는 쓸 수 있는 파일 범위를 제한하는 도구이며, 그것만으로 비밀파일 읽기나 모든 외부 전송 문제가 해결된다고 간주하면 안 된다.

인증 문서는 ChatGPT 로그인과 API 키 로그인을 구분하고 계정/조직별 데이터 처리 정책 차이를 설명한다. 기존 로그인 활용 가능성을 점검하되, 모든 계정에서 모든 자동화가 허용되거나 추가 비용이 없다고 가정하지 않는다.

공식 문서:
```text
https://developers.openai.com/codex/non-interactive-mode
https://developers.openai.com/codex/auth/
```

## 2. Claude Code 비대화형 실행

공식 문서는 `claude -p`를 통한 프로그램 호출과 `--output-format json`, `--json-schema`를 설명한다. 구조화 결과는 CLI 응답 envelope의 `structured_output` 필드로 반환될 수 있으므로 이벤트/메타데이터와 분리해 파싱한다.

현재 CLI 문서상 `--allowedTools`는 승인 없이 실행할 도구를 지정하는 기능이며 전체 도구 가용 범위를 제한하는 것과 같지 않다. `--tools`로 내장 도구 가용 범위를 제한하더라도 MCP 도구는 별도 통제가 필요하다. 자동 로드 설정·hooks·정책 등도 설치 버전에 맞게 확인해야 한다. 단순한 allowlist 하나를 완전한 sandbox로 설명하지 않는다.

공식 문서:
```text
https://code.claude.com/docs/en/headless
https://code.claude.com/docs/en/cli-reference
https://code.claude.com/docs/en/data-usage
```

## 3. 로컬 실행과 모델 처리 위치

로컬 우선은 UI, 데이터 저장, 수집, 프로세스 실행 위치의 설계다. 추론이 반드시 로컬에서 끝난다는 뜻이 아니다. Claude Code 문서는 Anthropic API 기반 동작을 설명하며, Codex도 선택한 인증과 모델 제공자에 따른 데이터 처리 정책이 적용된다.

제품에는 최소한 다음 정보를 노출하도록 제안한다: 선택 엔진과 계정, 모델 제공자, 전송할 코드/메타데이터 범위, 로컬 저장 위치와 삭제 방법, 조직 정책 확인 안내. 비밀 탐지는 보조 수단이며 민감한 소스를 모두 찾아낸다고 보장하지 않는다.

## 4. GitHub / GHES와 수집 한도

GitHub Enterprise Server 문서는 서버 REST API base URL을 `https://HOSTNAME/api/v3` 형태로 설명한다. Cloud와 Server를 구분하고 호환 API 버전을 설정해야 한다. URL 문자열을 한 곳에 고정한 뒤 호스트명만 치환하는 설계는 피한다.

현재 GitHub PR REST 문서에는 PR 커밋 목록 최대 250개, PR 파일 목록 최대 3,000개가 명시되어 있다. 페이지네이션을 완료해도 API 전체 상한을 넘으면 모든 데이터가 확보된 것은 아니다. 로컬 Git 기반 보완 또는 partial 표시가 필요하다.

공식 문서:
```text
https://docs.github.com/en/enterprise-server@3.20/rest/using-the-rest-api/getting-started-with-the-rest-api
https://docs.github.com/en/rest/pulls/pulls
https://cli.github.com/manual/gh_auth_status
https://cli.github.com/manual/gh_search_prs
```

## 5. Jira 문서 표현과 배포 유형

Jira Cloud REST API v3 문서는 이슈 description과 다중 행 custom field 등에 Atlassian Document Format을 사용한다고 설명한다. 응답을 단순 문자열로 가정하지 않고 정규화/원문 보존 계층을 둔다.

Jira Data Center는 별도 문서와 배포 버전 기준으로 연동한다. 수용 기준의 위치를 모든 사이트에서 같은 필드로 가정하지 않는다. 이슈 상태와 요구사항 구현·검증 결과도 동일한 개념이 아니다.

공식 문서:
```text
https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/
https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/
https://developer.atlassian.com/server/jira/platform/rest-apis/
```

## 6. Git 비교와 이력

Git 문서는 merge-base, 두 commit 사이의 diff, merge-base와 endpoint 사이의 three-dot diff를 구별한다. log의 first-parent는 특정 가지의 개요에 유용하지만 다른 부모의 커밋을 전체 이력인 것처럼 숨기는 데 사용하면 안 된다.

제품 설계에서는 PR 순변경, 커밋 자체의 부모 대비 변화, 두 임의 Phase 사이의 비교를 각각 이름 붙여 구분한다. 비선형 이력을 화면상 순서대로 patch 누적하는 대신 각 commit tree를 기준으로 보여준다. 복수 merge-base 등의 모호함은 정책과 한계를 명시한다.

공식 문서:
```text
https://git-scm.com/docs/git-diff
https://git-scm.com/docs/git-merge-base
https://git-scm.com/docs/git-log
```

## 7. 그래프 UI 선택

React Flow는 커스텀 노드와 상호작용 가능한 노드 기반 UI를 위한 구성 요소를 제공한다. 이 프로젝트의 파일 노드 UI 후보로 제안한 것이며, 코드 관계 추출이나 커밋별 정확한 상태를 자동으로 계산해주는 것으로 가정하지 않는다. 도메인 그래프, 좌표/layout, 화면 강조 상태를 분리한다.

공식 문서:
```text
https://reactflow.dev/learn/customization/custom-nodes
https://reactflow.dev/
```
