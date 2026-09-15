# 입력·출력 계약 및 검증 설계

이 문서는 구현용 설계 계약이다. 실행 가능한 완성 JSON Schema나 애플리케이션 코드는 아니다. 개발 단계에서 각 출력형에 대응하는 실제 JSON Schema, 런타임 타입, 검증 테스트를 생성한다. 모델에게 TypeScript 인터페이스만 보여주고 검증했다고 처리하지 않는다.

## 1. 앱과 AI의 책임 분리

앱이 생성하고 검증할 데이터:
- 연결·저장소·PR 식별자와 revision이 고정된 snapshotId.
- base/head SHA, merge-base 후보·선택 정책, commit parents.
- 파일의 존재·path·blob, diff/hunk, 실제 코드와 라인 구간.
- 명시적 Jira 원문과 키 발견 출처.
- 지원 언어의 정적 관계와 파서 버전.
- EvidenceRef ID, source hash, 사용자용 소스 링크.
- 그래프 좌표, 영속 ID, 캐시 키, 실행 상태, 사용량, 엔진 버전.

AI가 생성할 데이터:
- 출처에 기반한 의도·역할·동작 차이 설명.
- 변화의 기능적 묶음.
- 코드 근거에 대한 Jira 요구사항 매핑 제안.
- 추천 읽기 순서와 그 이유.
- 기존 노드·edge·hunk 중 강조할 대상.
- 명시적으로 inferred인 관계 제안.
- 불일치와 불확실성, 사람이 확인할 질문.

AI는 앱이 생성한 원본 사실을 수정하지 않는다. AI 출력에 없는 파일이나 단계가 있다고 해서 실제 데이터에서 삭제하지 않는다.

## 2. 입력 계약

### PullRequestSnapshot

필수 필드:
- snapshotId, connectionId, accountContextId, repositoryId, prNumber.
- baseRepositoryId, headRepositoryId, baseSha, headSha.
- mergeBaseShas, chosenComparisonBaseSha 또는 null, comparisonPolicy.
- prMetadataHash, jiraSnapshotHashes, capturedAt.
- commits와 수집 완전성.

headSha만으로 snapshot이 동일하다고 판단하지 않는다. PR 본문과 Jira 등 분석 근거가 바뀌면 새 분석 입력 버전이 필요하다.

### CommitPhase

필수 필드:
- phaseId, commitSha, parentShas, displayOrder.
- originalSubject, originalBody, originalMessage.
- comparisonFromSha, comparisonPolicy.
- fileStateRefs, diffHunkIds, sourceEvidenceIds.

커밋의 actual parents는 불변 사실이다. displayOrder는 UI용 순서일 뿐, 인접 항목 사이에 부모 관계를 만들지 않는다. root commit의 비교는 명시적인 empty-tree 정책을 사용한다. Baseline은 별도 타입으로 두어 원본 커밋 수에 포함하지 않는다.

### FileEntity / FileState

FileEntity는 탐색을 위한 논리적 ID와 확인된 rename 계보를 가진다. FileState는 해당 revision에서의 path, blobSha, 존재 여부, 언어, 변경 상태를 가진다. rename 근거가 애매하면 동일성을 확정하지 않고 별도 후보로 보존한다.

lineage는 저장소·snapshot에 종속될 수 있다. 서로 다른 계정이나 저장소의 같은 path를 같은 파일로 합치지 않는다.

### EvidenceRef

sourceKind별 판별 가능한 union으로 구현한다.

공통:
- id, sourceKind, snapshotId, sourceId, contentHash.
- 수집된 원문 또는 코드와 연결되는 내부 위치.

code/diff:
- repositoryId, revisionSha, path, blobSha(있으면), side(old/new/context).
- lineStart/lineEnd 또는 hunkId.
- 삭제 코드는 부모/old revision을, 추가 코드는 new revision을 참조한다.

pr/commit:
- 원문 resource 식별자와 version/hash.
- fieldPath 또는 원문 내 구간.

jira:
- Jira connection/host 식별자, issueId, issueKey.
- fetchedAt, updatedAt(제공되면), source hash.
- fieldPath와 원문 구간. ADF라면 JSON Pointer 등 안정적인 위치를 보존한다.

