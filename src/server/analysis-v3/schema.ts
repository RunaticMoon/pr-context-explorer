import Ajv from "ajv";
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
export function requireValid(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
export function validateGroundedStatement(
  value: unknown,
  allowedEvidenceIds: ReadonlySet<string>,
): void {
  requireValid(
    check(value),
    "statement schema: " + JSON.stringify(check.errors),
  );
  const x = value as import("./types.ts").GroundedStatement;
  requireValid(x.text.trim(), "statement text");
  requireValid(
    x.kind === "unknown" ? x.limitation.trim() : x.evidenceIds.length,
    "statement requires evidence or unknown limitation",
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
