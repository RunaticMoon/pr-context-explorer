import type { CandidateDiscovery, JiraBatchCapture } from "./jira/index.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isUtf8 } from "node:buffer";
import ts from "typescript";
import {
  staticImports,
  supportedSource,
  type ImportLimitation,
} from "./collector-priority.ts";
import {
  hash,
  parseHunks,
  type FileState,
  type Evidence,
  type Phase,
} from "./git.ts";
import { cacheKey } from "./store.ts";
export type SourceEvidence = {
  id: string;
  sourceKind: "pr" | "commit" | "jira";
  snapshotId: string;
  sourceId: string;
  contentHash: string;
  version: string;
  fieldPath: string;
  text: string;
  commitSha?: string;
  host?: string;
  issueId?: string;
  issueKey?: string;
  fetchedAt?: string;
  updatedAt?: string;
};
export type LiveFile = FileState & {
  retrieved: boolean;
  omission?: string;
  mode: string;
  lineage: "path" | "exact-rename" | "uncertain";
  size: number;
  collection?: {
    reason:
      | "changed-head"
      | "changed-phase"
      | "changed-before"
      | "direct-import"
      | "tree-context";
    depth: 0 | 1;
    sourcePath?: string;
    sourceRevisionSha?: string;
    lineStart?: number;
    lineEnd?: number;
    evidenceId?: string;
  };
};
export type Comparison = {
  fromSha: string;
  toSha: string;
  policy: string;
  diff: string;
  hunks: ReturnType<typeof parseHunks>;
  partial: boolean;
};
export type LivePhase = Omit<Phase, "files"> & {
  files: LiveFile[];
  parentComparisons: Comparison[];
  comparisonPolicy: string;
};
export type LiveSnapshot = {
  snapshotId: string;
  mode: "live";
  connectionId: string;
  accountContextId: string;
  repositoryId: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  mergeBaseShas: string[];
  chosenComparisonBaseSha: string | null;
  comparisonPolicy: string;
  capturedAt: string;
  prMetadataHash: string;
  jiraSnapshotHashes: string[];
  pr: {
    number: number;
    title: string;
    body: string;
    author: string;
    repository: string;
    connection: string;
    url: string;
    baseRef?: string;
    headRef?: string;
    state?: string;
    draft?: boolean;
  };
  baseline: LivePhase;
  phases: LivePhase[];
  netDiff: string;
  relatedFileIds: string[];
  evidence: Evidence[];
  sourceEvidence: SourceEvidence[];
  jira: null;
  jiraStatus: string;
  jiraData?: { discovery: CandidateDiscovery; batch: JiraBatchCapture };
  coverage: {
    discovered: number;
    retrieved: number;
    analyzed: number;
    omitted: string[];
    unavailable: string[];
    targetTestsExecuted: false;
    externalCIQueried: false;
    parser: string;
    complete: boolean;
    commitsDiscovered: number;
    commitsRetrieved: number;
    api?: unknown;
    collection?: {
      policy: "changed-head-first/direct-import-1";
      uniqueBlobBytesRead: number;
      uniqueBlobsRead: number;
      blobCacheHits: number;
      totalBytesLimit: number;
      fileLimitPerTree: number;
      contextDepth: 1;
      unresolvedImports: (ImportLimitation & {
        revisionSha: string;
        path: string;
      })[];
      unknownImportCount: number;
      unscannedSourceVersions: number;
      omittedFileVersions: number;
    };
  };
};
const shaPattern = /^[a-f0-9]{40}$/;
const safeEnv = () => ({
  PATH: process.env.PATH,
  LANG: "C.UTF-8",
  HOME: "/nonexistent",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_ATTR_NOSYSTEM: "1",
});
async function runGitBytes(
  bare: string,
  args: string[],
  signal?: AbortSignal,
  extraEnv: Record<string, string> = {},
) {
  try {
    return (
      await promisify(execFile)(
        "git",
        [
          "--git-dir=" + bare,
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.attributesFile=/dev/null",
          "-c",
          "diff.external=",
          "-c",
          "protocol.allow=never",
          "-c",
          "protocol.https.allow=always",
          ...args,
        ],
        {
          env: { ...safeEnv(), ...extraEnv },
          encoding: "buffer",
          maxBuffer: 16 * 1024 * 1024,
          timeout: 120000,
          signal,
        },
      )
    ).stdout;
  } catch (e: any) {
    throw Error(
      signal?.aborted
        ? "cancelled"
        : `git_operation_failed (${args[0]}): ${e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "output cap; large repository unsupported" : "missing objects, timeout, denied fetch, or Git error; no target code executed"}`,
    );
  }
}
export async function runGit(
  bare: string,
  args: string[],
  signal?: AbortSignal,
  extraEnv: Record<string, string> = {},
) {
  return (await runGitBytes(bare, args, signal, extraEnv)).toString("utf8");
}
export async function compareGit(
  bare: string,
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<Comparison> {
  if (!shaPattern.test(from) || !shaPattern.test(to))
    throw Error("invalid fixed revision");
  const diff = await runGit(
    bare,
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "-M",
      "--unified=3",
      from,
      to,
      "--",
    ],
    signal,
  );
  const partial = diff.length > 2 * 1024 * 1024;
  const text = partial
    ? diff.slice(0, 2 * 1024 * 1024) + "\n[diff truncated by policy]"
    : diff;
  return {
    fromSha: from,
    toSha: to,
    policy: "arbitrary pinned revisions",
    diff: text,
    hunks: partial ? [] : parseHunks(text, from, to),
    partial,
  };
}
export type CollectInput = {
  barePath: string;
  baseSha: string;
  headSha: string;
  identity: {
    connectionId: string;
    accountContextId: string;
    repository: string;
    number: number;
  };
  pr: {
    title: string;
    body: string;
    author: string;
    url: string;
    baseRef?: string;
    headRef?: string;
    state?: string;
    draft?: boolean;
  };
  limits?: {
    fileBytes?: number;
    treeFiles?: number;
    totalBytes?: number;
    phases?: number;
  };
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
};
export async function collectGit(input: CollectInput): Promise<LiveSnapshot> {
  const { barePath: bare, baseSha, headSha, signal } = input;
  if (!shaPattern.test(baseSha) || !shaPattern.test(headSha))
    throw Error("invalid fixed revision");
  if (
    (
      await runGit(bare, ["rev-parse", "--is-bare-repository"], signal)
    ).trim() !== "true"
  )
    throw Error("only app-owned bare repositories may be analyzed");
  const limits = {
    fileBytes: 256 * 1024,
    treeFiles: 500,
    totalBytes: 12 * 1024 * 1024,
    phases: 150,
    ...input.limits,
  };
  for (const [name, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < 0)
      throw Error("invalid collection limit: " + name);
  const unavailable: string[] = [],
    omitted = new Set<string>();
  const shallow =
    (
      await runGit(bare, ["rev-parse", "--is-shallow-repository"], signal)
    ).trim() === "true";
  if (shallow)
    unavailable.push("shallow history: commit ancestry may be incomplete");
  let mergeBaseShas: string[] = [];
  try {
    mergeBaseShas = (
      await runGit(bare, ["merge-base", "--all", baseSha, headSha], signal)
    )
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    unavailable.push("merge-base unavailable; no PR net diff invented");
  }
  const chosen = mergeBaseShas.length === 1 ? mergeBaseShas[0] : null;
  if (mergeBaseShas.length > 1)
    unavailable.push(
      "multiple merge-bases: no arbitrary PR comparison selected",
    );
  const baselineSha = chosen || baseSha;
  const shas = (
    await runGit(
      bare,
      ["rev-list", "--reverse", "--topo-order", baseSha + ".." + headSha],
      signal,
    )
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  if (!shas.includes(headSha) && headSha !== baselineSha) shas.push(headSha);
  if (shas.length > 1000)
    throw Error(
      "commit_metadata_limit: more than 1000 commits; narrow PR before collection",
    );
  const snapshotId = cacheKey({
    identity: input.identity,
    pr: input.pr,
    baseSha,
    headSha,
    mergeBaseShas,
    limits,
    parser: ts.version,
    schema: "2",
    collectorVersion: "prce-git-v4-priority-active-lineage",
  });
  const evidence: Evidence[] = [],
    evidenceById = new Map<string, Evidence>(),
    sources: SourceEvidence[] = [],
    treeCache = new Map<string, LiveFile[]>(),
    idsByRevision = new Map<string, Map<string, string>>();
  let bytes = 0,
    blobCacheHits = 0;
  const blobCache = new Map<string, { content: string; omission?: string }>();
  const selected = new Map<string, Set<string>>();
  const unresolvedImports = new Map<
    string,
    ImportLimitation & { revisionSha: string; path: string }
  >();
  const recordUnknown =
    (revisionSha: string, path: string) => (item: ImportLimitation) => {
      const entry = { revisionSha, path, ...item };
      unresolvedImports.set(JSON.stringify(entry), entry);
      omitted.add(
        revisionSha + ":" + path + ":" + item.lineStart + ": " + item.reason,
      );
    };
  async function metadata(revision: string): Promise<LiveFile[]> {
    if (treeCache.has(revision)) return treeCache.get(revision)!;
    const rows = (
      await runGit(bare, ["ls-tree", "-r", "-l", "-z", revision], signal)
    )
      .split("\0")
      .filter(Boolean);
    const files: LiveFile[] = [];
    for (const row of rows) {
      const tab = row.indexOf("\t"),
        meta = row.slice(0, tab).trim().split(/\s+/),
        name = row.slice(tab + 1);
      const [mode, type, blob, sizeRaw] = meta;
      const size = Number(sizeRaw) || 0;
      const reason =
        type !== "blob"
          ? "submodule"
          : mode === "120000"
            ? "symlink"
            : size > limits.fileBytes
              ? "large file"
              : /(^|\/)(node_modules|vendor|dist)\/|(^|\/)(package-lock\.json|yarn\.lock)|\.min\.[jt]s$/.test(
                    name,
                  )
                ? "generated/lockfile"
                : undefined;
      files.push({
        id: hash(
          [
            input.identity.connectionId,
            input.identity.accountContextId,
            input.identity.repository,
            revision,
            name,
          ].join(":"),
        ).slice(0, 20),
        path: name,
        blobSha: blob,
        content: "",
        status: "unchanged",
        oldPath: null,
        oldBlobSha: null,
        oldContent: null,
        renameEvidence: null,
        retrieved: false,
        omission: reason,
        mode,
        lineage: "path",
        size,
      });
    }
    treeCache.set(revision, files);
    return files;
  }
  async function tree(revision: string): Promise<LiveFile[]> {
    return structuredClone(await metadata(revision));
  }
  type Change = {
    status: string;
    oldPath: string | null;
    rename: string | null;
  };
  const changeCache = new Map<string, Map<string, Change>>();
  async function changesBetween(from: string, to: string) {
    const key = from + ":" + to;
    if (changeCache.has(key)) return changeCache.get(key)!;
    const changes = new Map<string, Change>();
    try {
      const parts = (
        await runGit(
          bare,
          [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-status",
            "-z",
            "-M",
            from,
            to,
            "--",
          ],
          signal,
        )
      ).split("\0");
      for (let i = 0; i < parts.length - 1;) {
        const status = parts[i++],
          old = parts[i++];
        if (status.startsWith("R"))
          changes.set(parts[i++], {
            status: "renamed",
            oldPath: old,
            rename:
              "git -M " +
              status +
              (status === "R100" ? "" : " (identity uncertain; not merged)"),
          });
        else
          changes.set(old, {
            status:
              (
                {
                  A: "added",
                  M: "modified",
                  D: "deleted",
                  T: "type-changed",
                } as Record<string, string>
              )[status] || status,
            oldPath: status === "A" ? null : old,
            rename: null,
          });
      }
    } catch {
      signal?.throwIfAborted();
      unavailable.push(to + ": parent diff unavailable");
    }
    changeCache.set(key, changes);
    return changes;
  }
  // Discover pinned metadata first. Content selection must not depend on which
  // phase happens to be rendered first or on ls-tree's lexicographic prefix.
  const revisions = [baselineSha, ...shas.filter((s) => s !== baselineSha)];
  const plans = [];
  for (const [index, sha] of revisions.entries()) {
    input.onProgress?.(
      `Git metadata ${index}/${shas.length}: ${sha.slice(0, 12)}`,
    );
    const raw = await runGit(bare, ["cat-file", "commit", sha], signal);
    const parents = [
      ...raw
        .slice(0, raw.indexOf("\n\n"))
        .matchAll(/^parent ([a-f0-9]{40})$/gm),
    ].map((x) => x[1]);
    const from = index
      ? parents[0] ||
        (
          await runGit(
            bare,
            ["hash-object", "-w", "-t", "tree", "/dev/null"],
            signal,
          )
        ).trim()
      : null;
    const skipped = index > limits.phases && sha !== headSha;
    const changes = from
      ? await changesBetween(from, sha)
      : new Map<string, Change>();
    await metadata(sha);
    if (from)
      try {
        await metadata(from);
      } catch {
        signal?.throwIfAborted();
        unavailable.push(from + ": missing parent tree");
      }
    plans.push({ sha, raw, parents, from, skipped, changes });
  }
  async function select(
    revision: string,
    paths: Iterable<string>,
    collection: NonNullable<LiveFile["collection"]>,
  ) {
    const files = treeCache.get(revision);
    if (!files) return;
    const byPath = new Map(files.map((f) => [f.path, f]));
    const picked = selected.get(revision) || new Set<string>();
    selected.set(revision, picked);
    for (const name of [...new Set(paths)].sort()) {
      signal?.throwIfAborted();
      const f = byPath.get(name);
      if (!f) continue;
      f.collection ||= collection;
      if (
        f.retrieved ||
        (f.omission &&
          !["tree file cap", "snapshot byte cap"].includes(f.omission))
      )
        continue;
      const cached = blobCache.get(f.blobSha);
      if (picked.size >= limits.treeFiles) {
        f.omission = "tree file cap";
        continue;
      }
      if (!cached && bytes + f.size > limits.totalBytes) {
        f.omission = "snapshot byte cap";
        continue;
      }
      if (cached) blobCacheHits++;
      let blob = cached;
      if (!blob) {
        const raw = await runGitBytes(
          bare,
          ["cat-file", "blob", f.blobSha],
          signal,
        );
        if (raw.length !== f.size) throw Error("Git blob size mismatch");
        bytes += raw.length;
        const content = raw.toString("utf8");
        const omission = raw.includes(0)
          ? "binary"
          : !isUtf8(raw)
            ? "non-UTF-8 text"
            : content.startsWith("version https://git-lfs.github.com/spec/v1")
              ? "LFS pointer (object not fetched)"
              : undefined;
        blob = { content: omission ? "" : content, omission };
        blobCache.set(f.blobSha, blob);
      }
      picked.add(name);
      f.content = blob.content;
      f.omission = blob.omission;
      f.retrieved = !blob.omission;
    }
  }
  async function directContext(revision: string, roots: Iterable<string>) {
    const files = treeCache.get(revision) || [];
    const paths = new Set(files.map((f) => f.path));
    // Only the fixed root set is expanded. A selected dependency's imports do
    // not recursively extend this queue (cycles terminate at exactly one hop).
    for (const name of [...new Set(roots)].sort()) {
      const source = files.find((f) => f.path === name && f.retrieved);
      if (!source) continue;
      for (const ref of staticImports(
        source.path,
        source.content,
        paths,
        recordUnknown(revision, source.path),
      ))
        await select(revision, [ref.targetPath], {
          reason: "direct-import",
          depth: 1,
          sourcePath: source.path,
          sourceRevisionSha: revision,
          lineStart: ref.lineStart,
          lineEnd: ref.lineEnd,
        });
    }
  }
  const headPlan = plans.find((p) => p.sha === headSha)!;
  const headRoots = new Set(headPlan.changes.keys());
  await select(headSha, headRoots, { reason: "changed-head", depth: 0 });
  if (chosen) {
    const netPaths = (await changesBetween(chosen, headSha)).keys();
    for (const name of netPaths) headRoots.add(name);
  }
  for (const p of [...plans].reverse())
    for (const name of p.changes.keys()) headRoots.add(name);
  await select(headSha, headRoots, { reason: "changed-head", depth: 0 });
  const oldPaths = (p: typeof headPlan) =>
    [...p.changes.values()].flatMap((c) => (c.oldPath ? [c.oldPath] : []));
  // Reserve current changed text, then its actual before side, then direct
  // head context, all before any earlier phase's unrelated or changed text.
  if (headPlan.from)
    await select(headPlan.from, oldPaths(headPlan), {
      reason: "changed-before",
      depth: 0,
    });
  await directContext(headSha, headRoots);
  for (const p of [...plans].reverse()) {
    if (p.skipped) continue;
    await select(p.sha, p.changes.keys(), {
      reason: "changed-phase",
      depth: 0,
    });
    if (p.from)
      await select(p.from, oldPaths(p), { reason: "changed-before", depth: 0 });
    await directContext(
      p.sha,
      p.sha === headSha ? headRoots : p.changes.keys(),
    );
    if (p.from) await directContext(p.from, oldPaths(p));
  }
  for (const revision of [...new Set([headSha, ...treeCache.keys()])])
    if (!plans.some((p) => p.sha === revision && p.skipped))
      await select(
        revision,
        treeCache.get(revision)?.map((f) => f.path) || [],
        { reason: "tree-context", depth: 0 },
      );
  for (const [revision, files] of treeCache)
    for (const f of files) {
      if (!f.retrieved) {
        f.omission ||= "phase tree cap (metadata retained)";
        omitted.add(revision + ":" + f.path + ": " + f.omission);
      } else if (!supportedSource(f.path))
        omitted.add(
          revision +
            ":" +
            f.path +
            ": unsupported static language (text retrieved)",
        );
    }
  const phaseList: LivePhase[] = [];
  for (const [index, sha] of revisions.entries()) {
    signal?.throwIfAborted();
    input.onProgress?.(
      `Git tree phase ${index}/${shas.length}: ${sha.slice(0, 12)}`,
    );
    const raw = plans[index].raw,
      cut = raw.indexOf("\n\n"),
      headers = raw.slice(0, cut),
      message = raw.slice(cut + 2),
      subject = message.split("\n")[0],
      body = message
        .slice(subject.length)
        .replace(/^\n\n?/, "")
        .replace(/\n$/, "");
    const parents = plans[index].parents;
    const rootComparison = index > 0 && parents.length === 0;
    const from = plans[index].from;
    const skipped = index > limits.phases && sha !== headSha;
    if (skipped) omitted.add(sha + ": phase tree cap (metadata retained)");
    let before: LiveFile[] = [];
    if (from)
      try {
        before = await tree(from);
      } catch {
        unavailable.push(from + ": missing parent tree");
      }
    // Ancestry is revision-local; only active paths survive to the next tree.
    // Fresh tree IDs include the birth revision so retired paths can be reused.
    const after = await tree(sha),
      parentIds =
        idsByRevision.get(from || "") ||
        new Map(before.map((f) => [f.path, f.id])),
      idMap = new Map<string, string>();
    const changes = plans[index].changes;
    const files = after.map((f) => {
      const c = changes.get(f.path),
        old = before.find((b) => b.path === (c?.oldPath || f.path));
      // Never merge a new incarnation or a similarity-only rename. At merges
      // continuity is with the actual first parent, not the traversal's last tree.
      const ancestorPath = c?.rename
        ? c.rename === "git -M R100"
          ? c.oldPath
          : null
        : c?.status === "added"
          ? null
          : f.path;
      f.id = (ancestorPath && parentIds.get(ancestorPath)) || f.id;
      idMap.set(f.path, f.id);
      return {
        ...f,
        status: c?.status || "unchanged",
        oldPath: old?.path || null,
        oldBlobSha: old?.blobSha || null,
        oldContent: old?.retrieved ? old.content : null,
        renameEvidence: c?.rename || null,
        lineage: (c?.rename
          ? c.rename.includes("R100")
            ? "exact-rename"
            : "uncertain"
          : f.lineage) as LiveFile["lineage"],
      };
    });
    for (const [name, c] of changes)
      if (c.status === "deleted") {
        const f = before.find((x) => x.path === name);
        if (f)
          files.push({
            ...f,
            id: parentIds.get(name) || f.id,
            status: "deleted",
            oldPath: name,
            oldBlobSha: f.blobSha,
            oldContent: f.retrieved ? f.content : null,
          });
      }
    idsByRevision.set(sha, idMap);
    if (new Set(files.map((f) => f.id)).size !== files.length)
      throw Error("duplicate logical file identity in phase " + sha);
    const ev = (
      f: LiveFile,
      side: "old" | "new",
      lineStart = 1,
      lineEnd?: number,
    ) => {
      const content = side === "old" ? f.oldContent! : f.content;
      const id =
        "code:" +
        hash(
          [
            snapshotId,
            sha,
            from,
            f.id,
            side,
            lineStart,
            lineEnd || "full",
          ].join(":"),
        ).slice(0, 24);
      const ref: Evidence = {
        id,
        snapshotId,
        commitSha: sha,
        comparisonFromSha: from,
        revisionSha: side === "old" ? from! : sha,
        fileId: f.id,
        path: side === "old" ? f.oldPath! : f.path,
        blobSha: side === "old" ? f.oldBlobSha! : f.blobSha,
        side,
        lineStart,
        lineEnd:
          lineEnd ?? Math.max(1, content.replace(/\n$/, "").split("\n").length),
        contentHash: hash(content),
      };
      const prior = evidenceById.get(id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(ref))
        throw Error("conflicting code evidence identity");
      if (!prior) {
        evidenceById.set(id, ref);
        evidence.push(ref);
      }
      return id;
    };
    const edges: Phase["edges"] = [];
    const activeFiles = new Map(
      files.filter((f) => f.status !== "deleted").map((f) => [f.path, f]),
    );
    const paths = new Set(activeFiles.keys());
    for (const f of files) {
      if (f.oldContent !== null) ev(f, "old");
      if (f.status === "deleted" || !f.retrieved) continue;
      ev(f, "new");
      for (const ref of staticImports(
        f.path,
        f.content,
        paths,
        recordUnknown(sha, f.path),
      )) {
        const target = activeFiles.get(ref.targetPath)!;
        const evidenceId = ev(f, "new", ref.lineStart, ref.lineEnd);
        edges.push({
          id: sha + ":" + f.id + ":" + target.id + ":" + ref.lineStart,
          source: f.id,
          target: target.id,
          type: "import",
          provenance: "typescript-ast",
          evidenceId,
        });
        if (
          target.collection?.reason === "direct-import" &&
          target.collection.sourcePath === f.path &&
          target.collection.sourceRevisionSha === sha &&
          target.collection.lineStart === ref.lineStart
        )
          target.collection.evidenceId = evidenceId;
      }
    }
    const comparisons: Comparison[] = [];
    if (index && !skipped)
      for (const parent of rootComparison ? [from!] : parents)
        try {
          const c = await compareGit(bare, parent, sha, signal);
          c.policy = rootComparison
            ? "empty-tree (root commit)"
            : "actual parent";
          comparisons.push(c);
          if (c.partial) omitted.add(sha + ": parent diff truncated");
        } catch {
          unavailable.push(parent + ": parent comparison unavailable");
        }
    const phase: LivePhase = {
      sha,
      parents,
      subject,
      body,
      message,
      author: headers.match(/^author (.+)$/m)?.[1] || "",
      date: (
        await runGit(bare, ["show", "-s", "--format=%aI", sha], signal)
      ).trim(),
      comparisonFromSha: from,
      comparisonPolicy: rootComparison
        ? "empty-tree comparison for root commit; no parent invented"
        : index
          ? "first actual parent; all parent comparisons retained"
          : "baseline tree; no parent diff",
      files,
      diff: comparisons[0]?.diff || "",
      hunks: comparisons[0]?.hunks || [],
      edges,
      parentComparisons: comparisons,
    };
    phaseList.push(phase);
    sources.push({
      id: "commit:" + sha,
      sourceKind: "commit",
      snapshotId,
      sourceId: sha,
      contentHash: hash(message),
      version: sha,
      fieldPath: "/message",
      text: message,
      commitSha: sha,
    });
  }
  sources.push({
    id: "pr:title",
    sourceKind: "pr",
    snapshotId,
    sourceId: input.pr.url,
    contentHash: hash(input.pr.title),
    version: hash(JSON.stringify(input.pr)),
    fieldPath: "/title",
    text: input.pr.title,
  });
  sources.push({
    id: "pr:body",
    sourceKind: "pr",
    snapshotId,
    sourceId: input.pr.url,
    contentHash: hash(input.pr.body),
    version: hash(JSON.stringify(input.pr)),
    fieldPath: "/body",
    text: input.pr.body,
  });
  let netDiff = "";
  if (chosen) {
    try {
      const c = await compareGit(bare, chosen, headSha, signal);
      netDiff = c.diff;
      if (c.partial) omitted.add("PR net diff truncated");
    } catch {
      unavailable.push("PR net diff exceeds Git output limit");
    }
  }
  const head = phaseList.find((p) => p.sha === headSha) || phaseList.at(-1)!;
  const live = head.files.filter((f) => f.status !== "deleted");
  if (new Set(evidence.map((e) => e.id)).size !== evidence.length)
    throw Error("duplicate code evidence identity");
  return {
    snapshotId,
    mode: "live",
    ...input.identity,
    connectionId: input.identity.connectionId,
    accountContextId: input.identity.accountContextId,
    repositoryId: input.identity.repository,
    prNumber: input.identity.number,
    baseSha,
    headSha,
    mergeBaseShas,
    chosenComparisonBaseSha: chosen,
    comparisonPolicy: chosen
      ? "unique merge-base → head; commit diff against first actual parent; all parents retained"
      : "PR comparison unavailable; baseline is base tip, not asserted merge-base",
    capturedAt: new Date().toISOString(),
    prMetadataHash: hash(JSON.stringify(input.pr)),
    jiraSnapshotHashes: [],
    pr: {
      ...input.pr,
      number: input.identity.number,
      repository: input.identity.repository,
      connection: input.identity.connectionId,
    },
    baseline: phaseList[0],
    phases: phaseList.slice(1),
    netDiff,
    relatedFileIds: [
      ...new Set(
        phaseList.flatMap((p, index) =>
          p.files
            .filter(
              (f) =>
                (index > 0 && f.status !== "unchanged") ||
                f.collection?.reason === "direct-import",
            )
            .map((f) => f.id),
        ),
      ),
    ],
    evidence,
    sourceEvidence: sources,
    jira: null,
    jiraStatus: "unconnected",
    coverage: {
      discovered: live.length,
      retrieved: live.filter((f) => f.retrieved).length,
      analyzed: live.filter((f) => f.retrieved && supportedSource(f.path))
        .length,
      omitted: [...omitted],
      unavailable,
      targetTestsExecuted: false,
      externalCIQueried: false,
      parser: "TypeScript " + ts.version,
      complete: !omitted.size && !unavailable.length,
      commitsDiscovered: shas.length,
      commitsRetrieved: phaseList.length - 1,
      collection: {
        policy: "changed-head-first/direct-import-1",
        uniqueBlobBytesRead: bytes,
        uniqueBlobsRead: blobCache.size,
        blobCacheHits,
        totalBytesLimit: limits.totalBytes,
        fileLimitPerTree: limits.treeFiles,
        contextDepth: 1,
        unresolvedImports: [...unresolvedImports.values()],
        unknownImportCount: unresolvedImports.size,
        unscannedSourceVersions: [...treeCache.values()]
          .flat()
          .filter((f) => !f.retrieved && supportedSource(f.path)).length,
        omittedFileVersions: [...treeCache.values()]
          .flat()
          .filter((f) => !f.retrieved).length,
      },
    },
  };
}