GitHub/Jira URL은 앱이 승인된 host와 실제 source로부터 구성한다. 모델이 조립한 임의 URL로 네트워크 요청하지 않는다.

### ContextBundle / Coverage

ContextBundle은 필요한 원문과 해당 evidenceIds, 파일/커밋 관계, 수집 상태를 포함한다. 전체 저장소를 매번 넣지 않는다.

Coverage는 다음을 구별한다.
- discovered: 존재를 확인한 대상.
- retrieved: 실제 내용을 확보한 대상.
- analyzed: 모델 또는 파서가 이번 작업에서 처리한 대상.
- omitted: 정책상 제외, 크기 제한, 바이너리, 미지원 언어 등과 그 이유.
- unavailable: 접근 권한, 이력 누락, 삭제된 fork, API 상한 등의 이유.

대상 전체 수가 알려지지 않으면 null로 표시한다. 추정 총계를 확정치로 생성하지 않는다.

## 3. 공통 출력 규칙

### AnalysisEnvelope

각 작업 출력은 다음 공통 필드를 가진다.
- schemaVersion: 앱이 제공한 계약 버전.
- snapshotId: 입력과 일치하는 snapshot.
- analysisStatus: complete / partial / insufficient_context.
- limitations: 구조화된 한계 목록.
- missingContext: 필요한 source 후보, 필요 이유, 예상 사용 목적.
- 작업별 payload.

analysisStatus는 분석 범위의 상태다. 프로세스 실행 succeeded/failed/cancelled, JSON 검증 통과 여부, 의미적 audit 결과와 분리한다.

앱이 나중에 붙일 값: runId, providerId, 실제 model/CLI 버전, startedAt/finishedAt, usage, cache metadata, deterministicValidation, semanticAudit. 모델에게 추정하게 하지 않는다.

### GroundedStatement

- text: 사용자에게 보여줄 한국어 설명.
- kind: observed / inferred / unknown.
- evidenceIds: 실제 입력의 근거 ID 배열.
- confidence: high / medium / low.
- limitation: 필요한 경우 한계 설명.

규칙:
- observed/inferred인 중요한 주장은 최소 하나의 관련 근거가 있어야 한다.
- unknown은 빈 evidenceIds를 허용하되 limitation을 요구한다.
- inferred는 관찰한 사실과 해석의 연결 이유를 설명한다.
- confidence는 모델 판단 강도다. 실제 검증 상태와 혼합하지 않는다.
- 일반적 제안이나 질문은 사실 주장과 구분하고, 관련 맥락 evidenceIds가 있으면 연결한다.

## 4. 작업별 payload

### PRAnalysisOutput

- overview: oneLiner, problem, statedIntent, inferredIntent, previousBehavior, newBehavior, strategy, nonGoals.
- changeGroups: groupId(제안용), title, purpose, fileIds, commitShas, evidenceIds.
- phaseSummaries: phaseId/commitSha와 GroundedStatement들.
- requirementMappings: 실제 requirementId, status, explanation, commitShas, fileIds, evidenceIds, testEvidenceIds.
- readingOutline: 추천 개념/파일 순서와 이유.
- discrepancies: 문서와 구현 또는 서로 다른 원문 간 불일치와 양쪽 근거.
- reviewQuestions: 질문, 이유, 관련 대상과 근거.

요구사항 매핑 상태:
- supported_by_code: 해당 요구를 지지하는 코드 근거를 찾음. 실행 검증 완료가 아님.
- partial_support: 일부 조건만 지지됨.
- not_demonstrated: 이번 범위에서 지지하는 구현을 찾지 못함.
- contradicted: 명시된 요구와 반대되는 근거가 있음.
- unknown: 판단할 자료가 부족함.

### PhaseExplanationOutput

- phaseId, commitSha, comparisonFromSha: 입력 값과 일치.
- displayTitle: AI 설명용 제목. 원문 subject를 대체하지 않음.
- before, changes, why, limitationsOfPhase: GroundedStatement들.
- focusFileIds, focusEdgeIds, focusHunkIds.
- nodeExplanations: 기존 fileId와 설명.
- requirementIds와 연결 설명.
- inferredEdgeSuggestions: 기존 fromFileId/toFileId, revisionSha, relationType, 설명, evidenceIds, confidence.
- reviewQuestions.

