import Ajv from "ajv";
import type {
  AuditOutput,
  ContextBundle,
  SemanticAudit,
  V3Output,
} from "./types.ts";
import {
  groundedStatementSchema,
  id,
  ids,
  list,
  object,
  requireValid,
  validateGroundedStatement,
} from "./schema.ts";
import { bytes, digest, unique } from "./evidence.ts";
import { collectStatements } from "./validate.ts";
const gs = { $ref: "#/$defs/statement" };
export const auditOutputSchema = {
  ...object({
    schemaVersion: { const: "3" },
    snapshotId: id,
    assessedJsonPointers: list(id, 2000),
    issues: list(
      object({
        targetJsonPointer: id,
        category: {
          enum: [
            "unsupported_claim",
            "wrong_revision",
            "source_code_conflict",
            "static_promotion",
            "execution_claim",
            "overclaim",
            "other",
          ],
        },
        severity: { enum: ["low", "medium", "high"] },
        reason: gs,
        evidenceIds: ids,
        action: { enum: ["reject", "downgrade", "needs_context"] },
      }),
    ),
    unableToVerify: list(object({ targetJsonPointer: id, reason: gs }), 2000),
    scopeSummary: gs,
  }),
  $defs: { statement: groundedStatementSchema },
};
const check = new Ajv({ strict: true, allErrors: true }).compile(
  auditOutputSchema,
);
export function validateAuditOutput(
  value: unknown,
  candidate: V3Output,
  context: ContextBundle,
): asserts value is AuditOutput {
  requireValid(
    bytes(value) <= 180000 && check(value),
    "audit schema: " + JSON.stringify(check.errors),
  );
  const a = value as AuditOutput;
  requireValid(a.snapshotId === candidate.snapshotId, "audit snapshot");
  const pointers = new Set(collectStatements(candidate).map((x) => x.pointer)),
    allowed = new Set([
      ...context.code.map((x) => x.evidence.id),
      ...context.sources.map((e) => e.id),
    ]);
  unique(a.assessedJsonPointers, "assessed pointers");
  unique(
    a.unableToVerify.map((x) => x.targetJsonPointer),
    "unable pointers",
  );
  for (const pointer of [
    ...a.assessedJsonPointers,
    ...a.issues.map((x) => x.targetJsonPointer),
    ...a.unableToVerify.map((x) => x.targetJsonPointer),
  ])
    requireValid(
      pointers.has(pointer),
      "audit target must be an actual grounded statement JSON pointer",
    );
  for (const issue of a.issues) {
    requireValid(
      a.assessedJsonPointers.includes(issue.targetJsonPointer),
      "audit issue must be assessed",
    );
    requireValid(
      issue.evidenceIds.every((id) => allowed.has(id)),
      "audit evidence outside transmitted context",
    );
    if (issue.action !== "needs_context")
      requireValid(
        issue.evidenceIds.length,
        "audit failure requires evidence proof",
      );
  }
  requireValid(
    a.unableToVerify.every(
      (x) => !a.assessedJsonPointers.includes(x.targetJsonPointer),
    ),
    "audit assessed/unable conflict",
  );
  for (const { statement } of collectStatements(a))
    validateGroundedStatement(statement, allowed);
}
const unknown = (text: string) => ({
  text,
  kind: "unknown" as const,
  evidenceIds: [],
  confidence: "low" as const,
  rationale: "",
  limitation: text,
});
/** Retain the original disputed claim only as an audit disposition, never as an observed display claim. */
export function applySemanticAudit(
  candidate: V3Output,
  audit: AuditOutput,
): { output: V3Output; semanticAudit: SemanticAudit } {
  const output = structuredClone(candidate),
    a = structuredClone(audit),
    statements = new Map(
      collectStatements(output).map((x) => [x.pointer, x.statement]),
    );
  const accounted = new Set([
    ...a.assessedJsonPointers,
    ...a.unableToVerify.map((x) => x.targetJsonPointer),
  ]);
  for (const pointer of statements.keys())
    if (!accounted.has(pointer))
      a.unableToVerify.push({
        targetJsonPointer: pointer,
        reason: unknown(
          "이 중요한 설명은 선택적 의미 점검에서 확인되지 않았다.",
        ),
      });
  const semanticAudit: SemanticAudit = {
    status: a.issues.some((i) => i.action === "reject")
      ? "rejected"
      : "performed",
    output: a,
    originalCandidateHash: digest(JSON.stringify(candidate)),
    dispositions: [],
  };
  if (semanticAudit.status === "rejected") return { output, semanticAudit };
  for (const issue of a.issues) {
    const statement = statements.get(issue.targetJsonPointer)!;
    semanticAudit.dispositions!.push({
      targetJsonPointer: issue.targetJsonPointer,
      action: issue.action,
      original: structuredClone(statement),
    });
    statement.kind = "unknown";
    statement.confidence = "low";
    statement.rationale = "";
    statement.limitation = "의미 점검에서 보류: " + issue.reason.text;
    if (issue.action === "needs_context")
      output.missingContext.push({
        target: issue.targetJsonPointer,
        reason: issue.reason,
        purpose: unknown("보류된 설명을 원문 근거로 재검토하기 위한 추가 문맥"),
      });
    const mapping = issue.targetJsonPointer.match(
      /^\/requirementMappings\/(\d+)\//,
    );
    if (mapping)
      output.requirementMappings[Number(mapping[1])].status = "unknown";
  }
  if (a.issues.length || a.unableToVerify.length) {
    if (output.analysisStatus === "complete") output.analysisStatus = "partial";
    output.limitations.push(
      unknown(
        `의미 점검: 문제 ${a.issues.length}건, 미확인 ${a.unableToVerify.length}건. 이 결과는 코드 안전성 판정이 아니다.`,
      ),
    );
  }
  return { output, semanticAudit };
}
