# 개발 호스트 AI 격리 진단

직접 확인한 상태 (후속 구현 중 조회):
- `/proc/sys/kernel/unprivileged_userns_clone`: `1`
- `/proc/sys/kernel/apparmor_restrict_unprivileged_userns`: `1`
- `/proc/sys/user/max_user_namespaces`: `47309`
- 현재 도구 프로세스 AppArmor label: `unconfined`
- 현재 도구 프로세스 `CapEff`: `0000000000000000`, `NoNewPrivs`: `0`, `Seccomp`: `0`
- 실제 어댑터 probe는 bwrap namespace/loopback 생성 EPERM으로 실패하며 `runtimeVerified:false`다.

이 조합은 Ubuntu AppArmor의 비특권 user namespace 제한과 일치한다. 커널 감사 로그나 승인된 격리 프로세스 안에서의 재검증은 수행하지 않았으므로 유일한 원인이라고 단정하지 않는다. 제한이 꺼져 있다는 가정으로 앱을 변경하지 않는다.

Ubuntu 공식 설명은 AppArmor가 앱별로 userns 허용 여부를 결정할 수 있음을 설명한다:
https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces

상위 AppArmor의 제한된 bwrap 프로필 예시는 버전별 ABI/커널 기능에 의존한다:
https://gitlab.com/apparmor/apparmor/-/blob/master/profiles/apparmor/profiles/extras/bwrap-userns-restrict

현재 작업은 개발 코드 구현 범위다. 시스템 전역 sysctl을 끄거나 AppArmor 프로필을 추가·교체하거나 privileged container/root 실행으로 우회하지 않았다. 위 예시 프로필을 이 호스트에서 검증했다고 주장하지 않는다. 실제 실행 검증은 운영자가 승인한 namespace-capable 환경과 승인된 CLI 인증·모델을 필요로 한다. 전용 환경 또는 검토된 앱별 프로필이 마련되더라도 production launcher/native engine, TLS proxy 양성 경로, 대상 설정 자동 로드 차단, 자식 프로세스 종료를 실제로 재검증해야 한다.
