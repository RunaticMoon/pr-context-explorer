import { test } from "node:test";
import assert from "node:assert/strict";
import {
  firstFileTarget,
  lastFileTarget,
  moveFileTarget,
  filePosition,
  flowNavigationPatch,
} from "../src/commit-flow.ts";
import type { CommitPhase } from "../src/commit-review.ts";

type PhaseFile = CommitPhase["files"][number];

function file(overrides: Partial<PhaseFile> = {}): PhaseFile {
  return {
    id: "f1",
    path: "src/a.ts",
    status: "modified",
    oldPath: null,
    ...overrides,
  };
}

function phase(overrides: Partial<CommitPhase> = {}): CommitPhase {
  return {
    sha: "c1",
    subject: "commit subject",
    comparisonFromSha: "p0",
    hunks: [],
    files: [],
    ...overrides,
  };
}

const c1 = phase({
  sha: "c1",
  files: [file({ id: "f1" }), file({ id: "f2" }), file({ id: "f3" })],
});
const c2 = phase({
  sha: "c2",
  comparisonFromSha: "c1",
  files: [file({ id: "g1" })],
});

test("firstFileTarget returns the first change and lastFileTarget the last", () => {
  assert.deepEqual(firstFileTarget(c1), {
    commit: "c1",
    file: "f1",
    side: "new",
  });
  assert.deepEqual(lastFileTarget(c1), {
    commit: "c1",
    file: "f3",
    side: "new",
  });
});

test("firstFileTarget/lastFileTarget fall back to file \"\" for an empty commit", () => {
  const empty = phase({ sha: "empty", files: [] });
  assert.deepEqual(firstFileTarget(empty), {
    commit: "empty",
    file: "",
    side: "new",
  });
  assert.deepEqual(lastFileTarget(empty), {
    commit: "empty",
    file: "",
    side: "new",
  });
});

test("firstFileTarget/lastFileTarget exclude unchanged context files", () => {
  const p = phase({
    sha: "c",
    files: [
      file({ id: "ctx", status: "unchanged" }),
      file({ id: "real" }),
      file({ id: "ctx2", status: "unchanged" }),
    ],
  });
  assert.equal(firstFileTarget(p).file, "real");
  assert.equal(lastFileTarget(p).file, "real");
});

test("moveFileTarget steps forward/backward within a multi-file commit", () => {
  const phases = [c1, c2];
  assert.deepEqual(moveFileTarget(phases, { commit: "c1", file: "f1" }, 1), {
    commit: "c1",
    file: "f2",
    side: "new",
  });
  assert.deepEqual(moveFileTarget(phases, { commit: "c1", file: "f2" }, 1), {
    commit: "c1",
    file: "f3",
    side: "new",
  });
  assert.deepEqual(moveFileTarget(phases, { commit: "c1", file: "f3" }, -1), {
    commit: "c1",
    file: "f2",
    side: "new",
  });
  assert.deepEqual(moveFileTarget(phases, { commit: "c1", file: "f2" }, -1), {
    commit: "c1",
    file: "f1",
    side: "new",
  });
});

test("moveFileTarget crosses commit boundaries: last → next first, first → prev last", () => {
  const phases = [c1, c2];
  assert.deepEqual(moveFileTarget(phases, { commit: "c1", file: "f3" }, 1), {
    commit: "c2",
    file: "g1",
    side: "new",
  });
  assert.deepEqual(moveFileTarget(phases, { commit: "c2", file: "g1" }, -1), {
    commit: "c1",
    file: "f3",
    side: "new",
  });
});

test("moveFileTarget returns null at both ends", () => {
  const phases = [c1, c2];
  assert.equal(moveFileTarget(phases, { commit: "c1", file: "f1" }, -1), null);
  assert.equal(moveFileTarget(phases, { commit: "c2", file: "g1" }, 1), null);
});

test("moveFileTarget stops on an empty commit then continues forward/backward", () => {
  const a = phase({ sha: "a", files: [file({ id: "a1" })] });
  const empty = phase({ sha: "b", comparisonFromSha: "a", files: [] });
  const c = phase({ sha: "c", comparisonFromSha: "b", files: [file({ id: "c1" })] });
  const phases = [a, empty, c];
  // Forward: last of a → empty b's file "" (a real stop).
  assert.deepEqual(moveFileTarget(phases, { commit: "a", file: "a1" }, 1), {
    commit: "b",
    file: "",
    side: "new",
  });
  // Forward again from the empty commit's file "" → first of c.
  assert.deepEqual(moveFileTarget(phases, { commit: "b", file: "" }, 1), {
    commit: "c",
    file: "c1",
    side: "new",
  });
  // Backward: first of c → last of empty b (another real stop).
  assert.deepEqual(moveFileTarget(phases, { commit: "c", file: "c1" }, -1), {
    commit: "b",
    file: "",
    side: "new",
  });
});

