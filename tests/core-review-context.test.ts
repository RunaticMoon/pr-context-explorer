import { test } from "node:test";
import assert from "node:assert/strict";
import { objectFixture } from "./core-review-helpers.ts";
import {
  buildContext,
  validateLiveOutput,
} from "../src/server/live-analysis.ts";
import type { LiveSnapshot } from "../src/server/live-git.ts";

export const outputFor = (
  s: LiveSnapshot,
  e: LiveSnapshot["evidence"][number],
) => ({
  schemaVersion: "2",
  snapshotId: s.snapshotId,
  analysisStatus: "complete",
  limitations: [],
  missingContext: [],
  statements: [
    {
      text: "A captured source file exists.",
      kind: "observed",
      evidenceIds: [e.id],
      confidence: "high",
      limitation: "",
      commitSha: e.commitSha,
    },
  ],
  steps: [],
  codeExplanations: [],
  requirementMappings: [],
});

test("complete collection cannot license complete analysis when model context omitted code", async (t) => {
  const f = objectFixture(t);
  const a = "/*" + "a".repeat(210000) + "*/\nexport const value=1;\n";
  const b = "/*" + "b".repeat(210000) + "*/\nexport const other=2;\n";
  const base = f.commit({ "a.ts": a, "b.ts": b });
  const head = f.commit(
    { "a.ts": a + "// changed\n", "b.ts": b + "// changed\n" },
    [base],
  );
  const s = await f.collect(base, head),
    context = buildContext(s, { kind: "pr" });
  assert.equal(s.coverage.complete, true);
  assert.ok(context.coverage.contextOmissions.length > 0);
  assert.equal(
    context.coverage.complete,
    false,
    "context completeness must not inherit collection completeness",
  );
  assert.throws(
    () => validateLiveOutput(outputFor(s, context.evidence[0]), s),
    /context.*complete|complete.*context/,
  );
  const partial = {
    ...outputFor(s, context.evidence[0]),
    analysisStatus: "partial",
  };
  validateLiveOutput(partial, s, context);
  assert.deepEqual(
    context.coverage.transmittedEvidenceIds,
    context.evidence.map((e) => e.id),
  );
  assert.ok(
    context.coverage.missingEvidenceIds.some((id) =>
      s.evidence.some(
        (e) => e.id === id && e.commitSha === head && e.side === "new",
      ),
    ),
  );
});

test("context cap measures serialized UTF-8, including escaping, metadata and framing", async (t) => {
  const f = objectFixture(t);
  const content = "/*" + '한"\\'.repeat(42000) + "*/\nexport const value=1;\n";
  const files = { "a.ts": content, "b.ts": content, "c.ts": content };
  const base = f.commit(files);
  const head = f.commit(
    Object.fromEntries(
      Object.entries(files).map(([k, v]) => [k, v + "// changed\n"]),
    ),
    [base],
  );
  const s = await f.collect(base, head),
    context = buildContext(s, { kind: "pr" });
  const actualBytes = Buffer.byteLength(JSON.stringify(context), "utf8");
  assert.ok(
    actualBytes <= 1000000,
    `${actualBytes} serialized bytes exceed cap`,
  );
  assert.equal(context.coverage.serializedBytes, actualBytes);
  assert.ok(context.coverage.contextOmissions.length);
});
