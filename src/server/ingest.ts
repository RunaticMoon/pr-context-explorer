import {
  existsSync,
  lstatSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
} from "node:fs";
export function pruneGitCache(
  root: string,
  retentionMs: number,
  now = Date.now(),
) {
  const git = path.join(root, "git");
  if (!existsSync(git)) return 0;
  if (lstatSync(git).isSymbolicLink()) throw Error("unsafe Git cache root");
  let count = 0;
  for (const name of readdirSync(git)) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const dir = path.join(git, name),
      marker = path.join(dir, "prce-owned");
    if (
      lstatSync(dir).isSymbolicLink() ||
      !existsSync(marker) ||
      lstatSync(marker).isSymbolicLink()
    )
      continue;
    if (
      readFileSync(marker, "utf8") === "PRCE app-only bare cache v1\n" &&
      lstatSync(marker).mtimeMs + retentionMs < now
    ) {
      rmSync(dir, { recursive: true });
      count++;
    }
  }
  return count;
}
import path from "node:path";
import { lookup } from "node:dns/promises";
import { GitHubClient, parsePullURL, type Connection } from "./github.ts";
import { resolveCredential } from "./transport.ts";
import {
  runGit,
  collectGit,
  type CollectInput,
  type LiveSnapshot,
} from "./live-git.ts";
import { cacheKey, privateDirectory } from "./store.ts";
const repository = (name: unknown): string => {
  if (
    typeof name !== "string" ||
    !/^[\w.-]+\/[\w.-]+$/.test(name) ||
    name.split("/").some((x) => x === "." || x === "..")
  )
    throw Error("invalid repository identity");
  return name;
};
export const bareCachePath = (c: Connection, repo: string, root: string) =>
  path.join(root, "git", cacheKey({ connection: c, repository: repo }));