test("moveFileTarget keeps empty commits when crossing forward from a later empty commit", () => {
  const a = phase({ sha: "a", files: [file({ id: "a1" })] });
  const b = phase({ sha: "b", comparisonFromSha: "a", files: [] });
  const c = phase({ sha: "c", comparisonFromSha: "b", files: [] });
  const phases = [a, b, c];
  // From a's last, land on b even though b has no changes (no skipping).
  assert.deepEqual(moveFileTarget(phases, { commit: "a", file: "a1" }, 1), {
    commit: "b",
    file: "",
    side: "new",
  });
  assert.deepEqual(moveFileTarget(phases, { commit: "b", file: "" }, 1), {
    commit: "c",
    file: "",
    side: "new",
  });
  assert.equal(moveFileTarget(phases, { commit: "c", file: "" }, 1), null);
});

test("moveFileTarget marks deleted files as old side", () => {
  const p = phase({
    sha: "d",
    files: [
      file({ id: "m1" }),
      file({ id: "gone", status: "deleted", path: "src/gone.ts" }),
    ],
  });
  assert.deepEqual(moveFileTarget([p], { commit: "d", file: "m1" }, 1), {
    commit: "d",
    file: "gone",
    side: "old",
  });
  assert.deepEqual(lastFileTarget(p), {
    commit: "d",
    file: "gone",
    side: "old",
  });
});

test("moveFileTarget recovers from a context file to the first change forward", () => {
  const prev = phase({ sha: "c0", files: [file({ id: "z1" })] });
  const p = phase({ sha: "c1", comparisonFromSha: "c0", files: [file({ id: "f1" })] });
  const phases = [prev, p];
  assert.deepEqual(moveFileTarget(phases, { commit: "c1", file: "ctx" }, 1), {
    commit: "c1",
    file: "f1",
    side: "new",
  });
  assert.deepEqual(moveFileTarget(phases, { commit: "c1", file: "ctx" }, -1), {
    commit: "c0",
    file: "z1",
    side: "new",
  });
});

test("moveFileTarget from an unlisted file in the first commit goes back to null", () => {
  assert.equal(moveFileTarget([c1], { commit: "c1", file: "ctx" }, -1), null);
});

test("moveFileTarget treats file \"\" on a commit with changes as its first file", () => {
  assert.deepEqual(moveFileTarget([c1, c2], { commit: "c1", file: "" }, 1), {
    commit: "c1",
    file: "f1",
    side: "new",
  });
});

test("moveFileTarget enters the first commit from Baseline and refuses to go back", () => {
  const phases = [c1, c2];
  assert.deepEqual(moveFileTarget(phases, { commit: "baseline", file: "" }, 1), {
    commit: "c1",
    file: "f1",
    side: "new",
  });
  assert.equal(
    moveFileTarget(phases, { commit: "baseline", file: "" }, -1),
    null,
  );
  assert.equal(
    moveFileTarget(phases, { commit: "unknown", file: "x" }, -1),
    null,
  );
});

test("moveFileTarget returns null entering an empty phase list from Baseline", () => {
  assert.equal(moveFileTarget([], { commit: "baseline", file: "" }, 1), null);
});

test("filePosition reports 1-based index/total and null for non-changes", () => {
  assert.deepEqual(filePosition(c1, "f2"), { index: 2, total: 3 });
  assert.deepEqual(filePosition(c1, "f1"), { index: 1, total: 3 });
  assert.equal(filePosition(c1, "missing"), null);
  assert.equal(filePosition(c1, ""), null);
  assert.equal(filePosition(phase({ files: [] }), "f1"), null);
});

test("filePosition ignores unchanged files when locating an index", () => {
  const p = phase({
    sha: "c",
    files: [
      file({ id: "ctx", status: "unchanged" }),
      file({ id: "real" }),
    ],
  });
  assert.deepEqual(filePosition(p, "real"), { index: 1, total: 1 });
  assert.equal(filePosition(p, "ctx"), null);
});

test("flowNavigationPatch sets the first-parent comparison and clears range/tour keys", () => {
  const target = { commit: "c1", file: "f2", side: "old" as const };
  assert.deepEqual(flowNavigationPatch(target, c1), {
    commit: "c1",
    comparison: "p0",
    file: "f2",
    side: "old",
    start: "",
    end: "",
    step: "",
    mode: "Code Explorer",
  });
});

test("flowNavigationPatch blanks a null comparison (root commit)", () => {
  const root = phase({ sha: "root", comparisonFromSha: null });
  assert.deepEqual(flowNavigationPatch(firstFileTarget(root), root), {
    commit: "root",
    comparison: "",
    file: "",
    side: "new",
    start: "",
    end: "",
    step: "",
    mode: "Code Explorer",
  });
});

test("flowNavigationPatch works with the target from moveFileTarget", () => {
  const next = moveFileTarget([c1, c2], { commit: "c1", file: "f3" }, 1)!;
  assert.deepEqual(flowNavigationPatch(next, c2), {
    commit: "c2",
    comparison: "c1",
    file: "g1",
    side: "new",
    start: "",
    end: "",
    step: "",
    mode: "Code Explorer",
  });
});
