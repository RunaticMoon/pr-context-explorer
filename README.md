# PR Context Explorer · Demo + Live (0.3.0)

소스는 Git으로 관리합니다. ZIP은 과거 전달본/선택 export입니다. [저장소 연결 상태와 Git 관리 안내](docs/REPOSITORY.md).

한국어 로컬 우선 PR 이해 도구. **명시적인 Git fixture 데모를 유지하면서 실제 GitHub/GHE → 고정 Git snapshot → 선택한 Codex/Claude → 근거 검증 경로를 제공합니다.** 실제 PR에서 MockProvider로 자동 대체하지 않습니다.

**0.3:** 실제 Live API가 V3 분할→검증→근거 포함 통합→고정 head 투어→선택 의미 감사 파이프라인을 기본 사용합니다. 모든 중요 진술의 kind/근거/추정 이유·한계, 부족 상태, 불일치 양쪽 원문과 독립 Q&A를 표시합니다. [릴리스 경계와 전체 변경](docs/RELEASE-0.3.md). 실제 인증 계정/모델 추론은 아래 외부 게이트가 남습니다.

## 실행

검증 환경: Linux ARM64, Node **24.20.0**, npm **11.19.0**, Git. 앱 테스트에는 Python3와 OpenSSL, E2E에는 Playwright Chromium이 필요합니다. 공개 서버/서비스/방화벽 설정은 변경하지 않았습니다. [새 디렉터리 설치·검증 및 소스 ZIP 안내](docs/SOURCE-DELIVERY.md).

```bash
cd /home/ubuntu/development/pr-context-explorer
npm ci
npm run build
npm start
```

**http://127.0.0.1:4317/** 을 엽니다. `localhost`, 다른 Host, 외부 Origin은 거부합니다. `PORT=4320 npm start`로 포트를 바꿀 수 있습니다. Ctrl-C로 종료합니다. 같은 origin에서 빌드 자산과 API를 제공하며 별도 개발 프록시가 필요하지 않습니다.

- **데모 PR 목록 열기**: 계정 없이 실제 baseline + 3 Git 커밋, 고정 MockProvider 설명, 모의 DEMO-1 Jira. 기존 Stage 1 경험 그대로입니다.
- **실제 PR 연결**: 실제 연결 저장/검증, 작성/리뷰 요청 목록, URL 수집, 실제 원문/그래프/코드/분석 화면. 실제 AI 실행 전까지 설명은 `not_run`입니다.
- 대상 저장소의 install/test/build, hooks, AGENTS.md, CLAUDE.md, MCP는 **실행하지 않습니다**. 이 문서의 테스트 명령은 탐색기 앱 자체 테스트입니다.

## 실제 GitHub / Enterprise 연결

1. **실제 PR 연결**에서 연결 ID, 배포 유형, Web URL, API base URL, API 버전, 계정 login을 입력하고 **연결 저장**.
2. 인증 방식 선택:
   - **공식 gh auth**: 앱 밖에서 공식 `gh auth login --hostname <승인한-host>`로 로그인합니다. 앱은 `gh auth token --hostname`을 실행하고 토큰을 메모리에서만 사용합니다. 복수 계정은 gh의 활성 계정을 선택해야 하며, `/user`가 설정 login과 다르면 거부합니다.
   - **서버 환경변수 이름**: `PRCE_GITHUB_TOKEN` 같은 전용 이름만 입력합니다. 토큰 값은 브라우저/채팅/URL에 넣지 않습니다. 앱을 시작하는 셸에서 안전하게 공급하세요.
   - **공개 URL만**: 인증/내 PR 조회 없이 명시적으로 지정한 공개 PR만 읽습니다. 인증된 계정 검증으로 표시하지 않습니다.
3. **인증 사용자 확인**은 실제 `GET /user`. **내 PR / URL 열기**에서 작성/리뷰 요청, 저장소/조직/작성자/상태/draft/검색 필터와 페이지 이동을 사용합니다.
4. PR URL을 붙여 넣고 **고정 snapshot 수집**. 등록한 exact Web origin의 `owner/repo/pull/number`만 허용합니다. URL의 쿼리/credential/정규화가 필요한 입력은 거부합니다.

배포 설정:

