import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
test("snapshot ingestion pins metadata twice and rejects force-push/body-only races before caching", async () => {
  const { ingestPull } = await import("../src/server/ingest.ts");
  const root = mkdtempSync(path.join(tmpdir(), "prce-ingest-"));
  const c = {
    id: "public",
    type: "github" as const,
    webUrl: "https://github.com",
    apiUrl: "https://api.github.com",
    apiVersion: "2022-11-28",
    account: "public",
    auth: { kind: "public" as const },
  };
  const meta = {
    number: 1,
    title: "Title",
    body: "Before",
    html_url: "https://github.com/acme/repo/pull/1",
    user: { login: "alice" },
    state: "open",
    draft: false,
    base: {
      sha: "a".repeat(40),
      ref: "main",
      repo: { full_name: "acme/repo" },
    },
    head: {
      sha: "b".repeat(40),
      ref: "feature",
      repo: { full_name: "fork/repo" },
    },
  };
  let n = 0;
  let fetched: any;
  const client = {
    pull: async () => (n++ ? { ...meta, body: "Changed" } : meta),
    pages: async () => ({ items: [], complete: true, limitReason: null }),
  };
  try {
    await assert.rejects(
      () =>
        ingestPull(c, meta.html_url, root, {
          client: client as any,
          fetchObjects: async (...args: any[]) => {
            fetched = args;
            return "/not-used";
          },
          collect: async () => ({ snapshotId: "x", coverage: {} }) as any,
        }),
      /stale/,
    );
    assert.equal(fetched[1].head.sha, meta.head.sha);
    n = 0;
    const evil = {
      ...meta,
      head: { ...meta.head, repo: { full_name: "../../evil" } },
    };
    await assert.rejects(
      () =>
        ingestPull(c, meta.html_url, root, {
          client: { ...client, pull: async () => evil } as any,
          fetchObjects: async () => {
            throw Error("must not fetch");
          },
        }),
      /repository/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
