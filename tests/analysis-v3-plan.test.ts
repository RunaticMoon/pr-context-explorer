import test from "node:test";
import assert from "node:assert/strict";
import { objectFixture } from "./core-review-helpers.ts";
// Real immutable Git objects; repository source is never run.
const api = () => import("../src/server/analysis-v3/index.ts");

test("planner prioritizes changed head then commit hunks, reads one-hop unchanged dependencies only and bounds real JSON", async (t) => {
  const f = objectFixture(t);
  const noise = Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [
      `aaa${i}.ts`,
      `export const unused${i} = 0;\n`,
    ]),
  );
  const files = {
    ...noise,
    "dep.ts": "export const x = 1;\n",
    "core.ts": "import {x} from './dep';\nexport const result = x;\n",
  };
  const base = f.commit(files);
  const a = f.commit(
    {
      ...files,
      "core.ts": "import {x} from './dep';\nexport const result = x + 1;\n",
    },
    [base],
  );
  const head = f.commit(
    {
      ...files,
      "core.ts": "import {x} from './dep';\nexport const result = x + 2;\n",
    },
    [a],
  );
  const s = await f.collect(base, head);
  const { planContext, validateContextBundle } = await api();
  const p = planContext(s, { kind: "pr" }, { maxChunkBytes: 14000 });
  assert.ok(p.chunks.length >= 3);
  assert.equal(p.chunks[0].context.code[0].evidence.commitSha, head);
  const code = p.chunks.flatMap((c) => c.context.code);
  assert.ok(
    code.some(
      (c) => c.evidence.path === "dep.ts" && c.origin === "direct_import",
    ),
  );
  assert.ok(code.some((c) => c.evidence.commitSha === a));
  assert.ok(!code.some((c) => c.evidence.path.startsWith("aaa")));
  assert.ok(p.chunks.some((c) => c.context.hunks.length));
  for (const chunk of p.chunks) {
    assert.ok(Buffer.byteLength(JSON.stringify(chunk.context)) <= 14000);
    assert.doesNotThrow(() => validateContextBundle(chunk.context, s));
    assert.equal(
      new Set(chunk.context.code.map((c) => c.evidence.id)).size,
      chunk.context.code.length,
    );
  }
  assert.deepEqual(
    p.commitOrder,
    s.phases.map((p) => p.sha),
  );
  assert.ok(
    p.chunks
      .flatMap((c) => c.context.sources)
      .some(
        (e) =>
          e.text === s.pr.title &&
          e.contentHash ===
            s.sourceEvidence.find((e) => e.fieldPath === "/title")!.contentHash,
      ),
  );
  const limited = planContext(
    s,
    { kind: "pr" },
    { maxChunks: 1, maxChunkBytes: 14000 },
  );
  assert.equal(limited.chunks.length, 1);
  assert.ok(limited.omissions.some((o) => o.reason === "chunk_limit"));
  assert.equal(limited.chunks[0].context.code[0].evidence.commitSha, head);
});

test("PR baseline evidence survives for net before/after and merge parent hunks retain distinct comparison IDs", async (t) => {
  const f = objectFixture(t),
    base = f.commit({
      "alpha.ts": "export const a = 0;\n",
      "beta.ts": "export const b = 0;\n",
    });
  const left = f.commit(
    { "alpha.ts": "export const a = 1;\n", "beta.ts": "export const b = 0;\n" },
    [base],
  );
  const right = f.commit(
    { "alpha.ts": "export const a = 0;\n", "beta.ts": "export const b = 1;\n" },
    [base],
  );
  const head = f.commit(
    { "alpha.ts": "export const a = 1;\n", "beta.ts": "export const b = 1;\n" },
    [left, right],
  );
  const s = await f.collect(base, head),
    { planContext, mergeContexts, validateContextBundle } = await api(),
    plan = planContext(s, { kind: "pr" });
  const c = mergeContexts(
    s,
    { kind: "pr" },
    plan.chunks.map((c) => c.context),
  );
  assert.ok(
    c.code.some(
      (x) => x.evidence.commitSha === base && x.origin === "pr_baseline",
    ),
  );
  assert.ok(
    c.code.some(
      (x) =>
        x.evidence.commitSha === head &&
        x.evidence.comparisonFromSha === right &&
        x.evidence.side === "old",
    ),
  );
  assert.ok(c.hunks.some((h) => h.newSha === head && h.oldSha === left));
  assert.ok(c.hunks.some((h) => h.newSha === head && h.oldSha === right));
  assert.equal(new Set(c.hunks.map((h) => h.id)).size, c.hunks.length);
  assert.doesNotThrow(() => validateContextBundle(c, s));
});

test("collector relatedFileIds import expansion cannot put unchanged context before changed head code", async (t) => {
  const f = objectFixture(t),
    files = {
      "aaa-dep.ts": "export const n = 1;\n",
      "z-core.ts": "import {n} from './aaa-dep';\nexport const result = n;\n",
    },
    base = f.commit(files),
    head = f.commit(
      {
        ...files,
        "z-core.ts":
          "import {n} from './aaa-dep';\nexport const result = n + 1;\n",
      },
      [base],
    ),
    s = await f.collect(base, head),
    { planContext } = await api();
  const plan = planContext(s, { kind: "pr" });
  assert.equal(plan.chunks[0].context.code[0].evidence.path, "z-core.ts");
  assert.ok(
    plan.chunks
      .flatMap((c) => c.context.code)
      .some(
        (x) => x.evidence.path === "aaa-dep.ts" && x.origin === "direct_import",
      ),
  );
});
