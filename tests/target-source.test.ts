import { test } from "node:test";
import assert from "node:assert/strict";
import { collect } from "../src/server/git.ts";
test("대상 테스트는 실제 assertion 소스만 수집하고 실행하지 않음", () => {
  const s = collect();
  const f = s.phases[2].files.find((f) => f.path === "tests/input.test.ts")!;
  assert.match(f.content, /assert.deepEqual/);
  assert.match(f.content, /test\(/);
  assert.equal(s.coverage.targetTestsExecuted, false);
});
