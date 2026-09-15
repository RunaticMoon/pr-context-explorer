import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { collectGit, type LiveSnapshot } from "../src/server/live-git.ts";
// Actual Git object DAGs; no checkout execution or mocked Git command responses.
export function objectFixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(path.join(tmpdir(), "prce-core-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bare = path.join(root, "repo.git");
  mkdirSync(bare);
  const env = {
    PATH: process.env.PATH,
    HOME: "/nonexistent",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Review",
    GIT_AUTHOR_EMAIL: "review@example.invalid",
    GIT_COMMITTER_NAME: "Review",
    GIT_COMMITTER_EMAIL: "review@example.invalid",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  const git = (args: string[], input?: string) =>
    execFileSync(
      "git",
      ["--git-dir=" + bare, "-c", "core.hooksPath=/dev/null", ...args],
      { encoding: "utf8", env, input },
    ).trim();
  git(["init", "--bare", "--template=", "-q"]);
  const commit = (
    files: Record<string, string>,
    parents: string[] = [],
    message = "fixture",
  ) => {
    const rows = Object.entries(files)
      .sort()
      .map(
        ([name, text]) =>
          "100644 blob " +
          git(["hash-object", "-w", "--stdin"], text) +
          "\t" +
          name +
          "\n",
      )
      .join("");
    return git([
      "commit-tree",
      git(["mktree"], rows),
      ...parents.flatMap((p) => ["-p", p]),
      "-m",
      message,
    ]);
  };
  const collect = (base: string, head: string) =>
    collectGit({
      barePath: bare,
      baseSha: base,
      headSha: head,
      identity: {
        connectionId: "review",
        accountContextId: "public:review",
        repository: "review/fixture",
        number: 1,
      },
      pr: {
        title: "Synthetic objects",
        body: "",
        author: "review",
        url: "https://github.com/review/fixture/pull/1",
      },
    });
  return { commit, collect };
}
