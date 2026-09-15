import { type Snapshot } from "./git.ts";
import {
  type Analysis,
  type Statement,
  type CodeExplanation,
  validateAnalysis,
} from "./contract.ts";
export interface AIProvider {
  capability(): { id: string; available: boolean; reason: string };
  analyze(s: Snapshot, signal?: AbortSignal): Promise<Analysis>;
}
export class CodexProvider implements AIProvider {
  capability() {
    return {
      id: "Codex",
      available: false,
      reason:
        "데모 화면에서는 실행하지 않음 · 실제 PR 연결에서 CLI 탐지/인증/격리 확인",
    };
  }
  async analyze(_s: Snapshot): Promise<Analysis> {
    throw new Error(this.capability().reason);
  }
}
export class ClaudeCodeProvider extends CodexProvider {
  override capability() {
    return {
      id: "Claude Code",
      available: false,
      reason:
        "데모 화면에서는 실행하지 않음 · 실제 PR 연결에서 CLI 탐지/인증/격리 확인",
    };
  }
}
export class MockProvider implements AIProvider {
  capability() {
    return {
      id: "MockProvider",
      available: true,
      reason: "결정적 데모 설명 · 실제 AI 아님",
    };
  }
  async analyze(s: Snapshot, signal?: AbortSignal): Promise<Analysis> {
    signal?.throwIfAborted();
    const statements: Statement[] = [s.baseline, ...s.phases].map((p, i) => ({
      text: [
        "기존 processInput은 정규화 없이 format 결과를 반환합니다.",
        "입력의 앞뒤 공백 제거와 빈 문자열 오류 규칙이 추가되었습니다. 이 단계의 processInput에는 아직 연결되지 않았습니다.",
        "processInput이 normalize를 import하고 정규화 후 format을 적용하며 오류를 Result로 변환합니다.",
        "공백·빈 입력 예제가 추가되고 DEBUG 설정은 baseline 값으로 되돌아갔습니다. 대상 테스트는 실행하지 않았습니다.",
      ][i],
      kind: "observed",
      evidenceIds: s.evidence
        .filter(
          (e) =>
            e.commitSha === p.sha &&
            e.side === "new" &&
            [
              i === 1
                ? "src/rules.ts"
                : i === 3
                  ? "tests/input.test.ts"
                  : "src/process.ts",
              "src/config.ts",
            ].includes(e.path) &&
            e.lineStart === 1,
        )
        .map((e) => e.id),
      confidence: "high",
      limitation: "고정 예제 설명. 의미적 자동 감사 미수행.",
      commitSha: p.sha,
    }));
    const titles = [
      "요구사항과 입력 계약",
      "처리 연결과 오류 결과",
      "경계 예제와 영향 확인",
    ];
    const paths = [
      ["src/rules.ts", "src/process.ts"],
      ["src/process.ts", "src/format.ts", "src/types.ts"],
      ["tests/input.test.ts", "src/config.ts"],
    ];
    const steps = paths.map((ps, i) => ({
      id: "step-" + i,
      title: titles[i],
      why: [
        "파일명보다 입력 계약을 먼저 알아야 처리 정책을 이해할 수 있습니다.",
        "규칙을 알았으므로 호출 지점에서 오류가 어떻게 결과로 바뀌는지 읽습니다.",
        "구현 뒤 경계 예제를 읽어 검증되지 않은 부분을 구분합니다.",
      ][i],
      previous: i
        ? titles[i - 1] + "에서 확인한 내용을 연결합니다."
        : "선행 개념: 모의 Jira DEMO-1의 수용 기준",
      next:
        i < 2
          ? titles[i + 1] + "에서 영향 범위를 확인합니다."
          : "실제 테스트 실행과 제품 요구사항 검증은 별도 승인된 작업입니다.",
      question: [
        "공백만 있는 입력을 거부하는 정책이 맞나요?",
        "모든 예외를 같은 오류 결과로 처리해도 되나요?",
        "유니코드 공백과 긴 입력의 예제가 더 필요한가요?",
      ][i],
      beforeAfter: [
        "직접 포맷 → trim 및 빈 입력 검사",
        "항상 성공 → 오류 시 ok:false",
        "단일 예제 → 정상/공백 경계 예제; 실행 결과 아님",
      ][i],
      revisionSha: s.headSha,
      comparisonFromSha: s.phases.at(-1)!.comparisonFromSha!,
      fileIds: s.phases
        .at(-1)!
        .files.filter((f) => ps.includes(f.path))
        .map((f) => f.id),
      evidenceIds: s.evidence
        .filter(
          (e) =>
            e.commitSha === s.headSha &&
            e.side === "new" &&
            ps.includes(e.path) &&
            e.lineStart === 1 &&
            e.lineEnd > 1,
        )
        .map((e) => e.id),
      prerequisites: i ? ["step-" + (i - 1)] : [],
      requirementIds: [s.jira.key],
    }));
    const codeExplanations: CodeExplanation[] = s.evidence
      .filter(
        (e) =>
          e.lineStart === 1 &&
          ![s.baseline, ...s.phases]
            .flatMap((p) => p.edges)
            .some((edge) => edge.evidenceId === e.id),
      )
      .map((e) => {
        const p = [s.baseline, ...s.phases].find((p) => p.sha === e.commitSha)!;
        const f = p.files.find((f) => f.id === e.fileId)!;
        const content = e.side === "old" ? f.oldContent! : f.content;
        let role = "문맥용 원문",
          inputsOutputs = "이 범위에 함수 입출력 계약 없음",
          behavior = "표시된 원문을 그대로 확보했습니다.",
          errors = "이 범위에서 오류 처리 판단 안 함",
          sideEffects = "실행하지 않음; 런타임 영향 확인 안 함";
        if (e.path.endsWith("/rules.ts")) {
          role = "DEMO-1 입력 정책: normalize";
          inputsOutputs = "string → 정규화된 string";
          behavior = "trim으로 앞뒤 공백을 제거합니다.";
          errors = "빈 결과는 empty input Error를 throw합니다.";
          sideEffects = "이 함수 본문에 외부 I/O 없음.";
        } else if (e.path.endsWith("/process.ts")) {
          role = "입력 정책과 포맷을 Result로 연결하는 processInput";
          inputsOutputs = "string → Result { ok:boolean, value:string }";
          behavior = content.includes("normalize")
            ? "normalize 후 format 결과를 반환합니다."
            : "정규화 없이 format 결과를 반환합니다.";
          errors = content.includes("catch")
            ? "catch에서 ok:false, 빈 value 결과를 반환합니다."
            : "catch 없음; 예외 변환이 이 본문에 없습니다.";
          sideEffects =
            "본문에 외부 I/O 없음. import만으로 실제 실행 순서를 증명하지 않습니다.";
        } else if (
          e.path.endsWith("/format.ts") ||
          e.path.endsWith("/legacy.ts")
        ) {
          role = "출력 포맷 format (rename 계보 보존)";
          inputsOutputs = "string → string";
          behavior = "toUpperCase 결과를 반환합니다.";
          errors = "명시적 오류 처리 없음";
          sideEffects = "본문에 외부 I/O 없음.";
        } else if (e.path.startsWith("tests/")) {
          role = "입력 경계 예제 · 실행 결과 아님";
          inputsOutputs = "예제 문자열 → processInput 결과 예시";
          behavior = content.includes("cases")
            ? "정상/공백 예제 cases를 선언합니다."
            : "단일 hello 예제를 선언합니다.";
          errors =
            "node:test와 assert.deepEqual 검증 소스가 있으나 실행 결과는 확보하지 않았습니다.";
          sideEffects = "대상 모듈을 실행하지 않았습니다.";
        } else if (e.path.endsWith("/config.ts")) {
          role = "디버그 설정의 중간 변경과 되돌림";
          inputsOutputs = "boolean 상수";
          behavior = content.includes("true")
            ? "DEBUG = true (중간 상태)"
            : "DEBUG = false";
          errors = "상수 선언, 오류 처리 없음";
          sideEffects = "이 상수의 실제 사용은 확인하지 않음.";
        } else if (e.path.endsWith("/types.ts")) {
          role = "처리 결과 Result 타입 계약";
          inputsOutputs = "ok:boolean, value:string 타입 필드";
          behavior = "정적 타입 선언이며 런타임 검증기가 아닙니다.";
          errors = "타입 선언에 오류 처리 없음";
          sideEffects = "타입만 선언.";
        } else if (e.path.endsWith("/main.ts")) {
          role = "processInput 연결 문맥";
          inputsOutputs = "string 입력을 processInput으로 전달";
          behavior = "run 함수 선언";
          errors = "명시적 catch 없음";
          sideEffects = "실제 실행하지 않음.";
        }
        return {
          evidenceId: e.id,
          role,
          inputsOutputs,
          behavior,
          errors,
          sideEffects,
          kind: "observed",
          limitation:
            "고정 fixture MockProvider 설명; 이 근거의 revision/side에만 적용. 의미 감사 미수행.",
        };
      });
    const a: Analysis = {
      schemaVersion: "1",
      snapshotId: s.snapshotId,
      provider: "MockProvider",
      analysisStatus: "partial",
      limitations: [
        "실제 GitHub/Jira/AI 미연결",
        "정적 import만 분석; 호출 실행 순서 아님",
        "대상 테스트/CI 실행 안 함",
        "의미적 근거 감사 미수행",
      ],
      missingContext: ["실제 수용 기준 검증과 CI 결과"],
      semanticAudit: "not_performed",
      statements,
      steps,
      codeExplanations,
    };
    validateAnalysis(a, s);
    return a;
  }
}
