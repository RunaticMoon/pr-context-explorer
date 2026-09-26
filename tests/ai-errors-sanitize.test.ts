import test from "node:test";
import assert from "node:assert/strict";
import { AIError } from "../src/server/ai/errors.ts";

const detailOf = (schemaErrors: unknown): AIError =>
  new AIError("schema_mismatch", {
    code: "schema_mismatch",
    schemaErrors,
  } as never);

test("schemaErrors keywords are mapped through the diagnostics allowlist", () => {
  const error = new AIError("schema_mismatch", {
    code: "schema_mismatch",
    schemaErrors: [
      { keyword: "required", instancePath: "/summary" },
      { keyword: "if", instancePath: "/a" },
      { keyword: "sk-test-canary-credential", instancePath: "/b" },
      { keyword: "pattern", instancePath: "/c" },
    ],
  } as never);
  assert.deepEqual(error.detail?.schemaErrors, [
    { keyword: "required", instancePath: "/summary" },
    { keyword: "other", instancePath: "/a" },
    { keyword: "other", instancePath: "/b" },
    { keyword: "pattern", instancePath: "/c" },
  ]);
  assert.equal(
    JSON.stringify(error.detail).includes("sk-test-canary-credential"),
    false,
  );
});

test("schemaErrors entries without string keyword or instancePath are dropped", () => {
  const error = detailOf([
    { keyword: 42, instancePath: "/a" },
    { keyword: "type" },
    "not-an-object",
    null,
    { keyword: "enum", instancePath: "/ok" },
  ]);
  assert.deepEqual(error.detail?.schemaErrors, [
    { keyword: "enum", instancePath: "/ok" },
  ]);
});

test("non-array schemaErrors produce no diagnostics", () => {
  for (const value of [undefined, null, {}, "required", 7])
    assert.equal(detailOf(value).detail?.schemaErrors, undefined);
});

test("schemaErrors instancePath is truncated to 160 characters", () => {
  const error = detailOf([
    { keyword: "type", instancePath: `/${"x".repeat(300)}` },
  ]);
  assert.equal(error.detail?.schemaErrors?.[0]?.instancePath.length, 160);
});

test("schemaErrors are capped at 8 diagnostics", () => {
  const error = detailOf(
    Array.from({ length: 12 }, (_, i) => ({
      keyword: "type",
      instancePath: `/p${i}`,
    })),
  );
  assert.equal(error.detail?.schemaErrors?.length, 8);
});

test("call_budget_exceeded is a first-class code with a fixed message", () => {
  const error = new AIError("call_budget_exceeded");
  assert.equal(error.code, "call_budget_exceeded");
  assert.equal(
    error.message,
    "The analysis call budget for this run was exhausted.",
  );
  assert.equal(error.detail, undefined);
});