| 유형 | Web | API | 추가 필수 |
|---|---|---|---|
| GitHub.com | `https://github.com` | `https://api.github.com` | 명시적 API 날짜 버전 |
| Enterprise Cloud | github.com 또는 승인된 `https://<enterprise>.ghe.com` | 각각 api.github.com 또는 `https://api.<enterprise>.ghe.com` | Server와 동일 취급하지 않음 |
| GHES | `https://<승인한-DNS-host>` | 같은 host의 `/api/v3` | GHES 서버 버전 + API 날짜 버전 |

기본 API 날짜는 `2022-11-28`; 대상 GHES가 해당 헤더/엔드포인트를 지원하는지는 실제 조직 환경에서 확인해야 합니다. 포트가 명시된 호스트/IP literal은 현재 거부합니다. 최소 권한은 선택 저장소의 metadata/contents/pull requests 읽기입니다. 조직 SSO 승인·fine-grained token 정책은 조직에서 확인하세요. 기존 gh 토큰에 쓰기 권한이 있어도 앱의 원격 작업은 GET/Git fetch뿐입니다.

### VPN / CA / 프록시

- `NODE_EXTRA_CA_CERTS=/absolute/path/company-ca.pem npm start`: API TLS에 추가 CA를 사용하며 Git에는 `http.sslCAInfo`로 전달합니다. 승인한 PEM을 공급하세요.
- TLS 검증 끄기, redirect credential forwarding, 임의 fallback은 없습니다.
- **HTTPS_PROXY 기반 프록시는 현재 fail-closed**입니다. 인증 프록시/CONNECT/프록시 CA 호환성을 구현했다고 주장하지 않습니다. 승인된 직접/VPN 경로를 사용하거나 후속 프록시 어댑터를 검증해야 합니다.
- `authentication_required`, `unknown_or_forbidden`(403/404), `rate_limit`, `transport_error`를 구분합니다. TLS/DNS/VPN 실패 안내가 정확한 네트워크 원인을 항상 판별하는 것은 아닙니다.

## 고정 Git 이력과 탐색

앱은 사용자 worktree를 checkout하지 않고 **앱 전용 bare cache**에 base/head SHA를 fetch합니다. head 접근 실패 시 metadata가 지정한 같은 승인 host의 fork만 시도합니다. 원격 clone URL이나 본문의 링크를 따라가지 않습니다. 수집 전후 base/head/PR 본문·제목·브랜치를 재검사하여 변경되면 `stale_snapshot`으로 거부합니다.

- PR 순변경 = **유일한 merge-base → head**. base tip → head, 각 커밋 첫 실제 부모 → commit, 임의 고정 SHA 비교를 분리합니다.
- 실제 DAG 부모를 모두 보존하고 topo 표시 순서를 사용합니다. merge의 부모별 diff를 보존합니다. root는 명시적 empty-tree 비교입니다. 복수/없는 merge-base는 PR diff를 만들지 않습니다.
- 각 Phase는 실제 tree 조회. rename score/계보, 삭제 old tombstone, 최종 diff에서 사라진 중간 revert도 남습니다.
- Graph는 지원 JS/TS의 상대 **AST import**만 표시합니다. 실행/호출 그래프나 AI 읽기 순서로 표시하지 않습니다.
- Guided Flow/Code Explorer는 snapshot/SHA/비교/file/side/range를 공유합니다. URL/back/reload/읽음/이어보기가 있으며 화면 이동만으로 모델을 재실행하지 않습니다.
- 코드 라인 클릭과 Shift+클릭으로 범위를 선택합니다. **선택 범위 설명 실행**은 최대 500라인의 명시적 Q&A 범위를 보냅니다.

정책 상한: 텍스트 파일 256 KiB, tree당 내용 수집 500개, Git 텍스트 수집 예산 12 MiB, 상세 Phase 150개(나머지 metadata 및 head 유지), 커밋 metadata 1000개 이상은 거부. diff 표시는 2 MiB, Git subprocess 출력은 16 MiB 상한입니다. 모델 입력은 별도 bounded context입니다. binary/generated/lockfile/큰 파일/symlink/submodule/LFS/미지원 언어/누락 이력은 Coverage에 노출하며 확보한 것으로 계산하지 않습니다. LFS 객체와 submodule은 fetch하지 않습니다.

GitHub Search의 1000개 상한, PR commits의 250개 및 files의 3000개 상한과 **페이지네이션 완료 여부를 분리**합니다. 실제 이력과 파일은 Git 객체로 보완하며 API 누락 patch도 별도 기록합니다.

## Jira (선택 사항)

