import https from "node:https";
import dns from "node:dns";
import { BlockList, isIP } from "node:net";
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  REPOSITORY,
  validateURL,
  assetURL,
  fail,
  compareVersions,
  version,
  record,
  parseJSON,
  validateManifest,
  type Manifest,
} from "./policy.ts";
const blocked = new BlockList();
for (const [a, b] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(a, b, "ipv4");
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
const blocked6 = new BlockList();
for (const [a, b] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blocked6.addSubnet(a, b, "ipv6");
export function isPublicAddress(a: string): boolean {
  return isIP(a) === 4
    ? !blocked.check(a, "ipv4")
    : isIP(a) === 6 && global6.check(a, "ipv6") && !blocked6.check(a, "ipv6");
}
const safeLookup: typeof dns.lookup = ((
  hostname: string,
  options: unknown,
  callback: (...args: unknown[]) => void,
) => {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (
      err ||
      !addresses.length ||
      addresses.some((a) => !isPublicAddress(a.address))
    )
      return callback(new Error("UNSAFE_DNS"));
    if ((options as { all?: boolean })?.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}) as typeof dns.lookup;
export type Transport = (
  url: URL,
  signal: AbortSignal,
) => Promise<import("node:http").IncomingMessage>;
const productionTransport: Transport = (url, signal) =>
  new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        agent: false,
        rejectUnauthorized: true,
        lookup: safeLookup,
        signal,
        headers: {
          "User-Agent": "PR-Context-Explorer-Public-Updater",
          Accept: "application/vnd.github+json",
          "Accept-Encoding": "identity",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
      resolve,
    );
    req.setTimeout(30_000, () => req.destroy(new Error("TIMEOUT")));
    req.on("error", () => reject(new Error("NETWORK")));
  });
// Internal test seam, never accepted by PublicUpdater's host options or IPC.
export async function fetchBytes(
  url: string,
  kind: "api" | "asset",
  limit: number,
  signal: AbortSignal,
  sink?: (chunk: Buffer) => Promise<void>,
  transport: Transport = productionTransport,
): Promise<Buffer> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, kind === "api" ? 60_000 : 600_000);
  const chunks: Buffer[] = [];
  try {
    let current = validateURL(url, kind);
    let total = 0;
    for (let redirects = 0; redirects <= 4; redirects++) {
      if (controller.signal.aborted) fail("CANCELLED");
      const response = await transport(current, controller.signal);
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy();
        if (
          kind === "api" ||
          redirects === 4 ||
          typeof response.headers.location !== "string"
        )
          fail("REDIRECT");
        current = validateURL(
          new URL(response.headers.location, current).href,
          "redirect",
        );
        continue;
      }
      if (status !== 200) {
        response.destroy();
        fail(status === 403 || status === 429 ? "RATE_LIMITED" : "HTTP_STATUS");
      }
      if (
        response.headers["content-encoding"] &&
        response.headers["content-encoding"] !== "identity"
      ) {
        response.destroy();
        fail("CONTENT_ENCODING");
      }
      const length = response.headers["content-length"];
      if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
        response.destroy();
        fail("BODY_LIMIT");
      }
      try {
        for await (const part of response) {
          const chunk = Buffer.from(part);
          total += chunk.length;
          if (total > limit) fail("BODY_LIMIT");
          if (sink) await sink(chunk);
          else chunks.push(chunk);
        }
      } finally {
        response.destroy();
      }
      if (controller.signal.aborted) fail("CANCELLED");
      if (length && total !== Number(length)) fail("TRUNCATED");
      return Buffer.concat(chunks);
    }
    return fail("REDIRECT");
  } catch (e) {
    if (controller.signal.aborted)
      fail(signal.aborted ? "CANCELLED" : "TIMEOUT");
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
export interface Release {
  tag_name: string;
  draft: false;
  prerelease: false;
  assets: Record<string, unknown>[];
}
export function chooseRelease(rows: unknown, current: string): Release | null {
  if (!Array.isArray(rows) || rows.length > 500) fail("INVALID_RELEASES");
  let chosen: Release | null = null;
  const seen = new Set<string>();
  for (const raw of rows) {
    const x = record(raw);
    if (x.draft !== false || x.prerelease !== false) continue;
    if (
      typeof x.tag_name !== "string" ||
      !/^v(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(
        x.tag_name,
      )
    )
      continue;
    const v = version(x.tag_name.slice(1));
    if (seen.has(v)) fail("DUPLICATE_RELEASE");
    seen.add(v);
    if (compareVersions(v, current) <= 0) continue;
    if (!Array.isArray(x.assets) || x.assets.length > 30)
      fail("INVALID_ASSETS");
    if (!chosen || compareVersions(v, chosen.tag_name.slice(1)) > 0)
      chosen = x as unknown as Release;
  }
  return chosen;
}
export function validateAssetAgreement(
  release: Release,
  expected: { name: string; size?: number },
): number {
  const matches = release.assets.filter((a) => a.name === expected.name);
  if (matches.length !== 1) fail("ASSET_MISMATCH");
  const a = matches[0];
  if (
    a.state !== "uploaded" ||
    !Number.isSafeInteger(a.size) ||
    (a.size as number) <= 0 ||
    (expected.size !== undefined && a.size !== expected.size) ||
    a.browser_download_url !== assetURL(release.tag_name, expected.name)
  )
    fail("ASSET_MISMATCH");
  return a.size as number;
}
export async function discover(
  current: string,
  signal: AbortSignal,
): Promise<Manifest | null> {
  const rows: unknown[] = [];
  for (let page = 1; page <= 5; page++) {
    const data = parseJSON(
      await fetchBytes(
        `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100&page=${page}`,
        "api",
        2_000_000,
        signal,
      ),
    );
    if (!Array.isArray(data) || data.length > 100) fail("INVALID_RELEASES");
    rows.push(...data);
    if (data.length < 100) break;
    if (page === 5) fail("PAGINATION_LIMIT");
  }
  const release = chooseRelease(rows, current);
  if (!release) return null;
  const size = validateAssetAgreement(release, { name: "public-mac.json" });
  if (size > 16384) fail("BODY_LIMIT");
  const bytes = await fetchBytes(
    assetURL(release.tag_name, "public-mac.json"),
    "asset",
    size,
    signal,
  );
  if (bytes.length !== size) fail("ASSET_MISMATCH");
  const manifest = validateManifest(parseJSON(bytes), release.tag_name);
  validateAssetAgreement(release, manifest.asset);
  return manifest;
}
export async function downloadAsset(
  manifest: Manifest,
  file: FileHandle,
  signal: AbortSignal,
  progress: (n: number) => void,
) {
  let received = 0;
  const hash = createHash("sha256");
  let last = 0;
  await fetchBytes(
    assetURL(manifest.tag, manifest.asset.name),
    "asset",
    manifest.asset.size,
    signal,
    async (chunk) => {
      hash.update(chunk);
      await file.writeFile(chunk);
      received += chunk.length;
      if (Date.now() - last > 100) {
        progress(received);
        last = Date.now();
      }
    },
  );
  if (
    received !== manifest.asset.size ||
    hash.digest("hex") !== manifest.asset.sha256
  )
    fail("HASH_MISMATCH");
  await file.sync();
  progress(received);
}
