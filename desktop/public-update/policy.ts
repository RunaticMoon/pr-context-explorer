export const REPOSITORY = "RunaticMoon/pr-context-explorer-releases";
export const APP_NAME = "PR Context Explorer.app";
export const MAX_ZIP = 1_500_000_000;
export const MAX_EXPANDED = 4_000_000_000;
export class UpdateError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "UpdateError";
  }
}
export function fail(code: string): never {
  throw new UpdateError(code);
}
export function record(x: unknown): Record<string, unknown> {
  if (!x || typeof x !== "object" || Array.isArray(x)) fail("INVALID_METADATA");
  return x as Record<string, unknown>;
}
export function keys(x: Record<string, unknown>, expected: string[]) {
  if (Object.keys(x).sort().join(",") !== expected.sort().join(","))
    fail("INVALID_METADATA");
}
export function version(x: unknown): string {
  if (
    typeof x !== "string" ||
    !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(x)
  )
    fail("INVALID_VERSION");
  return x;
}
export function compareVersions(a: string, b: string): number {
  const aa = version(a).split(".").map(Number),
    bb = version(b).split(".").map(Number);
  for (let i = 0; i < 3; i++)
    if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}
export interface Manifest {
  schemaVersion: 1;
  channel: "public-personal-unsigned";
  repository: typeof REPOSITORY;
  version: string;
  tag: string;
  sourceCommit: string;
  platform: "darwin";
  arch: "arm64";
  asset: { name: string; size: number; sha256: string };
}
export function validateManifest(input: unknown, tag: string): Manifest {
  const x = record(input);
  keys(x, [
    "schemaVersion",
    "channel",
    "repository",
    "version",
    "tag",
    "sourceCommit",
    "platform",
    "arch",
    "asset",
  ]);
  const v = version(x.version),
    a = record(x.asset);
  keys(a, ["name", "size", "sha256"]);
  if (
    x.schemaVersion !== 1 ||
    x.channel !== "public-personal-unsigned" ||
    x.repository !== REPOSITORY ||
    x.tag !== `v${v}` ||
    x.tag !== tag ||
    x.platform !== "darwin" ||
    x.arch !== "arm64" ||
    typeof x.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(x.sourceCommit) ||
    a.name !== `PR-Context-Explorer-${v}-arm64.zip` ||
    !Number.isSafeInteger(a.size) ||
    (a.size as number) <= 0 ||
    (a.size as number) > MAX_ZIP ||
    typeof a.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(a.sha256)
  )
    fail("INVALID_METADATA");
  return structuredClone(x) as unknown as Manifest;
}
export function validateURL(
  value: string,
  kind: "api" | "asset" | "redirect",
): URL {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return fail("UNSAFE_URL");
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash)
    fail("UNSAFE_URL");
  const root = `/${REPOSITORY}/releases/download/`;
  const github =
    u.hostname === "github.com" &&
    u.pathname.startsWith(root) &&
    !u.search &&
    !/%2f|%5c|%2e/i.test(u.pathname);
  const api =
    u.hostname === "api.github.com" &&
    u.pathname === `/repos/${REPOSITORY}/releases` &&
    /^\?per_page=100&page=[1-5]$/.test(u.search);
  const cdn =
    [
      "release-assets.githubusercontent.com",
      "objects.githubusercontent.com",
    ].includes(u.hostname) &&
    u.pathname.startsWith("/github-production-release-asset");
  if (!(kind === "api" ? api : kind === "asset" ? github : github || cdn))
    fail("UNSAFE_URL");
  return u;
}
export function assetURL(tag: string, name: string): string {
  return `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

/** JSON grammar is delegated to Node; this pass rejects ambiguous keys/depth. */
export function parseJSON(bytes: Buffer): unknown {
  let text: string, result: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    result = JSON.parse(text);
  } catch {
    return fail("INVALID_JSON");
  }
  const stack: (Set<string> | null)[] = [];
  const tokens = /"(?:[^"\\]|\\.)*"|[{}\[\]]/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === "{" || token === "[") {
      stack.push(token === "{" ? new Set() : null);
      if (stack.length > 20) fail("JSON_DEPTH");
    } else if (token === "}" || token === "]") stack.pop();
    else if (
      text
        .slice(match.index! + token.length)
        .trimStart()
        .startsWith(":")
    ) {
      const key = JSON.parse(token) as string,
        seen = stack[stack.length - 1];
      if (!seen || seen.has(key)) fail("DUPLICATE_JSON_KEY");
      seen.add(key);
    }
  }
  return result;
}