실제 연결 화면의 **Jira 연결**에서 Cloud REST v3 / Data Center REST v2, Web/API base, 계정 맥락, 프로젝트 키 → 연결 매핑, acceptance criteria 커스텀 필드 ID를 저장합니다. 인증정보는 `PRCE_JIRA_TOKEN` 같은 **서버 환경변수 이름**만 허용합니다. `Bearer`/`Basic`은 해당 헤더 payload를 서버 환경에 공급하는 방식이며 Basic은 조직의 지원 인증 방식과 인코딩을 확인하세요.

workspace의 **Jira 후보 연결 / 제외 / 실제 원문 수집**:
1. PR 제목/본문/브랜치/커밋에서 후보와 발견 위치를 확인.
2. 잘못된 후보 제외, 등록한 연결+키 수동 추가.
3. 선택한 후보를 명시적으로 수집. 실패해도 PR-only 분석 계속 가능.
4. 원문/정규화된 텍스트/필드 위치/hash/fetched/updated를 보존한 **새 snapshot** 생성. 현재 이슈를 커밋 당시 요구사항이라고 주장하지 않습니다.

`no_data`, `unconnected`, `unknown_or_forbidden`, `communication_error`, `partial`, `captured`를 구분합니다. core UI는 기본 이슈 필드만 수집합니다. 독립 어댑터의 선택 댓글/상위/관련 이슈 범위는 UI에 아직 노출하지 않았습니다.

## Codex / Claude 실행

```bash
npm run probe:engines
```

실제 설치 버전/help, 인증 설정, namespace 격리 가능 여부를 반환합니다. probe 성공은 inference 성공/구독 사용 가능 확인이 아닙니다. 실행에는 검증된 네이티브 CLI와 Linux bwrap 격리, 명시적 엔진 인증이 필요합니다. 설치/지원 버전/격리 세부사항은 `docs/AI-ADAPTERS.md`와 `src/server/ai/`의 독립 어댑터 계약을 따릅니다.

앱은 임의 홈/Hermes/다른 서비스의 인증을 찾아 재사용하지 않습니다. **명시적인 server-owned JSON 파일**을 사용합니다. 소유자 전용 0600, absolute path, symlink 금지:

```json
{
  "providers": {
    "codex": {
      "auth": { "kind": "codex-auth-file", "path": "/absolute/approved/codex/auth.json" }
    },
    "claude": {
      "auth": { "kind": "claude-oauth-token-file", "path": "/absolute/approved/claude-token" }
    }
  }
}
```

`api-key-file`도 지원하는 별도 방식입니다. 이 경로들은 예시이며 실제 존재/권한을 확인해야 합니다. 필요한 **한 엔진만** 설정해도 됩니다. 파일에 시크릿 자체를 넣지 않고 승인한 엔진 credential 파일의 경로만 지정합니다.

```bash
PRCE_AI_CONFIG=/absolute/private/ai-config.json npm start
```

workspace에서 정확한 모델 ID와 제공자 전송 동의를 선택한 뒤 **PR 맥락 분석 실행** 또는 선택 코드 Q&A를 실행합니다. source는 stdin의 데이터이며 trusted runtime prompt/schema와 분리합니다. 결과를 JSON Schema 및 SHA/path/blob/side/range/PR·커밋·Jira source 검증 후에만 저장합니다. 엔진 변경/MockProvider/unsandboxed fallback은 없습니다. 진행 이벤트, 취소, 오류와 성공/partial을 구분합니다.

V3는 최대 48개 bounded chunk와 근거 포함 통합/투어를 사용하며 실행당 최대 52회/15분입니다. **PR 전송 계획 확인**은 모델 호출 없이 실제 분할 수·bytes·호출 상한을 표시합니다. 선택 의미 감사는 동일 엔진/모델의 추가 전송·과금 최대 1회에 별도로 동의해야 합니다. 프로세스 성공과 `complete / partial / insufficient_context`, 위치 검사와 의미 감사 상태를 각각 표시합니다. 감사 `performed`도 전체 안전성/요구 충족 보증이 아닙니다.

**이 개발 호스트에서 실제 probe:** project-local Codex 0.154.0 / Claude 2.1.270 기능 탐지 성공, 인증 미설정, namespace/loopback 설정 EPERM으로 격리 불가. 따라서 실제 모델 분석은 **미검증·차단**입니다. 운영 계정/PR/정책은 사용자가 제공하고, namespace가 허용되는 검증된 환경에서 이어서 테스트해야 합니다.

