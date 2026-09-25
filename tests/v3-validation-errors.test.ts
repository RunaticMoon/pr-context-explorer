import test from "node:test";
import assert from "node:assert/strict";
import { VALIDATION_REASON_CODES } from "../src/ai-contract.ts";
import {
  ValidationError,
  reasonCodeFor,
  requireValid,
  validateGroundedStatement,
} from "../src/server/analysis-v3/schema.ts";

const KNOWN_CODES = new Set<string>(VALIDATION_REASON_CODES);
const observed = {
  text: "The parser streams tokens from the worker.",
  kind: "observed" as const,
  evidenceIds: ["ev-1"],
  confidence: "high" as const,
  rationale: "",
  limitation: "",
};

test("reasonCodeFor maps every registered fixed phrase to its reason code", () => {
  const cases: [string, string][] = [
    ["statement text", "statement_evidence_required"],
    [
      "statement requires evidence or unknown limitation",
      "statement_evidence_required",
    ],
    ["inference rationale required", "inference_rationale_required"],
    ["duplicate evidence", "duplicate_reference"],
    ["evidence outside transmitted context", "evidence_outside_context"],
    ["phase outside transmitted context", "phase_outside_context"],
    ["file outside transmitted context/revision", "file_outside_context"],
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
    ["evidence target revision/file/comparison", "evidence_outside_context"],
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
    ["requirement code and source support", "statement_evidence_required"],
    ["stated intent requires original source", "statement_evidence_required"],
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
  ];
  for (const [message, expected] of cases) {
    assert.equal(reasonCodeFor(message), expected, message);
    assert.ok(KNOWN_CODES.has(expected), expected);
  }
});

test("reasonCodeFor covers dynamically composed messages by prefix", () => {
  for (const label of [
    "reference IDs",
    "file references",
    "requirement IDs",
    "context evidence IDs",
    "assessed pointers",
  ])
    assert.equal(
      reasonCodeFor("duplicate " + label),
      "duplicate_reference",
      label,
    );
  for (const prefix of [
    "statement schema:",
    "output schema:",
    "audit schema:",
  ])
    assert.equal(
      reasonCodeFor(prefix + ' [{"instancePath":"/x","data":"raw"}]'),
      "output_schema_mismatch",
      prefix,
    );
});

test("unregistered phrases collapse to validation_failed without leaking text", () => {
  for (const message of [
    "",
    "output byte limit",
    "stage context byte limit",
    "omitted context cannot be complete",
    "unknown requirement ID",
    "explicit acceptance criteria require mapped AC source",
    "selected code range",
    "cache TTL must be finite <= 24h",
    "invalid finite budget: maxCalls",
    "audit candidate",
    "audit original evidence unavailable",
    "arbitrary provider detail 0xDEAD",
  ])
    assert.equal(reasonCodeFor(message), "validation_failed", message);
});

test("requireValid throws ValidationError with mapped reason, message is the code only", () => {
  assert.throws(
    () => requireValid(false, "inference rationale required"),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.ok(error instanceof Error);
      assert.equal(error.reasonCode, "inference_rationale_required");
      assert.equal(error.message, "inference_rationale_required");
      assert.equal(error.name, "ValidationError");
      assert.equal(error.schemaErrors, undefined);
      return true;
    },
  );
});

test("requireValid explicit reason argument wins over the message mapping", () => {
  assert.throws(
    () => requireValid(false, "statement text", "unknown_limitation_required"),
    (error) =>
      error instanceof ValidationError &&
      error.reasonCode === "unknown_limitation_required",
  );
});

test("requireValid unregistered message still throws a coded ValidationError", () => {
  assert.throws(
    () => requireValid(false, "raw internal detail must not surface"),
    (error) =>
      error instanceof ValidationError &&
      error.reasonCode === "validation_failed" &&
      error.message === "validation_failed",
  );
});

test("requireValid remains an assertion on truthy input", () => {
  assert.doesNotThrow(() => requireValid(true, "statement text"));
  assert.doesNotThrow(() => requireValid("non-empty", "statement text"));
});

test("validateGroundedStatement accepts well-formed observed and unknown statements", () => {
  assert.doesNotThrow(() =>
    validateGroundedStatement(observed, new Set(["ev-1"])),
  );
  assert.doesNotThrow(() =>
    validateGroundedStatement(
      {
        text: "Ownership of this path could not be determined.",
        kind: "unknown",
        evidenceIds: [],
        confidence: "low",
        rationale: "",
        limitation: "No transmitted evidence covers it.",
      },
      new Set(["ev-1"]),
    ),
  );
});

test("statement schema violations expose structural diagnostics only", () => {
  const forged = {
    ...observed,
    kind: "SECRET-KIND-VALUE",
    injected: "SECRET-PROP-VALUE",
  };
  try {
    validateGroundedStatement(forged, new Set(["ev-1"]));
    assert.fail("must reject");
  } catch (error) {
    assert.ok(error instanceof ValidationError);
    assert.ok(error instanceof Error);
    assert.equal(error.reasonCode, "output_schema_mismatch");
    assert.equal(error.message, "output_schema_mismatch");
    assert.ok(!error.message.includes("SECRET"));
    assert.ok(!error.message.includes("instancePath"));
    assert.ok(Array.isArray(error.schemaErrors));
    assert.ok(error.schemaErrors!.length > 0);
    for (const diagnostic of error.schemaErrors!) {
      assert.deepEqual(Object.keys(diagnostic).sort(), [
        "instancePath",
        "keyword",
      ]);
      assert.equal(typeof diagnostic.keyword, "string");
      assert.equal(typeof diagnostic.instancePath, "string");
      assert.ok(!diagnostic.keyword.includes("SECRET"));
      assert.ok(!diagnostic.instancePath.includes("SECRET"));
    }
  }
});

test("evidence outside the transmitted context carries a typed reason", () => {
  assert.throws(
    () => validateGroundedStatement(observed, new Set(["other-evidence"])),
    (error) =>
      error instanceof ValidationError &&
      error.reasonCode === "evidence_outside_context" &&
      error.schemaErrors === undefined,
  );
});

test("test/CI execution claims without execution evidence are forbidden", () => {
  assert.throws(
    () =>
      validateGroundedStatement(
        { ...observed, text: "All tests passed for this change." },
        new Set(["ev-1"]),
      ),
    (error) =>
      error instanceof ValidationError &&
      error.reasonCode === "execution_claim_forbidden",
  );
});
