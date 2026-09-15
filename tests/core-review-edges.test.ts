import { test } from "node:test";
import assert from "node:assert/strict";
import { objectFixture } from "./core-review-helpers.ts";
import { buildContext } from "../src/server/live-analysis.ts";
import { validateEvidence } from "../src/server/contract.ts";

test("model receives actual import edge IDs and bounded evidence, not an implicit full-file claim", async (t) => {
  const f = objectFixture(t);
  const base = f.commit({ "a.ts": "export const value=1;\n" });
  const content =
    'import {\n  value\n} from "./a";\nexport const result=value;\n';
  const head = f.commit(
    { "a.ts": "export const value=1;\n", "b.ts": content },
    [base],
  );
  const s = await f.collect(base, head),
    context = buildContext(s, { kind: "pr" });
  const edge = s.phases[0].edges[0];
  assert.ok(edge);
  assert.deepEqual(
    context.phases.flatMap((p) => p.edges).map((e) => e.id),
    [edge.id],
  );
  const e = context.evidence.find((e) => e.id === edge.evidenceId)!;
  assert.ok(e);
  validateEvidence(e, s as any);
  assert.equal(e.lineStart, 1);
  assert.equal(e.lineEnd, 3);
  const code = context.code.find((c) => c.evidenceId === e.id)!;
  assert.equal(
    code.content,
    content.replace(/\n$/, "").split("\n").slice(0, 3).join("\n"),
  );
  assert.equal(code.lineEnd, 3);
  const full = context.code.find((c) => c.path === "b.ts" && c.lineEnd === 4)!;
  assert.ok(
    full,
    "whole-file evidence remains separate from AST range evidence",
  );
  assert.deepEqual(context.coverage.contextOmissions, []);
});

test("multiple imports on one line share canonical range evidence without duplicate IDs", async (t) => {
  const f = objectFixture(t);
  const base = f.commit({
    "a.ts": "export const x=1;\n",
    "b.ts": "export const y=2;\n",
  });
  const head = f.commit(
    {
      "a.ts": "export const x=1;\n",
      "b.ts": "export const y=2;\n",
      "c.ts":
        'import {x} from "./a"; import {y} from "./b"; export const z=x+y;\n',
    },
    [base],
  );
  const s = await f.collect(base, head);
  assert.equal(s.phases[0].edges.length, 2);
  assert.equal(new Set(s.evidence.map((e) => e.id)).size, s.evidence.length);
  for (const e of s.evidence) validateEvidence(e, s as any);
  const context = buildContext(s, { kind: "pr" });
  assert.equal(context.phases.flatMap((p) => p.edges).length, 2);
});

test("import edges intentionally outside selected Q&A range are recorded, not silently lost", async (t) => {
  const f = objectFixture(t);
  const base = f.commit({ "a.ts": "export const value=1;\n" });
  const head = f.commit(
    {
      "a.ts": "export const value=1;\n",
      "b.ts": 'import { value } from "./a";\nexport const result=value;\n',
    },
    [base],
  );
  const s = await f.collect(base, head),
    p = s.phases[0];
  const context = buildContext(s, {
    kind: "code",
    commitSha: head,
    fileId: p.files.find((f) => f.path === "b.ts")!.id,
    side: "new",
    lineStart: 2,
    lineEnd: 2,
    question: "role?",
  });
  assert.equal(context.phases.flatMap((p) => p.edges).length, 0);
  assert.deepEqual(
    context.coverage.missingEdgeIds,
    p.edges.map((e) => e.id),
  );
  assert.ok(
    context.coverage.contextOmissions.some((x) => x.includes(p.edges[0].id)),
  );
});
