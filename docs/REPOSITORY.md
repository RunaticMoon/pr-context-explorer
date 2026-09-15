# Git 저장소 관리

프로젝트 소스의 관리 원본은 Git checkout이다. ZIP은 이전 전달본 또는 선택적인 export일 뿐이며, 이후 변경은 commit/push로 관리한다.

- 로컬 개발 checkout: `/home/ubuntu/development/pr-context-explorer`
- 개인 원격: `https://github.com/RunaticMoon/pr-context-explorer.git`
- 기본 브랜치: `main`
- 공개 범위: **private**. 2026-09-15 GitHub API readback으로 확인했다.

사용자가 저장소를 생성하고 PAT 권한을 조정한 뒤 초기 커밋 `f999ce62972aed3e4cc946330cdcbdd1936723bd`를 `main`에 push했다. 원격 main SHA와 로컬 커밋 일치, private 가시성을 다시 조회해 확인했다. 이후 변경도 commit/push로 관리한다.

## 추적 범위

소스, 테스트, 실행 스크립트, 문서, 업로드된 요구사항 reference, 의존성 lock을 추적한다. 테스트에서 사용하는 인증 없는 CLI help 기록과 Jira 통합 예제 두 파일만 artifacts에서 예외적으로 추적한다.

`.tools`, `.data`, `node_modules`, 빌드 결과, 실수집 캐시, 테스트 캡처·로그, `.env`, credential 디렉터리, private key/인증서 및 ZIP은 기본 제외한다. 실제 인증은 저장소 밖에 둔다. `.gitignore`는 내용 기반 secret scanner가 아니므로 commit 전 staged 파일을 검토한다.

```bash
git status
git diff
git add -- <수정한-소스-파일>
git diff --cached
git commit -m "설명"
git push origin main
```

서비스 배포·실행 경로는 개발 checkout과 구별한다. Git push만으로 대상 PR/Jira나 실행 중인 서비스를 변경하지 않는다.
