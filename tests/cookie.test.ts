import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("세션 토큰 파서는 고정 길이 hex 외 입력 거부", async () => {
  assert.ok(existsSync("src/server/session.ts"), "세션 경계 파서 필요");
  const { validToken } = await import("../src/server/session.ts");
  assert.equal(validToken("é".repeat(64)), false);
  assert.equal(validToken("a".repeat(63)), false);
  assert.equal(validToken("a".repeat(64)), true);
  assert.equal(validToken("0".repeat(64) + ";"), false);
});
