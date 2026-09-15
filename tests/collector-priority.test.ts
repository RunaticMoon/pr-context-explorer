import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectGit, type CollectInput } from "../src/server/live-git.ts";
import { validateEvidence } from "../src/server/contract.ts";
import { buildContext } from "../src/server/live-analysis.ts";

// Build only Git objects in an isolated bare repository. No worktree, checkout,
// target installs, scripts, hooks, builds, tests or source execution.
function fixture(t: { after(fn: () => void): void }) {
  const bare = mkdtempSync(path.join(tmpdir(), "prce-collector-"));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  const git = (args: string[], input?: string | Buffer) =>
    execFileSync(
      "git",
      ["--git-dir=" + bare, "-c", "core.hooksPath=/dev/null", ...args],
      {
        encoding: "utf8",
        input,
        env: {
          PATH: process.env.PATH,
          HOME: "/nonexistent",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_AUTHOR_NAME: "Collector",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "Collector",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
          GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
        },
      },
    ).trim();
  git(["init", "--bare", "--template=", "-q"]);
  const blobs = new Map<string | Buffer, string>();
  const commit = (
    files: Record<string, string | Buffer>,
    parents: string[] = [],
  ) => {
    const rows = Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, text]) => {
        if (!blobs.has(text))
          blobs.set(text, git(["hash-object", "-w", "--stdin"], text));
        return `100644 blob ${blobs.get(text)}\t${name}\0`;
      })
      .join("");
    return git([
      "commit-tree",
      git(["mktree", "-z"], rows),
      ...parents.flatMap((p) => ["-p", p]),
      "-m",
      "collector fixture",
    ]);
  };
  const collect = (
    baseSha: string,
    headSha: string,
    limits?: CollectInput["limits"],
  ) =>
    collectGit({
      barePath: bare,
      baseSha,
      headSha,
      limits,
      identity: {
        connectionId: "collector",
        accountContextId: "fixture",
        repository: "fixture/priority",
        number: 1,
      },
      pr: {
        title: "Bounded collector",
        body: "",
        author: "Fixture",
        url: "https://github.com/fixture/priority/pull/1",
      },
    });
  return { git, commit, collect };
}

test("direct unchanged static imports beat unrelated context and duplicate blobs cost bytes only once", async (t) => {
  const f = fixture(t);
  const old = "export const important = 0;\n";
  const current =
    'import {\n  dependency\n} from "./yy-dependency";\nexport const important = dependency;\n';
  const dependency =
    'import "./zzz-important";\nimport "./xx-transitive";\nexport const dependency = "한글";\nthrow new Error("target source must never execute");\n';
  const files = {
    "000-unrelated.ts": "export const noise = 1;\n",
    "xx-transitive.ts": "export const transitive = 1;\n",
    "yy-dependency.ts": dependency,
    "zzz-important.ts": old,
  };
  const base = f.commit(files);
  const first = f.commit(files, [base]);
  const head = f.commit({ ...files, "zzz-important.ts": current }, [first]);
  const totalBytes = Buffer.byteLength(old + current + dependency);
  const s = await f.collect(base, head, { treeFiles: 2, totalBytes });
  const p = s.phases.find((p) => p.sha === head)!;
  const d = p.files.find((x) => x.path === "yy-dependency.ts")!;
  assert.equal(
    d.content,
    dependency,
    "a resolved direct dependency is selected before lexicographic context",
  );
  assert.equal(d.status, "unchanged");
  assert.ok(
    s.relatedFileIds.includes(d.id),
    "PR consumers receive direct context, not just changed IDs",
  );
  assert.equal(
    p.files.find((x) => x.path === "xx-transitive.ts")!.retrieved,
    false,
  );
  assert.equal(d.collection?.reason, "direct-import");
  assert.equal(d.collection?.depth, 1);
  assert.equal(d.collection?.sourcePath, "zzz-important.ts");
  assert.equal(d.collection?.sourceRevisionSha, head);
  assert.equal(d.collection?.lineStart, 1);
  assert.equal(d.collection?.lineEnd, 3);
  const edge = p.edges.find(
    (e) =>
      e.source === p.files.find((x) => x.path === "zzz-important.ts")!.id &&
      e.target === d.id,
  )!;
  assert.ok(edge);
  assert.equal(edge.type, "import");
  assert.equal(edge.provenance, "typescript-ast");
  assert.equal(d.collection?.evidenceId, edge.evidenceId);
  const context = buildContext(s, { kind: "pr" });
  assert.ok(
    context.code.some(
      (c) =>
        c.commitSha === head && c.path === d.path && c.content === dependency,
    ),
  );
  assert.ok(context.evidence.some((e) => e.id === edge.evidenceId));
  assert.equal(s.coverage.collection?.uniqueBlobBytesRead, totalBytes);
  assert.equal(s.coverage.collection?.uniqueBlobsRead, 3);
  assert.ok(s.coverage.collection!.blobCacheHits > 0);
  assert.ok(s.coverage.collection!.uniqueBlobBytesRead <= totalBytes);
  for (const e of s.evidence) validateEvidence(e, s as any);
});

