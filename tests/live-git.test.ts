import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
export function dagFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "prce-dag-")),
    work = path.join(root, "work"),
    bare = path.join(root, "repo.git");
  mkdirSync(work);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", work, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  const put = (name: string, content: string | Buffer) =>
    writeFileSync(path.join(work, name), content);
  const commit = (message: string) => {
    git("add", ".");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  put("old.ts", "export const stable = 1;\n");
  put("config.ts", "export const DEBUG = false;\n");
  put("delete.ts", "export const removed=1;\n");
  const base = commit("baseline");
  git("checkout", "-qb", "feature");
  renameSync(path.join(work, "old.ts"), path.join(work, "renamed.ts"));
  put("config.ts", "export const DEBUG = true;\n");
  const first = commit("rename and intermediate change");
  git("checkout", "-qb", "side", base);
  put("side.ts", "export const side=1;\n");
  const side = commit("side branch");
  git("checkout", "-q", "feature");
  git("merge", "--no-ff", "-qm", "merge side", "side");
  const merge = git("rev-parse", "HEAD");
  put("config.ts", "export const DEBUG = false;\n");
  rmSync(path.join(work, "delete.ts"));
  put("image.bin", Buffer.from([0, 1, 2, 3]));
  put("unknown.py", 'print("not executed")\n');
  put("big.ts", "x".repeat(3000));
  const head = commit("revert debug and delete");
  git("clone", "-q", "--bare", work, bare);
  return { root, work, bare, base, first, side, merge, head };
}
test("unrelated root commit uses explicit empty-tree comparison; shallow ancestry remains partial", async () => {
  const f = dagFixture();
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["--git-dir=" + f.bare, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
      }).trim();
    const root = git(
      "commit-tree",
      git("rev-parse", f.head + "^{tree}"),
      "-m",
      "new root",
    );
    const { collectGit } = await import("../src/server/live-git.ts");
    const input = {
      barePath: f.bare,
      baseSha: f.base,
      headSha: root,
      identity: {
        connectionId: "test",
        accountContextId: "public",
        repository: "acme/repo",
        number: 2,
      },
      pr: {
        title: "root",
        body: "",
        author: "fixture",
        url: "https://github.com/acme/repo/pull/2",
      },
    };
    const s = await collectGit(input);
    assert.equal(s.chosenComparisonBaseSha, null);
    assert.equal(s.netDiff, "");
    const p = s.phases.find((p) => p.sha === root)!;
    assert.deepEqual(p.parents, []);
    assert.equal(
      p.comparisonFromSha,
      git("hash-object", "-t", "tree", "/dev/null"),
    );
    assert.ok(p.files.every((f) => f.status === "added"));
    assert.match(p.comparisonPolicy, /empty.tree/);
    const shallow = path.join(f.root, "shallow.git");
    execFileSync("git", [
      "clone",
      "-q",
      "--bare",
      "--depth",
      "1",
      "file://" + f.bare,
      shallow,
    ]);
    const limited = await collectGit({
      ...input,
      barePath: shallow,
      baseSha: f.head,
      headSha: f.head,
    });
    assert.equal(limited.coverage.complete, false);
    assert.ok(limited.coverage.unavailable.some((x) => x.includes("shallow")));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Git-quoted Unicode/tab/quote filenames preserve exact hunk paths", async () => {
  const f = dagFixture();
  try {
    const name = '한 글\t"file.ts';
    writeFileSync(path.join(f.work, name), "export const value = 1;\n");
    const git = (...a: string[]) =>
      execFileSync("git", ["-C", f.work, ...a], { encoding: "utf8" });
    git("add", ".");
    git("commit", "-qm", "quoted name");
    const diff = git("diff", "--no-ext-diff", f.head, "HEAD");
    const { parseHunks } = await import("../src/server/git.ts");
    const h = parseHunks(diff, f.head, git("rev-parse", "HEAD").trim());
    assert.equal(h[0].newPath, name);
    assert.equal(h[0].oldPath, null);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("immutable non-linear Git trees, every parent comparison, rename, tombstones, revert and partial coverage", async () => {
  const f = dagFixture();
  try {
    const { collectGit, compareGit } =
      await import("../src/server/live-git.ts");
    const s = await collectGit({
      barePath: f.bare,
      baseSha: f.base,
      headSha: f.head,
      identity: {
        connectionId: "test",
        accountContextId: "alice:7",
        repository: "acme/repo",
        number: 12,
      },
      pr: {
        title: "Actual test PR",
        body: "stated intent",
        author: "alice",
        url: "https://github.com/acme/repo/pull/12",
      },
      limits: { fileBytes: 1024 },
    });
    assert.ok(
      s.sourceEvidence.some(
        (e) =>
          e.sourceKind === "pr" &&
          e.fieldPath === "/title" &&
          e.text === "Actual test PR",
      ),
    );
    assert.equal(s.phases.length, 4);
    assert.equal(s.chosenComparisonBaseSha, f.base);
    const merge = s.phases.find((p) => p.sha === f.merge)!;
    assert.deepEqual(merge.parents, [f.first, f.side]);
    assert.equal(merge.parentComparisons.length, 2);
    assert.ok(merge.parentComparisons.every((c) => c.fromSha && c.diff));
    assert.equal(s.phases.find((p) => p.sha === f.first)!.body, "");
    assert.match(
      s.phases
        .find((p) => p.sha === f.first)!
        .files.find((x) => x.path === "config.ts")!.content,
      /true/,
    );
    assert.doesNotMatch(s.netDiff, /DEBUG/);
    assert.equal(
      s.baseline.files.find((x) => x.path === "old.ts")!.id,
      s.phases.at(-1)!.files.find((x) => x.path === "renamed.ts")!.id,
    );
    assert.equal(
      s.phases.at(-1)!.files.find((x) => x.path === "delete.ts")!.status,
      "deleted",
    );
    assert.ok(s.coverage.omitted.some((x) => x.includes("binary")));
    assert.ok(s.coverage.omitted.some((x) => x.includes("large")));
    assert.ok(s.coverage.omitted.some((x) => x.includes("unsupported")));
    assert.equal(
      s.evidence.some((e) => e.path === "image.bin"),
      false,
    );
    assert.equal(s.coverage.targetTestsExecuted, false);
    const other = await collectGit({
      barePath: f.bare,
      baseSha: f.base,
      headSha: f.head,
      identity: {
        connectionId: "other",
        accountContextId: "bob:8",
        repository: "acme/repo",
        number: 12,
      },
      pr: {
        title: "same",
        body: "",
        author: "bob",
        url: "https://github.com/acme/repo/pull/12",
      },
      limits: { fileBytes: 1024 },
    });
    assert.notEqual(
      other.baseline.files[0].id,
      s.baseline.files[0].id,
      "file identity must include host/account connection context",
    );
    const arbitrary = await compareGit(f.bare, f.side, f.head);
    assert.equal(arbitrary.policy, "arbitrary pinned revisions");
    assert.ok(arbitrary.diff.includes("renamed.ts"));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
