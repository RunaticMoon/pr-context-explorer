# 최종 통합 게이트

0.2 감사에서 도출한 통합 체크리스트이며 0.3 root 통합 후 실제 검증 상태를 갱신했다. 근거: `TEST-RESULTS.md` 상단 및 `artifacts/integration-final-*`. 체크된 항목은 명시 fixture/코드 범위의 완료이며 실계정/실추론 전체 수용을 뜻하지 않는다.

## 진행 중인 수정 후 반드시 통합할 항목

- [x] core/collector/adapter/V3 review-fixes 재현 테스트와 전체 앱 테스트 재실행: 276/276.
- [x] `analysis-v3/index.ts` 분할→개별 검증→통합→선택 의미 감사를 실제 `executeAnalysis` 기본 경로에 연결.
- [x] V3 GroundedStatement/불일치 양쪽 근거/StoryEdge/head tour revision 렌더.
- [x] 프로세스와 `analysisStatus`, `insufficient_context`/`partial`/`missingContext` 분리·복원.
- [x] PR 분석/Q&A 별도 저장, 비동기·cache hit 후 투어 다시 열기.
- [x] 실제 문맥/모델/prompt/schema/parser/연결/source 차원 캐시 무효화, 검증된 chunk 재사용, navigation 자동 실행 없음.
- [x] collector 변경 우선→직접 import 문맥, tree metadata/누락/Phase 보존 회귀 통과.
- [x] 큰 우선순위 fixture와 실제 UTF-8 직렬화 예산 회귀 통과.
- [x] 실제 HTTP/Chromium 12개: 세션/연결/새로고침/back/취소/부족/투어→Q&A→투어/근거/추가 부모. FAKE runner, 실추론 아님.
- [x] 최종 root 소스에서 전체 빌드·테스트·공개 smoke·CLI probe 재실행. 상위 담당자 독립 재실행은 별도.
- [x] 소스 ZIP allowlist/manifest/CRC/내용 해시 검증 및 새 디렉터리 npm ci→build→276 tests→12 E2E 재현. 테스트에 필요한 인증 없는 artifacts 2개만 예외 포함; .tools/.data/node_modules/실제 캐시 제외. 공개 배포 없음. SOURCE-DELIVERY.md 참조.

## 외부 검증 게이트

다음은 코드 테스트와 구별되며 사용자 입력·승인 또는 별도 환경이 필요하다.

- [ ] 실제 인증된 GitHub/GHE 계정의 /user 및 내 PR 목록. 공개 PR smoke는 이를 대체하지 않는다.
- [ ] 선택적인 실제 Jira endpoint/계정/필드 매핑 확인. 없거나 실패해도 PR 분석은 지속해야 한다.
- [ ] 실제 OS 격리가 통과하는 호스트에서 production launcher/native CLI와 TLS proxy의 양성 테스트. 현재 OCI namespace EPERM은 해결되지 않았으며 guard를 끄지 않는다.
- [ ] 사용자 승인 엔진 인증·모델·분석 PR·코드 전송 범위를 사용한 구조화 분석과 사람의 설명 품질 확인. 다른 서비스/Hermes 인증은 사용하지 않는다.
- [ ] macOS 네이티브 AI 실행은 현재 구현되지 않았다. Linux 전용 격리 모듈을 Mac 지원으로 표시하지 않는다.
- [ ] 사내 HTTPS proxy/SSO/특정 GHES·DC 버전의 실호환성은 개별 검증한다. 설정만 있다고 지원 완료로 표시하지 않는다.

외부 입력이 없으면 구현·fixture 검증 결과와 미검증 범위를 전달하고, 전체 완료라고 선언하지 않는다.