test("phase detail caps preserve actual tree metadata, tombstones and revision-local rename/readd identities", async (t) => {
  const f = fixture(t);
  const original = "export const original = 1;\n";
  const base = f.commit({ "a.ts": original });
  const renamed = f.commit({ "b.ts": original }, [base]);
  const reused = f.commit(
    { "a.ts": "export const second = 2;\n", "b.ts": original },
    [renamed],
  );
  const deleted = f.commit({ "b.ts": original }, [reused]);
  const head = f.commit(
    { "a.ts": "export const third = 3;\n", "b.ts": original },
    [deleted],
  );
  const s = await f.collect(base, head, {
    phases: 0,
    treeFiles: 0,
    totalBytes: 0,
  });
  const phase = (sha: string) =>
    [s.baseline, ...s.phases].find((p) => p.sha === sha)!;
  const file = (sha: string, name: string) =>
    phase(sha).files.find((f) => f.path === name)!;
  assert.deepEqual(
    phase(renamed).files.map((f) => f.path),
    ["b.ts"],
    "skipped detail is not a fabricated empty tree",
  );
  assert.equal(file(renamed, "b.ts").status, "renamed");
  assert.equal(file(renamed, "b.ts").renameEvidence, "git -M R100");
  assert.equal(file(base, "a.ts").id, file(head, "b.ts").id);
  assert.notEqual(file(reused, "a.ts").id, file(base, "a.ts").id);
  assert.notEqual(file(reused, "a.ts").id, file(head, "a.ts").id);
  assert.equal(file(deleted, "a.ts").id, file(reused, "a.ts").id);
  assert.equal(file(deleted, "a.ts").status, "deleted");
  assert.equal(file(deleted, "a.ts").oldBlobSha, file(reused, "a.ts").blobSha);
  for (const p of [s.baseline, ...s.phases]) {
    const tree = f.git(["ls-tree", "-r", "--name-only", p.sha]).split("\n");
    assert.deepEqual(
      p.files.filter((f) => f.status !== "deleted").map((f) => f.path),
      tree,
    );
    assert.ok(
      p.files.every((f) => !f.retrieved && f.omission && f.content === ""),
    );
    assert.equal(new Set(p.files.map((f) => f.id)).size, p.files.length);
  }
  assert.equal(s.evidence.length, 0);
  assert.equal(s.coverage.discovered, 2);
  assert.equal(s.coverage.retrieved, 0);
  assert.equal(s.coverage.analyzed, 0);
  assert.equal(s.coverage.complete, false);
});

test("unsupported, ambiguous and dynamic imports remain unknown without guessed relations", async (t) => {
  const f = fixture(t);
  const base = f.commit({
    "ambiguous.ts": "export const a = 1;\n",
    "ambiguous.tsx": "export const b = 2;\n",
  });
  const head = f.commit(
    {
      "ambiguous.ts": "export const a = 1;\n",
      "ambiguous.tsx": "export const b = 2;\n",
      "unparsed.py": "import ambiguous\n",
      "zzz-important.ts":
        'import "@app/ambiguous";\nimport "./ambiguous";\nimport "../outside";\nimport "./missing";\nconst later = import("./ambiguous");\n',
    },
    [base],
  );
  const s = await f.collect(base, head);
  assert.equal(s.phases[0].edges.length, 0);
  assert.equal(
    s.coverage.collection?.unresolvedImports?.filter(
      (x) => x.revisionSha === head,
    ).length,
    5,
    "unsupported imports have explicit unknown coverage, not an empty complete graph",
  );
  assert.ok(
    s.coverage.collection!.unresolvedImports.some((x) =>
      /ambiguous/.test(x.reason),
    ),
  );
  assert.ok(
    s.coverage.collection!.unresolvedImports.some((x) =>
      /dynamic/.test(x.reason),
    ),
  );
  assert.ok(
    s.coverage.omitted.some((x) => /unsupported static language/.test(x)),
  );
  assert.equal(s.coverage.complete, false);
  assert.equal(
    s.coverage.collection!.unknownImportCount,
    s.coverage.collection!.unresolvedImports.length,
  );
  for (const unknown of s.coverage.collection!.unresolvedImports) {
    assert.ok(unknown.lineStart >= 1 && unknown.lineEnd >= unknown.lineStart);
    assert.equal(unknown.path, "zzz-important.ts");
  }
});

