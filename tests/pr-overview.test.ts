import test from "node:test";
import assert from "node:assert/strict";
import { finalTreeChanges } from "../src/pr-overview";
import { objectFixture } from "./core-review-helpers";

test("overview final result excludes intermediate reverted changes and counts final tree paths", async (t) => {
  const f = objectFixture(t);
  const base = f.commit({
    "input.ts": "export const v = 1;\n",
    "old.ts": "export const old = true;\n",
  });
  const middle = f.commit(
    {
      "input.ts": "export const v = 2;\n",
      "old.ts": "export const old = true;\n",
      "temporary.ts": "export const temporary = true;\n",
    },
    [base],
  );
  const head = f.commit(
    {
      "input.ts": "export const v = 1;\n",
      "new.ts": "export const newer = true;\n",
    },
    [middle],
  );
  const snapshot = await f.collect(base, head);
  assert.deepEqual(
    finalTreeChanges(snapshot)?.sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: "new.ts", status: "추가" },
      { path: "old.ts", status: "삭제" },
    ],
  );
  assert.equal(
    finalTreeChanges({ ...snapshot, chosenComparisonBaseSha: null }),
    null,
  );
  assert.equal(
    finalTreeChanges({ ...snapshot, chosenComparisonBaseSha: middle }),
    null,
  );
});
