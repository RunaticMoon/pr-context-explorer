import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("실제 baseline + 세 커밋 tree, 원문, rename/delete/revert와 AST 근거", async () => {
  assert.ok(existsSync("src/server/git.ts"), "Git 수집기 구현 필요");
  const { collect } = await import("../src/server/git.ts");
  const s = collect();
  assert.equal(s.phases.length, 3);
  assert.notEqual(s.baseline.sha, s.headSha);
  assert.ok(s.baseline.files.length >= 6);
  assert.equal(s.phases[0].body, "");
  assert.equal(s.phases[1].parents[0], s.phases[0].sha);
  assert.match(
    s.phases[0].files.find((f) => f.path === "src/rules.ts")!.content,
    /trim/,
  );
  assert.ok(!s.baseline.files.some((f) => f.path === "src/rules.ts"));
  assert.ok(s.phases[1].files.some((f) => f.status === "renamed"));
  assert.ok(s.phases[1].files.some((f) => f.status === "deleted"));
  assert.equal(
    s.phases[2].files.find((f) => f.path === "src/config.ts")!.content,
    s.baseline.files.find((f) => f.path === "src/config.ts")!.content,
  );
  assert.ok(s.phases[2].edges.length >= 3);
  assert.ok(s.phases[2].diff.includes("@@"));
  assert.equal(
    s.phases[2].files.find((f) => f.path === "src/format.ts")!.id,
    s.baseline.files.find((f) => f.path === "src/legacy.ts")!.id,
  );
});
