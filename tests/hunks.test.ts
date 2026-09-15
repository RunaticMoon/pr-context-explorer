import { test } from "node:test";
import assert from "node:assert/strict";
import { collect } from "../src/server/git.ts";
test("각 hunk는 실제 path/old/new 범위 및 SHA를 보존", () => {
  const s = collect();
  const h: any = s.phases[0].hunks.find(
    (h: any) => h.newPath === "src/rules.ts",
  );
  assert.ok(h, "파일별 hunk 위치 필요");
  assert.equal(h.oldStart, 0);
  assert.equal(h.oldCount, 0);
  assert.equal(h.newStart, 1);
  assert.equal(h.newCount, 5);
  assert.equal(h.newSha, s.phases[0].sha);
  assert.equal(h.oldSha, s.baseSha);
  assert.match(h.text, /empty input/);
});
