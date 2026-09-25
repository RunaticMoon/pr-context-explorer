import Ajv from "ajv";
import type {
  SchemaDiagnostic,
  ValidationReasonCode,
} from "../../ai-contract.ts";
import { safeSchemaErrors } from "../ai/diagnostics.ts";
export const text = { type: "string", minLength: 1, maxLength: 6000 };
export const id = { type: "string", minLength: 1, maxLength: 512 };
export const list = (items: unknown, maxItems = 100, minItems = 0) => ({
  type: "array",
  items,
  minItems,
  maxItems,
});
export const ids = list(id);
export const object = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
export const groundedStatementSchema = {
  ...object({
    text: { ...text, pattern: "\\S" },
    kind: { enum: ["observed", "inferred", "unknown"] },
    evidenceIds: { ...ids, uniqueItems: true },
    confidence: { enum: ["high", "medium", "low"] },
    rationale: { type: "string", maxLength: 6000 },
    limitation: { type: "string", maxLength: 6000 },
  }),
  anyOf: [
    {
      properties: {
        kind: { const: "observed" },
        evidenceIds: { type: "array", minItems: 1 },
      },
    },
    {
      properties: {
        kind: { const: "inferred" },
        evidenceIds: { type: "array", minItems: 1 },
        rationale: { type: "string", pattern: "\\S" },
      },
    },
    {
      properties: {
        kind: { const: "unknown" },
        limitation: { type: "string", pattern: "\\S" },
      },
    },
  ],
};
const check = new Ajv({ strict: true, allErrors: true }).compile(
  groundedStatementSchema,
);
export class ValidationError extends Error {
  readonly reasonCode: ValidationReasonCode;
  readonly schemaErrors?: SchemaDiagnostic[];
  constructor(
    reasonCode: ValidationReasonCode,
    schemaErrors?: SchemaDiagnostic[],
  ) {
    super(reasonCode);
    this.name = "ValidationError";
    this.reasonCode = reasonCode;
    if (schemaErrors) this.schemaErrors = schemaErrors;
  }
}
const REASON_BY_MESSAGE: ReadonlyMap<string, ValidationReasonCode> = new Map([
  ["statement text", "statement_evidence_required"],
  [
    "statement requires evidence or unknown limitation",
    "statement_evidence_required",
  ],
  ["inference rationale required", "inference_rationale_required"],
  ["duplicate evidence", "duplicate_reference"],
  ["evidence outside transmitted context", "evidence_outside_context"],
  ["phase outside transmitted context", "phase_outside_context"],
  [
    "file outside transmitted context/revision",
    "file_outside_context",
  ],
  [
    "test/CI execution claim has no execution evidence",
    "execution_claim_forbidden",
  ],
  [
    "partial/insufficient context requires limitation",
    "unknown_limitation_required",
  ],
  ["snapshot mismatch", "revision_mismatch"],
  ["revision comparison", "revision_mismatch"],
  ["source commit revision", "revision_mismatch"],
  ["evidence snapshot/commit", "revision_mismatch"],
  ["evidence comparison", "revision_mismatch"],
  ["evidence revision", "revision_mismatch"],
  ["source hash/snapshot", "revision_mismatch"],
  ["source PR field/version/identity", "revision_mismatch"],
  ["source commit", "revision_mismatch"],
  ["Jira source version/field/content", "revision_mismatch"],
  ["context snapshot", "revision_mismatch"],
  ["context source hashes", "revision_mismatch"],
  ["context phase metadata", "revision_mismatch"],
  ["head tour revision", "revision_mismatch"],
  ["default step must target head", "revision_mismatch"],
  [
    "primary reading evidence must be live head/new code",
    "revision_mismatch",
  ],
  ["historical tour must return to head", "revision_mismatch"],
  ["evidence file", "file_outside_context"],
  ["evidence new path/blob/existence", "file_outside_context"],
  ["evidence old path/blob", "file_outside_context"],
  ["parent evidence mapping", "file_outside_context"],
  ["graph outside transmitted revision/files", "file_outside_context"],
  [
    "hunk outside transmitted revision/comparison/files",
    "file_outside_context",
  ],
  ["tour file needs own code evidence", "file_outside_context"],
  [
    "evidence target revision/file/comparison",
    "evidence_outside_context",
  ],
  ["source not supplied by snapshot", "evidence_outside_context"],
  ["context graph proof", "evidence_outside_context"],
  ["selected code evidence unavailable", "evidence_outside_context"],
  ["mapping evidence target", "evidence_outside_context"],
  ["test source evidence", "evidence_outside_context"],
  ["code selected evidence", "evidence_outside_context"],
  [
    "test evidence must be code, not test execution",
    "evidence_outside_context",
  ],
  ["next reading code proof", "evidence_outside_context"],
  ["tour code proof", "evidence_outside_context"],
  [
    "old reading evidence must be secondary before/after comparison",
    "evidence_outside_context",
  ],
  ["inferred edge collides with static graph", "duplicate_reference"],
  ["requirement statement source proof", "statement_evidence_required"],
  [
    "discrepancy explanation requires both conflicting IDs",
    "statement_evidence_required",
  ],
  [
    "requirement code and source support",
    "statement_evidence_required",
  ],
  [
    "stated intent requires original source",
    "statement_evidence_required",
  ],
  ["chunk taskId mismatch", "task_id_mismatch"],
  ["tourId mismatch", "tour_id_mismatch"],
  [
    "explicit provider/model and trusted server runner required",
    "runner_identity_mismatch",
  ],
  [
    "runner engine mismatch/fallback forbidden",
    "runner_identity_mismatch",
  ],
  ["audit snapshot", "audit_reference_invalid"],
  [
    "audit target must be an actual grounded statement JSON pointer",
    "audit_reference_invalid",
  ],
  ["audit issue must be assessed", "audit_reference_invalid"],
  [
    "audit evidence outside transmitted context",
    "audit_reference_invalid",
  ],
  ["audit failure requires evidence proof", "audit_reference_invalid"],
  ["audit assessed/unable conflict", "audit_reference_invalid"],
]);
const REASON_BY_PREFIX: readonly (readonly [
  string,
  ValidationReasonCode,
])[] = [
  ["duplicate ", "duplicate_reference"],
  ["statement schema:", "output_schema_mismatch"],
  ["output schema:", "output_schema_mismatch"],
  ["audit schema:", "output_schema_mismatch"],
];
export function reasonCodeFor(message: string): ValidationReasonCode {
  const reason = REASON_BY_MESSAGE.get(message);
  if (reason) return reason;
  for (const [prefix, code] of REASON_BY_PREFIX)
    if (message.startsWith(prefix)) return code;
  return "validation_failed";
}
export function requireValid(
  ok: unknown,
  message: string,
  reason?: ValidationReasonCode,
): asserts ok {
  if (!ok) throw new ValidationError(reason ?? reasonCodeFor(message));
}
export function validateGroundedStatement(
  value: unknown,
  allowedEvidenceIds: ReadonlySet<string>,
): void {
  if (!check(value))
    throw new ValidationError(
      "output_schema_mismatch",
      safeSchemaErrors(check.errors, groundedStatementSchema),
    );
  const x = value as import("./types.ts").GroundedStatement;
  requireValid(
    x.text.trim(),
    "statement text",
    x.kind === "unknown"
      ? "unknown_limitation_required"
      : "statement_evidence_required",
  );
  requireValid(
    x.kind === "unknown" ? x.limitation.trim() : x.evidenceIds.length,
    "statement requires evidence or unknown limitation",
    x.kind === "unknown"
      ? "unknown_limitation_required"
      : "statement_evidence_required",
  );
  requireValid(
    x.kind !== "inferred" || x.rationale.trim(),
    "inference rationale required",
  );
  requireValid(
    new Set(x.evidenceIds).size === x.evidenceIds.length,
    "duplicate evidence",
  );
  requireValid(
    x.evidenceIds.every((e) => allowedEvidenceIds.has(e)),
    "evidence outside transmitted context",
  );
  // Shared by every stage, including all optional audit reasons/scopeSummary.
  // This is the existing narrow execution-claim guard, not semantic validation.
  if (x.kind !== "unknown")
    requireValid(
      !/\b(?:all tests passed|tests? (?:have )?passed|CI (?:is )?(?:green|passed))\b|테스트(?:가|는)?\s*(?:모두\s*)?통과(?:했습니다|했다|했음|하였다|함)/i.test(
        x.text,
      ),
      "test/CI execution claim has no execution evidence",
    );
}
