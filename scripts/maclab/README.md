# Maclab 실제 설치 UI 검증

이 디렉터리는 유료 세션을 만들거나 Maclab 설정을 바꾸지 않는다. `ui-review`는 승인된 일회용 **macOS arm64** 세션에서만 실행한다. 자동 테스트가 통과해도 실제 GUI 조작·스크린샷 육안 평가·사용자 테스트가 완료됐다는 뜻은 아니다.

## 실행 전 준비

- Maclab 프로젝트 `pr-context-explorer`와 업로드 허용 경로 `.cache/maclab` 등록이 필요하다. 현재 도구에는 기존 Mac 연결/재사용 API가 없고, `mac_test_start`는 새로운 유료 NoMac 세션을 할당한다. 사용자 요청의 별도 승인 없는 유료 인스턴스 생성 금지를 따라 시작 전 승인 여부를 확인한다.
- 정의는 **현재 커밋**의 `.maclab/tests/ui-review.json`에서 고정되며, 추적 파일의 미커밋 변경이 있으면 Maclab이 거부한다. 사용자 변경을 커밋·삭제·stash하지 않는다. 최종 소스의 검토와 필요한 작업 트리 분리를 먼저 끝낸다.
- Mac은 Command Line Tools, `/usr/bin/python3`, npm·Electron·Node의 고정된 의존성을 받는 네트워크, 화면 세션, System Events 자동화/손쉬운 사용 권한이 필요하다. 권한이 없으면 우회하지 않고 실패를 기록한다.
- 원격 사용자의 기존 `~/Library/Application Support/PR Context Explorer`가 있으면 실행을 거부한다. 기존 앱 데이터·인증을 옮기거나 지우지 않는다.

```sh
python3 scripts/maclab/package-source.py
# 기본 before = e1d239d60674c1240087078534a44c45aa72a3bc
# 출력 = .cache/maclab/ui-review.tar 및 .sha256
```

패키지는 allowlist에 있는 소스·lockfile·테스트만 포함한다. `.git`, 환경 파일, 인증, 로컬 캐시, node_modules, 기존 빌드 산출물은 넣지 않는다. `before/`는 고정 Git 커밋이고 `after/`는 패키징 순간 작업 트리다. `source-manifest.json`에 모든 파일의 SHA-256, before SHA, after HEAD, 미커밋 변경 여부를 기록한다. 변경 후에는 반드시 다시 패키징한다. Maclab이 기록하는 HEAD만으로 작업 트리 산출물의 동일성을 주장하지 않는다.

## 실제 수행 범위

`mac_test_start {"test_name":"ui-review","purpose":"승인된 실제 설치 UI 검증 목적"}`는 승인된 경우에만 실행한다.

1. 각 소스 inventory를 확인하고, SHA-256이 고정된 Node 24.21.0을 run 내부에 준비한다.
2. `npm ci`, 기존 `desktop:pack:mac`으로 **실제 Electron .app**과 native ACL helper를 Mac에서 빌드한다. run 내부의 `Applications/before/`와 `Applications/after/`에 복사해 설치하고 코드 서명을 검증한다. 사용자 `/Applications`, `~/Applications`는 사용하지 않는다.
3. 업데이트 네트워크 요청을 막기 위해 두 리뷰 빌드는 `PRCE_PUBLIC_UPDATES=0`을 사용한다. 그 외 앱 소스·인증·sandbox와 패키징 검사는 그대로 실행한다. Apple 계정, 서명 인증서, 릴리즈, 배포는 사용하지 않는다.
4. 실제 계정과 run-local HOME의 앱 데이터가 모두 새 경로임을 확인한다. `scripts/ux-fixture.ts`로 두 곳에 같은 합성 PR을 만들고 디렉터리 소유권을 기록한다. Electron이 HOME 대신 계정 DB의 경로를 택할 수 있기 때문이다. 두 버전은 동일한 fixture 데이터를 사용한다.
5. 실제 설치 실행 파일을 실행하고, 앱 PID·포함된 Node backend PID·실행 경로를 확인한다. 인증 token을 출력하지 않는다. 로컬 CDP는 읽기 상태/일반 클릭 검증에만 사용하며 production IPC에 기능을 추가하지 않는다.
6. 목록 → 작은 PR → 2번 커밋 → 긴 PR을 클릭하고 1280×800 / 1440×900 창 크기를 요청해 화면을 캡처한다. macOS 메뉴/Dock 영역 때문에 실제 높이가 제한될 수 있으므로 `resize` 결과의 viewport와 화면을 함께 판단한다.
7. before를 정상 종료한 뒤 after로 같은 동선을 반복한다. 자동 검증 후 after 앱을 수동 클릭/스크롤/키보드 검증을 위해 남긴다.

