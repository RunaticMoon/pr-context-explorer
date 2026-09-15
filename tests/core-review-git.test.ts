import { test } from "node:test";
import assert from "node:assert/strict";
import type { LiveSnapshot } from "../src/server/live-git.ts";
import { objectFixture } from "./core-review-helpers.ts";
import { validateEvidence } from "../src/server/contract.ts";

function verifyUnique(s: LiveSnapshot) {
  for (const p of [s.baseline, ...s.phases])
    assert.equal(
      new Set(p.files.map((f) => f.id)).size,
      p.files.length,
      p.sha + ": unique identities including tombstones",
    );
  assert.equal(
    new Set(s.evidence.map((e) => e.id)).size,
    s.evidence.length,
    "unique evidence",
  );
  for (const e of s.evidence) validateEvidence(e, s as any);
}

test("rename then path reuse creates a fresh incarnation; later deletion and re-add stay distinct", async (t) => {
  const f = objectFixture(t);
  const base = f.commit({ "a.ts": "export const original=1;\n" });
  const renamed = f.commit(
    { "b.ts": "export const original=1;\n" },
    [base],
    "rename",
  );
  const reused = f.commit(
    {
      "a.ts": "export const different=2;\n",
      "b.ts": "export const original=1;\n",
    },
    [renamed],
    "reuse",
  );
  const deleted = f.commit(
    { "b.ts": "export const original=1;\n" },
    [reused],
    "delete",
  );
  const head = f.commit(
    { "a.ts": "export const third=3;\n", "b.ts": "export const original=1;\n" },
    [deleted],
    "readd",
  );
  const s = await f.collect(base, head);
  verifyUnique(s);
  const id = (sha: string, name: string) =>
    [s.baseline, ...s.phases]
      .find((p) => p.sha === sha)!
      .files.find((f) => f.path === name)!.id;
  assert.equal(id(base, "a.ts"), id(head, "b.ts"));
  assert.notEqual(id(base, "a.ts"), id(reused, "a.ts"));
  assert.notEqual(id(reused, "a.ts"), id(head, "a.ts"));
  assert.equal(id(reused, "a.ts"), id(deleted, "a.ts"));
});

test("branch traversal cannot leak retired paths or force ambiguous rename identities together", async (t) => {
  const f = objectFixture(t);
  const base = f.commit({ "a.ts": "export const original=1;\n" });
  const left = f.commit(
    { "b.ts": "export const original=1;\n" },
    [base],
    "left rename",
  );
  const right = f.commit(
    {
      "a.ts": "export const original=1;\n",
      "b.ts": "export const independent=2;\n",
    },
    [base],
    "independent right",
  );
  const head = f.commit(
    {
      "a.ts": "export const original=1;\n",
      "b.ts": "export const original=1;\n",
    },
    [left, right],
    "merge both paths",
  );
  const s = await f.collect(base, head);
  verifyUnique(s);
  const p = s.phases.find((p) => p.sha === head)!;
  assert.notEqual(p.files[0].id, p.files[1].id);
  assert.equal(
    p.files.find((f) => f.path === "b.ts")!.id,
    s.baseline.files[0].id,
  );
});