## 저장·캐시·삭제

- 기본: `~/.local/share/pr-context-explorer/`. `PRCE_DATA_DIR=/absolute/app-owned/path`로 분리할 수 있습니다.
- SQLite 대신 atomic JSON record store + bare Git을 사용합니다. 상위 앱 디렉터리 0700, JSON 0600, 서버 umask 077. 암호화/다중 사용자 DB가 아니며 같은 OS 사용자/root는 읽을 수 있습니다.
- config, snapshot, 전체 V3 analysis+validationContext, chunk/stage 요약, Jira 및 후보 선택이 재시작 후 유지됩니다. 캐시 키는 연결(host/type/API/account), PR/base/head/본문 hash, Jira/source hash, scope, provider/model, 실제 context/prompt/schema hash, parser/planner/앱 adapter 소스 fingerprint를 포함합니다. 자동 결과·분할 재사용 TTL은 10분이며 **새 실행** checkbox로 우회합니다. 기록 자체는 30일 보존 정책이며 모델 alias 버전 고정을 보증하지 않습니다.
- JSON은 기본 30일 뒤 읽기에서 만료, 앱 시작 때 prune. Git 캐시는 마지막 fetch가 30일 이전인 앱 소유 디렉터리만 시작 시 삭제합니다. 서버가 꺼진 동안 예약 정리를 실행하지 않습니다.
- 새로운 Git snapshot이 생기면 이전 버전은 stale로 표시. UI는 저장된 snapshot을 실시간 최신으로 주장하지 않습니다.
- **실제 연결 → 로컬 캐시 삭제**는 명시적 확인 후 snapshot/분석/chunk/Jira/선택 및 앱 bare cache 삭제, 연결 설정은 유지. 실행 중인 작업은 먼저 취소/종료하세요. 디스크 secure erase는 아닙니다.
- `npm run cache:clear`는 **데모 `.data` 캐시** 삭제 명령입니다. 서버 중지 후 사용하세요. 브라우저 읽음/이어보기는 이 origin의 사이트 데이터 삭제로 지웁니다.

## 검증 명령과 증거

```bash
npm test
npm run build
npm run test:e2e
# 선택 사항: 아래 명령만 실제 공개 GitHub에 읽기 요청 (모델 전송 없음)
npm run smoke:public -- https://github.com/octocat/Hello-World/pull/1
```

E2E는 4317에 별도 서버를 띄우며 `.data/e2e-live`를 사용합니다. 해당 포트의 기존 앱을 먼저 중지하세요. Chromium이 없는 새 환경은 Playwright 공식 설치 안내를 따릅니다. 기본 테스트는 실제 서비스 인증/모델 inference를 하지 않습니다.

최신 통합 검증 로그: `artifacts/integration-final-unit.log`, `integration-final-e2e.log`, `integration-final-build.log`, `integration-final-public.log`, `integration-final-probes.log`, `integration-final-guard.log`. Chromium V3 캡처: `integration-final-v3-qa.png`, `integration-final-v3-evidence.png`. 공개 HTTPS + Git fetch는 실제 원격 읽기입니다. V3 E2E는 실제 API/파이프라인/저장소를 호출하되 **FAKE deterministic JSON runner**를 쓰며 실제 추론 또는 의미 품질 검증이 아닙니다. 기존 V2 interception/Demo 회귀도 별도로 유지합니다. 정확한 숫자와 미검증 범위는 [검증 기록](docs/TEST-RESULTS.md) 참조.

## 현재 완료 경계

[docs/CORE-STATUS.md](docs/CORE-STATUS.md)와 [0.3 릴리스 경계](docs/RELEASE-0.3.md)에 구현/부분/외부 게이트를 구분했습니다. 선택 의미 감사의 실행·보류·실패 처리와 bounded 다단계 요약은 구현·fixture 검증되었으나 실제 엔진 설명 품질·사내 GHE/Jira/SSO/CA·production launcher의 양성 실행은 미검증입니다. **macOS AI는 지원 어댑터 미구현**, HTTPS 프록시는 fail-closed입니다. 심볼 색인/전체 call graph/모든 rename ambiguity/대형 pack quota/durable 진행 작업 재개는 구현 완료로 표시하지 않습니다. 위치 검사 통과는 설명의 의미적 지지나 테스트 통과를 증명하지 않습니다.