inferredEdgeSuggestions에는 정적 검증 완료 플래그를 허용하지 않는다. 수락 후 영속 ID와 스타일은 앱이 부여한다.

### GuidedTourOutput

- tourTitle, tourRevisionSha, audience, rationale.
- steps: 아래 TourStep 배열.
- storyEdges: 기존/제안 단계 ID 사이의 설명 순서.
- summary: 최종 이해와 미확인 사항.

TourStep:
- stepId, title, targetRevisionSha, comparisonFromSha 또는 null.
- prerequisiteStepIds, whyNow, previousConnection.
- explanation, beforeAfter, relationToGoal.
- focusFileIds, focusHunkIds, focusEvidenceIds, focusGraphEdgeIds.
- requirementIds, checkpointQuestions, nextTransition.

stepId는 한 출력 안에서 유일해야 한다. 단계 순서와 선행 관계는 순환이 없어야 한다. 모든 graph/file/hunk/evidence 참조는 target revision의 상태와 맞아야 한다. 그룹 이름만으로 실제 파일을 새로 만들지 않는다.

### CodeExplanationOutput

- fileId, targetRevisionSha, comparisonFromSha, selectedEvidenceIds.
- answerToQuestion: 질문이 있을 때 직접 답변.
- roleInPR, responsibility, inputsOutputs, behavior.
- beforeAfter, sideEffects, errorHandling.
- relationships: 제공된 정적 관계 또는 명시된 추정과 근거.
- requirementLinks, testEvidence, reviewQuestions.
- nextReadingSuggestions: 실제 대상 ID와 이유.

### EvidenceAuditOutput

- assessedJsonPointers.
- issues: targetJsonPointer, category, severity, reason, evidenceIds, recommendedAction.
- unableToVerify: 대상과 이유.
- scopeSummary: 이번 점검 범위.

“코드가 안전함”이나 “요구사항 완전 충족” 같은 전역 판정 필드는 두지 않는다.

## 5. 결정적 검증기

저장/표시 전에 다음을 확인한다.
1. JSON 구조, 필수 필드, enum, 추가 필드, 크기 제한.
2. 입력과 출력의 snapshotId/revision 일치.
3. 모든 파일·커밋·노드·edge·hunk·요구사항 ID의 존재와 허용된 범위.
4. EvidenceRef의 SHA/path/blob/side와 라인 구간의 실재 및 범위.
5. important observed/inferred 주장에 근거가 연결되었는지.
6. AI가 제공된 정적 관계를 조작하거나 추정 관계를 static으로 승격했는지.
7. 투어 ID 유일성과 선행 관계 비순환성.
8. unknown/partial/omitted 상태가 정상 완료인 것처럼 숨겨지지 않았는지.

실패 시 한정된 schema-repair 재시도 또는 오류/부분 상태로 처리한다. 잘못된 위치를 가장 가까운 코드에 몰래 연결하거나 없는 파일명을 임의로 비슷한 파일로 바꾸지 않는다.

라인이 실재한다는 것과 그 라인이 주장을 지지한다는 것은 다르다. 후자는 별도 의미적 점검 및 사람의 확인 대상이다.

## 6. 평가용 fixture

최소 fixture 집합:
- 3개 커밋이 요구사항/핵심 동작/테스트로 이어지는 작은 PR.
- PR 본문이 코드와 불일치하는 PR.
- Jira 없음, 다중 티켓, 접근 불가 티켓, 수용 기준 커스텀 필드.
- merge로 두 부모를 갖는 커밋, timestamp 순서와 부모 순서가 다른 이력.
- rename, delete, revert로 최종 순변경에서 사라진 파일.
- 같은 path가 다른 SHA에서 다른 내용을 갖는 파일.
- force-push와 PR/Jira 본문만 변경하는 경우.
- 언어 파서가 지원하지 않는 코드와 dynamic dispatch.
- 바이너리·generated 파일·누락 patch·API 상한.
- 악성 PR/Jira 지시, 설정 자동 로드 시도, symlink, 경로/명령/HTML 인젝션.

평가 질문은 “요약이 유창한가”보다 “왜 필요하고 어떻게 바뀌었는지 설명하는가, 추천 순서가 적절한가, 근거를 클릭하면 올바른 revision을 보는가”에 둔다.
