# 소스 전달 및 독립 재현 검증 — 0.3.0

2026-09-14 UTC. 부모 에이전트가 작업자의 최종 보고와 별도로 실행했다.

## 실제 재실행

- 프로젝트 원본: `npm test` 276/276, `npm run build` 성공, Chromium E2E 12/12.
- 공개 `octocat/Hello-World#1`: 실제 HTTPS API + Git fetch + 고정 snapshot 수집 성공. 모델 전송 없음.
- 두 엔진 probe: 설치 CLI 기능은 확인했지만 인증 미설정, namespace EPERM, ready=false/inferenceVerified=false 유지.
- 최종 V3 근거 화면 캡처 확인: 한국어 glyph 정상, 선택 SHA/new side/라인 구간 표시, 큰 패널 겹침 없음. FAKE runner 화면이며 실추론 결과가 아니다.

## 깨끗한 디렉터리에서 재현

소스 후보 ZIP을 `/tmp` 아래 새 디렉터리에 풀고, 기존 프로젝트의 node_modules/.data/.tools를 복사하지 않은 상태에서 실행했다.

- `npm ci`: 성공. 이 잠금 파일에 대해 npm이 보고한 취약점 0. esbuild postinstall 승인 경고가 있었으나 이어지는 실제 빌드 성공. 이를 보안 감사 통과로 해석하지 않는다.
- `npm run build`: TypeScript/Vite 성공, React Flow use-client 지시 무시 경고 잔존.
- `npm test`: 276/276, fail/cancelled/skipped=0.
- `npm run test:e2e`: Chromium 12/12.

이는 **같은 Linux 호스트의 새 프로젝트 디렉터리** 검증이지 새 OS나 macOS 검증이 아니다. 시스템 Git/OpenSSL/Python 및 이미 설치된 Playwright Chromium 캐시는 공유했다. 새 환경은 Node/npm/Git과 테스트용 Python3/OpenSSL/Chromium 준비가 필요하다.

## 전달 아카이브

`scripts/package-source.py --output <존재하지 않는 ZIP 경로>`가 명시된 소스 경로만 수집하고 SHA-256 manifest와 ZIP CRC/내용 해시를 검증한다. ZIP에는 `SOURCE-MANIFEST.json`이 들어 있다.

포함: src/scripts/tests/docs/references, README 및 package/lock/TS/Playwright 설정. 테스트가 필요로 하는 정확한 두 파일만 artifacts 예외로 포함한다:
- `artifacts/ai-cli-verification.json`: 인증 없는 설치 CLI help/version 기록. 실제 인증/모델 성공 기록이 아니다.
- `artifacts/jira-integration-example.ts`: 테스트하는 서버 통합 예제.

제외: node_modules, .tools 설치 바이너리, .data, 실제 로컬 캐시, .env/숨김 source, 임의 artifacts 로그와 캡처. source symlink는 거부한다. 이 경로 allowlist는 **소스 내용에 대한 완전한 비밀 탐지기가 아니다**. 배포 전 소스에 의도적으로 넣은 시크릿이 없는지 별도 검토해야 한다. 기록·검증 로그는 원본 프로젝트 `artifacts/parent-release-*`, `clean-release-*`에 남아 있다.

배포 ZIP은 위 검증 후보와 동일한 프로그램·테스트 파일이며, 최종 검증 기록 문서만 갱신했다. ZIP 작성/검증은 공개 서비스 배포가 아니다.

## 여전히 전체 완료가 아닌 이유

실제 계정과 허용된 격리 호스트에서 positive production launcher/TLS/모델 분석 검증을 하지 못했다. macOS AI와 사내 HTTPS proxy는 미구현이며, 함수/심볼 독립 색인·대형 pack quota·일부 복잡한 lineage/부가 Jira UI 등은 RELEASE-0.3.md의 알려진 범위로 남는다. 인증이나 조직 정책을 가짜 값으로 대체하지 않았다.