`PRCEReview.app`은 Maclab의 준비 단계에서 확인하는 **전송용 메타데이터 봉투**다. 검증 대상 실행 앱은 Mac에서 빌드·설치된 `Applications/<phase>/PR Context Explorer.app`이다. 봉투의 존재를 앱 설치 성공으로 보고하지 않는다.

## 수동 검증

`exploration.ready=true`일 때만 Maclab click/key/type/exec를 사용한다. 한 번에 한 작업을 보내고 같은 request_id의 성공/실패를 기다린다. screenshot → status에서 새 evidence_id → view로 매번 관찰한다.

```sh
# mac_test_exec의 argv = ["/bin/bash", "scripts/maclab/run-review.sh", ...]
bash scripts/maclab/run-review.sh inspect
bash scripts/maclab/run-review.sh open small
bash scripts/maclab/run-review.sh phase 1
bash scripts/maclab/run-review.sh resize 1280 800
bash scripts/maclab/run-review.sh open long
bash scripts/maclab/run-review.sh phase 18
# 버전 비교가 더 필요하면 현재 앱을 정상 종료한 뒤:
bash scripts/maclab/run-review.sh stop
bash scripts/maclab/run-review.sh start before
```

이전/다음, 같은 파일 반복 변경, rename/삭제, 세 diff 범위, 그래프, 요약 복귀, 빠른 전환, Tab 포커스, diff 세로/가로 스크롤을 실제로 확인한다. helpers의 `phase`는 버튼을 클릭하는 보조 수단일 뿐 다음/이전 동작 전체의 검증이 아니다. long fixture의 긴 diff와 실제 화면을 보고 레이아웃을 판단한다. 분석 실패/권한 오류/실제 GitHub·Jira·로컬 모델 연동은 별도의 검증이며 이 fixture로 통과했다고 주장하지 않는다.

## 비용과 종료

서버 계정 정책을 읽은 시점의 한도는 일 $1, 월 $5, run $0.50, 최대 1800초다. 문서의 분당 반올림 $0.80/h 가정이면 최대 30분은 약 $0.40이나 **견적일 뿐이며 서버 상태가 실제 비용의 근거**다. 재검증 비용을 줄이기 위해 자동 빌드는 단계당 180초, 실행은 60초, 일반 조작은 45초, 수동 창은 최대 180초로 제한한다. 실제 남은 마감 시간과 누적 비용을 확인한다. 비용 한도·세션 제한을 바꾸거나 다른 계정으로 우회하지 않는다.

완료 즉시 `mac_test_finish` 또는 `mac_test_cancel` 후 `mac_test_status`에서 cleanup과 비용 정산을 확인한다. 앱을 정상 종료하는 helper와 Maclab 세션/과금 종료는 서로 다르다. `accepted:true`는 테스트나 정리 성공이 아니다.

수집 자료: source manifest, 두 installed manifest, 명령별 exit code/stdout, Maclab 스크린샷 evidence. 최종 보고에는 run_id/evidence_id, 육안 확인, 직접 GUI 조작, 자동 검증을 각각 구분한다.

## 그래프 후속 검증

`ui-graph-review`는 이미 보존된 before/after 비교 뒤 발견한 그래프 초기 배치 문제만 재검증한다. 같은 tar에서 after만 빌드·설치하고 긴 fixture의 Phase 2를 1280px 창으로 연다. `graph` helper는 실제 관계 버튼을 클릭하고 모든 표시 노드가 canvas 안에 있으며 폭 120px 이상인지 확인한다. fit 버튼으로 먼저 보정하지 않는다. 수동 창은 150초이며, 노드→reader, 이전/다음, 수동 pan/zoom 보존, 닫기 복귀를 추가 확인한다. 이 후속 실행이 baseline 자동 실패를 소급 통과시키지는 않는다.