export async function fetchObjects(
  c: Connection,
  meta: any,
  root: string,
  signal?: AbortSignal,
): Promise<string> {
  const repo = repository(meta.base.repo.full_name);
  if (meta.head.repo) repository(meta.head.repo.full_name);
  const host = new URL(c.webUrl).hostname;
  const addresses = await lookup(host, { all: true });
  if (
    addresses.some((x) =>
      /^(127\.|169\.254\.|0\.|::1$|fe80:|::ffff:(127\.|169\.254\.))/i.test(
        x.address,
      ),
    )
  )
    throw Error("blocked Git endpoint address");
  if (process.env.HTTPS_PROXY || process.env.https_proxy)
    throw Error(
      "proxy_configuration: Git fetch proxy support is not verified; use approved direct/VPN access",
    );
  const bare = bareCachePath(c, repo, root);
  privateDirectory(path.dirname(bare));
  if (!existsSync(bare)) {
    privateDirectory(bare);
    await runGit(bare, ["init", "--bare", "--template="], signal);
    writeFileSync(
      path.join(bare, "prce-owned"),
      "PRCE app-only bare cache v1\n",
      { mode: 0o600, flag: "wx" },
    );
  }
  if (
    lstatSync(bare).isSymbolicLink() ||
    !existsSync(path.join(bare, "prce-owned")) ||
    lstatSync(path.join(bare, "prce-owned")).isSymbolicLink() ||
    readFileSync(path.join(bare, "prce-owned"), "utf8") !==
      "PRCE app-only bare cache v1\n"
  )
    throw Error("untrusted bare cache");
  const token = await resolveCredential(c);
  const configuration: Record<string, string> = {
    "http.followRedirects": "false",
    "http.sslVerify": "true",
    "credential.helper": "",
    "fetch.recurseSubmodules": "false",
  };
  if (token)
    configuration[`http.${c.webUrl}/.extraHeader`] =
      "Authorization: Basic " +
      Buffer.from("x-access-token:" + token).toString("base64");
  // The credential exists only in the credential-bearing Git collector environment, never argv/config/model.
  if (process.env.NODE_EXTRA_CA_CERTS)
    configuration["http.sslCAInfo"] = process.env.NODE_EXTRA_CA_CERTS;
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(Object.keys(configuration).length),
  };
  Object.entries(configuration).forEach(([k, v], i) => {
    env["GIT_CONFIG_KEY_" + i] = k;
    env["GIT_CONFIG_VALUE_" + i] = v;
  });
  const fetch = async (name: string, sha: string) => {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw Error("invalid pinned SHA");
    await runGit(
      bare,
      [
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        `${c.webUrl}/${repository(name)}.git`,
        sha,
      ],
      signal,
      env,
    );
  };
  await fetch(repo, meta.base.sha);
  try {
    await fetch(repo, meta.head.sha);
  } catch (e) {
    signal?.throwIfAborted();
    if (!meta.head.repo)
      throw Error("deleted_or_inaccessible_fork: pinned head not obtainable");
    await fetch(repository(meta.head.repo.full_name), meta.head.sha);
  }
  for (const sha of [meta.base.sha, meta.head.sha])
    if (
      (
        await runGit(bare, ["rev-parse", "--verify", sha + "^{commit}"], signal)
      ).trim() !== sha
    )
      throw Error("fetched revision mismatch");
  const now = new Date();
  utimesSync(path.join(bare, "prce-owned"), now, now);
  return bare;
}
export async function ingestPull(
  c: Connection,
  url: string,
  root: string,
  options: {
    client?: GitHubClient;
    fetchObjects?: typeof fetchObjects;
    collect?: (input: CollectInput) => Promise<LiveSnapshot>;
    signal?: AbortSignal;
    onProgress?: (s: string) => void;
  } = {},
) {
  const ref = parsePullURL(url, c),
    client = options.client || new GitHubClient(c),
    signal = options.signal;
  options.onProgress?.("Verify account and pin PR metadata");
  const user =
    c.auth.kind === "public"
      ? { login: c.account, id: 0 }
      : await client.verify(signal);
  const first = await client.pull(ref, signal);
  repository(first.base.repo.full_name);
  if (first.head.repo) repository(first.head.repo.full_name);
  if (
    first.base.repo.full_name.toLowerCase() !==
    `${ref.owner}/${ref.repo}`.toLowerCase()
  )
    throw Error("PR repository mismatch");
  const fingerprint = (m: any) =>
    cacheKey({
      base: m.base.sha,
      head: m.head.sha,
      title: m.title,
      body: m.body,
      baseRepo: m.base.repo?.full_name,
      headRepo: m.head.repo?.full_name,
      state: m.state,
      draft: m.draft,
      baseRef: m.base.ref,
      headRef: m.head.ref,
    });
  const original = fingerprint(first);
  const api: any = {};
  for (const kind of ["commits", "files"] as const) {
    try {
      const page = await client.pages(ref, kind, signal);
      api[kind] = {
        retrieved: page.items.length,
        paginationComplete: page.complete,
        limitReason: page.limitReason,
        missingPatch:
          kind === "files"
            ? page.items.filter((x) => !x.patch).length
            : undefined,
      };
    } catch (e) {
      signal?.throwIfAborted();
      api[kind] = {
        paginationComplete: false,
        error: "API collection unavailable; Git objects used for history/files",
      };
    }
  }
  options.onProgress?.("Fetch fixed Git objects into private bare cache");
  const bare = await (options.fetchObjects || fetchObjects)(
    c,
    first,
    root,
    signal,
  );
  const snapshot = await (options.collect || collectGit)({
    barePath: bare,
    baseSha: first.base.sha,
    headSha: first.head.sha,
    identity: {
      connectionId: c.id,
      accountContextId: `${c.webUrl}:${user.login}:${user.id}`,
      repository: first.base.repo.full_name,
      number: ref.number,
    },
    pr: {
      title: first.title,
      body: first.body || "",
      author: first.user?.login || "unknown",
      url: first.html_url,
      baseRef: first.base.ref,
      headRef: first.head.ref,
      state: first.state,
      draft: !!first.draft,
    },
    signal,
    onProgress: options.onProgress,
  });
  options.onProgress?.("Recheck pinned PR revisions and body");
  const final = await client.pull(ref, signal);
  if (fingerprint(final) !== original)
    throw Error(
      "stale_snapshot: PR base/head/metadata changed during collection; retry explicitly",
    );
  snapshot.coverage.api = api;
  return snapshot;
}
