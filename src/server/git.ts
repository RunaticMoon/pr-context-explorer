import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";
import { ensureFixture, git } from "./fixture.ts";
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export type FileState = {
  id: string;
  path: string;
  blobSha: string;
  content: string;
  status: string;
  oldPath: string | null;
  oldBlobSha: string | null;
  oldContent: string | null;
  renameEvidence: string | null;
};
export type Evidence = {
  id: string;
  snapshotId: string;
  commitSha: string;
  comparisonFromSha: string | null;
  revisionSha: string;
  fileId: string;
  path: string;
  blobSha: string;
  side: "old" | "new";
  lineStart: number;
  lineEnd: number;
  contentHash: string;
};
export type Edge = {
  id: string;
  source: string;
  target: string;
  type: "import";
  provenance: "typescript-ast";
  evidenceId: string;
};
export type Hunk = {
  id: string;
  header: string;
  oldPath: string | null;
  newPath: string | null;
  oldSha: string;
  newSha: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  text: string;
};
export type Phase = {
  sha: string;
  parents: string[];
  subject: string;
  body: string;
  message: string;
  author: string;
  date: string;
  comparisonFromSha: string | null;
  files: FileState[];
  diff: string;
  hunks: Hunk[];
  edges: Edge[];
};
export type Snapshot = ReturnType<typeof collect>;
function tree(sha: string) {
  return git("ls-tree", "-r", "-z", sha)
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const [meta, p] = row.split("\t");
      const blob = meta.split(" ")[2];
      return { path: p, blobSha: blob, content: git("cat-file", "blob", blob) };
    });
}
function diffPath(header: string): string | null {
  let decoded: string;
  if (header.startsWith('"')) {
    const match = header.match(/^"((?:\\.|[^"\\])*)"/s);
    if (!match) throw Error("invalid Git quoted path");
    const bytes: Buffer[] = [];
    for (const part of match[1].matchAll(/\\([0-7]{1,3}|.)|([^\\]+)/gs)) {
      if (part[2] !== undefined) bytes.push(Buffer.from(part[2]));
      else if (/^[0-7]+$/.test(part[1]))
        bytes.push(Buffer.from([Number.parseInt(part[1], 8)]));
      else {
        const escaped: Record<string, number> = {
          a: 7,
          b: 8,
          t: 9,
          n: 10,
          v: 11,
          f: 12,
          r: 13,
          '"': 34,
          "\\": 92,
        };
        if (escaped[part[1]] === undefined) throw Error("invalid Git escape");
        bytes.push(Buffer.from([escaped[part[1]]]));
      }
    }
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(bytes),
    );
  } else decoded = header.split("\t")[0];
  return decoded === "/dev/null" ? null : decoded.slice(2);
}
export function parseHunks(
  diff: string,
  oldSha: string,
  newSha: string,
): Hunk[] {
  const hunks: Hunk[] = [];
  let oldPath: string | null = null,
    newPath: string | null = null,
    current: Hunk | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = undefined;
      continue;
    }
    if (!current && line.startsWith("--- ")) {
      oldPath = diffPath(line.slice(4));
      continue;
    }
    if (!current && line.startsWith("+++ ")) {
      newPath = diffPath(line.slice(4));
      continue;
    }
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      current = {
        id: newSha + ":h" + hunks.length,
        header: line,
        oldPath,
        newPath,
        oldSha,
        newSha,
        oldStart: Number(m[1]),
        oldCount: Number(m[2] ?? 1),
        newStart: Number(m[3]),
        newCount: Number(m[4] ?? 1),
        text: line,
      };
      hunks.push(current);
    } else if (current) current.text += "\n" + line;
  }
  return hunks;
}
export function collect() {
  ensureFixture();
  const baseSha = git("rev-parse", "baseline").trim(),
    headSha = git("rev-parse", "HEAD").trim();
  const jira = {
    key: "DEMO-1",
    host: "demo.invalid",
    issueId: "simulated-1",
    simulated: true,
    title: "빈 입력을 거부하고 공백을 정규화",
    description:
      "수용 기준: 앞뒤 공백 제거, 빈 입력 오류 결과, 유효 입력 대문자 출력.",
    fetchedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const pr = {
    number: 1,
    title: "DEMO-1 입력 계약과 처리 경계 정리",
    body: "공백을 정규화하고 빈 입력을 거부합니다. 테스트 예제를 보강합니다.",
    author: "demo-author",
    repository: "demo/input",
    connection: "demo.invalid/demo",
    url: null,
  };
  const snapshotId = hash(
    JSON.stringify({
      baseSha,
      headSha,
      jira,
      pr,
      parser: ts.version,
      schema: "1",
    }),
  );
  const evidence: Evidence[] = [];
  const ids = new Map<string, string>();
  const shas = [
    baseSha,
    ...git("rev-list", "--reverse", "--topo-order", baseSha + ".." + headSha)
      .trim()
      .split("\n"),
  ];
  const phases = shas.map((sha, index): Phase => {
    const raw = git("cat-file", "commit", sha);
    const cut = raw.indexOf("\n\n");
    const headers = raw.slice(0, cut);
    const message = raw.slice(cut + 2);
    const text = message.replace(/\n$/, "");
    const split = text.indexOf("\n\n");
    const subject = split < 0 ? text : text.slice(0, split);
    const body = split < 0 ? "" : text.slice(split + 2);
    const parents = [...headers.matchAll(/^parent (.+)$/gm)].map((x) => x[1]);
    const comparisonFromSha = index === 0 ? null : parents[0];
    const before = comparisonFromSha ? tree(comparisonFromSha) : [];
    const after = tree(sha);
    const changes = new Map<
      string,
      { status: string; oldPath: string | null; renameEvidence: string | null }
    >();
    if (comparisonFromSha) {
      const parts = git(
        "diff",
        "--no-ext-diff",
        "--name-status",
        "-z",
        "-M",
        comparisonFromSha,
        sha,
      ).split("\0");
      for (let i = 0; i < parts.length - 1;) {
        const status = parts[i++],
          a = parts[i++];
        if (status.startsWith("R")) {
          const b = parts[i++];
          changes.set(b, {
            status: "renamed",
            oldPath: a,
            renameEvidence: "git diff -M " + status,
          });
          ids.set(b, ids.get(a)!);
        } else
          changes.set(a, {
            status:
              (
                { A: "added", M: "modified", D: "deleted" } as Record<
                  string,
                  string
                >
              )[status] || status,
            oldPath: status === "A" ? null : a,
            renameEvidence: null,
          });
      }
    }
    const files: FileState[] = after.map((f) => {
      if (!ids.has(f.path)) ids.set(f.path, hash(f.path).slice(0, 16));
      const c = changes.get(f.path);
      const old = before.find((x) => x.path === (c?.oldPath || f.path));
      return {
        ...f,
        id: ids.get(f.path)!,
        status: c?.status || "unchanged",
        oldPath: old?.path || null,
        oldBlobSha: old?.blobSha || null,
        oldContent: old?.content ?? null,
        renameEvidence: c?.renameEvidence || null,
      };
    });
    for (const [p, c] of changes)
      if (c.status === "deleted") {
        const f = before.find((x) => x.path === p)!;
        files.push({
          ...f,
          id: ids.get(p)!,
          status: "deleted",
          oldPath: p,
          oldBlobSha: f.blobSha,
          oldContent: f.content,
          renameEvidence: null,
        });
      }
    function ev(f: FileState, side: "old" | "new", start = 1, end?: number) {
      const content = side === "old" ? f.oldContent! : f.content;
      const e: Evidence = {
        id: "e" + evidence.length,
        snapshotId,
        commitSha: sha,
        comparisonFromSha,
        revisionSha: side === "old" ? comparisonFromSha! : sha,
        fileId: f.id,
        path: side === "old" ? f.oldPath! : f.path,
        blobSha: side === "old" ? f.oldBlobSha! : f.blobSha,
        side,
        lineStart: start,
        lineEnd: end ?? content.replace(/\n$/, "").split("\n").length,
        contentHash: hash(content),
      };
      evidence.push(e);
      return e.id;
    }
    const edges: Edge[] = [];
    for (const f of files) {
      if (f.oldContent !== null) ev(f, "old");
      if (f.status === "deleted") continue;
      ev(f, "new");
      if (!f.path.endsWith(".ts")) continue;
      const ast = ts.createSourceFile(
        f.path,
        f.content,
        ts.ScriptTarget.Latest,
        true,
      );
      for (const node of ast.statements) {
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          const spec = node.moduleSpecifier.text;
          const targetPath =
            path.posix.normalize(
              path.posix.join(path.posix.dirname(f.path), spec),
            ) + ".ts";
          const target = files.find(
            (x) => x.path === targetPath && x.status !== "deleted",
          );
          if (target) {
            const line =
              ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
            edges.push({
              id: sha + ":" + f.id + ":" + target.id,
              source: f.id,
              target: target.id,
              type: "import",
              provenance: "typescript-ast",
              evidenceId: ev(f, "new", line, line),
            });
          }
        }
      }
    }
    const diff = comparisonFromSha
      ? git(
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "-M",
          "--unified=3",
          comparisonFromSha,
          sha,
        )
      : "";
    return {
      sha,
      parents,
      subject,
      body,
      message,
      author: headers.match(/^author (.+)$/m)?.[1] || "",
      date: git("show", "-s", "--format=%aI", sha).trim(),
      comparisonFromSha,
      files,
      diff,
      hunks: parseHunks(diff, comparisonFromSha || "", sha),
      edges,
    };
  });
  const relatedFileIds = [
    ...new Set(
      phases
        .slice(1)
        .flatMap((p) =>
          p.files.filter((f) => f.status !== "unchanged").map((f) => f.id),
        ),
    ),
  ];
  return {
    snapshotId,
    baseSha,
    headSha,
    mergeBaseShas: git("merge-base", "--all", baseSha, headSha)
      .trim()
      .split("\n"),
    comparisonPolicy: "single merge-base; commit first-parent (linear fixture)",
    baseline: phases[0],
    phases: phases.slice(1),
    netDiff: git("diff", "--no-ext-diff", baseSha, headSha),
    evidence,
    jira,
    pr,
    relatedFileIds,
    coverage: {
      discovered: phases.at(-1)!.files.filter((f) => f.status !== "deleted")
        .length,
      retrieved: phases.at(-1)!.files.filter((f) => f.status !== "deleted")
        .length,
      analyzed: phases
        .at(-1)!
        .files.filter((f) => f.path.endsWith(".ts") && f.status !== "deleted")
        .length,
      omitted: ["README.md: 정적 관계 미지원 (원문 확보)"],
      unavailable: [],
      targetTestsExecuted: false,
      externalCIQueried: false,
      parser: "TypeScript " + ts.version,
    },
  };
}