test("before-side direct context remains PR-related after a head import is removed", async (t) => {
  const f = fixture(t);
  const old =
    'import { value } from "./dependency";\nexport const result = value;\n';
  const current = "export const result = 0;\n";
  const dependency = "export const value = 1;\n";
  const base = f.commit({ "dependency.ts": dependency, "zzz.ts": old });
  const head = f.commit({ "dependency.ts": dependency, "zzz.ts": current }, [
    base,
  ]);
  const s = await f.collect(base, head, {
    treeFiles: 2,
    totalBytes: Buffer.byteLength(old + current + dependency),
  });
  const d = s.phases[0].files.find((x) => x.path === "dependency.ts")!;
  assert.ok(
    s.relatedFileIds.includes(d.id),
    "baseline import context is related even after head removes its edge",
  );
  assert.equal(
    s.baseline.files.find((x) => x.path === "dependency.ts")!.collection
      ?.reason,
    "direct-import",
  );
  assert.equal(
    s.phases[0].files.find((x) => x.path === "zzz.ts")!.oldContent,
    old,
  );
  for (const e of s.evidence) validateEvidence(e, s as any);
});

test("invalid or unbounded limits are rejected rather than silently bypassing strict budgets", async (t) => {
  const f = fixture(t);
  const base = f.commit({ "base.ts": "export {};\n" });
  const head = f.commit({ "base.ts": "export const changed = 1;\n" }, [base]);
  for (const limits of [
    { totalBytes: NaN },
    { totalBytes: Infinity },
    { treeFiles: -1 },
    { fileBytes: 0.5 },
    { phases: undefined },
  ])
    await assert.rejects(
      f.collect(base, head, limits),
      /invalid collection limit/,
    );
});

test("raw byte accounting excludes binary, invalid UTF-8, LFS, generated and oversized source honestly", async (t) => {
  const f = fixture(t);
  const base = f.commit({});
  const binary = Buffer.from([0, 1, 2]);
  const invalid = Buffer.from([0xff, 0xfe, 0xfd]);
  const lfs =
    "version https://git-lfs.github.com/spec/v1\noid sha256:not-fetched\n";
  const text = 'export const text = "한글";\n';
  const head = f.commit(
    {
      "a-binary.ts": binary,
      "b-invalid.ts": invalid,
      "c-lfs.ts": lfs,
      "generated.min.js": "throw new Error('never execute');\n",
      "huge.ts": "x".repeat(1024),
      "zzz.ts": text,
    },
    [base],
  );
  const expectedBytes =
    binary.length + invalid.length + Buffer.byteLength(lfs + text);
  const s = await f.collect(base, head, {
    fileBytes: 128,
    totalBytes: expectedBytes,
  });
  const p = s.phases[0];
  assert.equal(
    p.files.find((f) => f.path === "b-invalid.ts")!.retrieved,
    false,
    "invalid UTF-8 cannot be claimed as exact original text",
  );
  for (const [name, reason] of [
    ["a-binary.ts", "binary"],
    ["b-invalid.ts", "non-UTF-8"],
    ["c-lfs.ts", "LFS"],
    ["generated.min.js", "generated"],
    ["huge.ts", "large"],
  ]) {
    const file = p.files.find((f) => f.path === name)!;
    assert.equal(file.retrieved, false);
    assert.equal(file.content, "");
    assert.ok(file.omission!.includes(reason));
    assert.equal(
      s.evidence.some((e) => e.path === name),
      false,
    );
  }
  assert.equal(p.files.find((f) => f.path === "zzz.ts")!.content, text);
  assert.equal(s.coverage.collection!.uniqueBlobBytesRead, expectedBytes);
  assert.equal(s.coverage.collection!.uniqueBlobsRead, 4);
  assert.equal(s.coverage.collection!.omittedFileVersions, 5);
  assert.equal(s.coverage.analyzed, 1);
  assert.equal(s.coverage.retrieved, 1);
  assert.equal(s.coverage.complete, false);
});

test("an omitted direct dependency retains its real tree identity and import evidence without source evidence", async (t) => {
  const f = fixture(t);
  const dependency = "export const value = 1;\n";
  const current =
    'import { value } from "./dependency";\nexport const result = value;\n';
  const base = f.commit({ "dependency.ts": dependency });
  const head = f.commit({ "dependency.ts": dependency, "zzz.ts": current }, [
    base,
  ]);
  const s = await f.collect(base, head, {
    treeFiles: 1,
    totalBytes: Buffer.byteLength(current),
  });
  const p = s.phases[0],
    d = p.files.find((f) => f.path === "dependency.ts")!;
  assert.equal(d.retrieved, false);
  assert.equal(d.collection?.reason, "direct-import");
  assert.ok(d.omission);
  assert.ok(s.relatedFileIds.includes(d.id));
  assert.equal(p.edges[0].target, d.id);
  assert.ok(s.evidence.some((e) => e.id === p.edges[0].evidenceId));
  assert.equal(
    s.evidence.some((e) => e.fileId === d.id),
    false,
  );
  assert.equal(s.coverage.collection!.unscannedSourceVersions, 2);
  assert.equal(s.coverage.complete, false);
});

test("fully retrieved supported fixtures remain complete with zero omitted or unknown versions", async (t) => {
  const f = fixture(t);
  const dependency = "export const value = 1;\n";
  const current =
    'import { value } from "./dependency.js";\nexport const result = value;\n';
  const base = f.commit({ "dependency.ts": dependency });
  const head = f.commit({ "dependency.ts": dependency, "zzz.ts": current }, [
    base,
  ]);
  const s = await f.collect(base, head);
  assert.equal(s.coverage.complete, true);
  assert.equal(s.coverage.retrieved, s.coverage.discovered);
  assert.equal(s.coverage.collection!.omittedFileVersions, 0);
  assert.equal(s.coverage.collection!.unknownImportCount, 0);
  assert.equal(s.coverage.collection!.unscannedSourceVersions, 0);
  assert.equal(
    s.coverage.collection!.uniqueBlobBytesRead,
    Buffer.byteLength(dependency + current),
  );
  assert.equal(s.phases[0].edges.length, 1);
  for (const e of s.evidence) validateEvidence(e, s as any);
});

test("changed head wins both byte and file budgets over hundreds of earlier unrelated paths and revisions", async (t) => {
  const f = fixture(t);
  const old = "export const important = 0;\n";
  const current = "export const important = 9;\n";
  const files: Record<string, string> = {
    "000-oversized.ts": "x".repeat(8192),
    "zzz-important.ts": old,
  };
  for (let i = 0; i < 220; i++)
    files[`a${String(i).padStart(3, "0")}.ts`] =
      `export const unrelated = ${i};\n`;
  const base = f.commit(files);
  let previous = base;
  for (let i = 1; i <= 4; i++)
    previous = f.commit(
      { ...files, "a000.ts": `export const history = ${i};\n` },
      [previous],
    );
  const head = f.commit(
    {
      ...files,
      "a000.ts": "export const history = 4;\n",
      "zzz-important.ts": current,
    },
    [previous],
  );
  // Parent-only changed head is chosen ahead of net-only historical changes.
  const s = await f.collect(base, head, {
    treeFiles: 1,
    fileBytes: 4096,
    totalBytes: Buffer.byteLength(current),
  });
  const p = s.phases.find((p) => p.sha === head)!;
  assert.equal(
    p.files.find((x) => x.path === "zzz-important.ts")!.content,
    current,
  );
  assert.deepEqual(
    p.files.filter((x) => x.retrieved).map((x) => x.path),
    ["zzz-important.ts"],
  );
  assert.equal(
    p.files.length,
    Object.keys(files).length,
    "tree metadata is not a content-budget prefix",
  );
  assert.equal(s.coverage.discovered, Object.keys(files).length);
  assert.equal(s.coverage.retrieved, 1);
  assert.equal(
    s.coverage.analyzed,
    1,
    "static parser count is only retrieved head source, not model coverage",
  );
  assert.equal(s.coverage.complete, false);
  assert.equal(s.coverage.targetTestsExecuted, false);
  assert.equal(s.coverage.externalCIQueried, false);
  assert.ok(p.hunks.some((h) => h.newPath === "zzz-important.ts"));
  assert.ok(
    p.files
      .filter((x) => !x.retrieved)
      .every((x) => x.omission && x.content === ""),
  );
  for (const e of s.evidence) validateEvidence(e, s as any);
  const again = await f.collect(base, head, {
    treeFiles: 1,
    fileBytes: 4096,
    totalBytes: Buffer.byteLength(current),
  });
  assert.equal(again.snapshotId, s.snapshotId);
  assert.deepEqual(again.evidence, s.evidence);
  assert.deepEqual(again.phases, s.phases);
});
