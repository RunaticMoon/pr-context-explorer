import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, parse } from "node:path";
import { nativeExecutable, projectRoot } from "./sandbox.ts";
import { macEngineCandidates, resolveMacEngine } from "./macos-discovery.ts";
import { trustedMacPath } from "./macos.ts";
import { AIError } from "./errors.ts";
import type { ProviderId } from "./events.ts";

// Server-only identity: never serialize filesystem metadata or credential data.
const identityCache = new Map<string, { stamp: string; digest: string }>();
function stamp(s: BigIntStats): string {
  return [
    s.dev,
    s.ino,
    s.size,
    s.mtimeNs,
    s.ctimeNs,
    s.mode,
    s.uid,
    s.gid,
  ].join(":");
}
export async function executableIdentity(
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const check = () => {
    if (signal?.aborted) throw new AIError("cancelled");
  };
  check();
  let file;
  try {
    if ((await realpath(path)) !== path) throw new Error();
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await file.stat({ bigint: true });
    // Native Claude distributions can exceed 200MB. Bound both work and memory.
    if (
      !before.isFile() ||
      before.size > 1024n * 1024n * 1024n ||
      before.size < 4n ||
      (before.mode & 0o022n) !== 0n ||
      ![0n, BigInt(process.getuid?.() ?? -1)].includes(before.uid)
    )
      throw new Error();
    const metadata = stamp(before);
    const cached = identityCache.get(path);
    let digest = cached?.stamp === metadata ? cached.digest : undefined;
    if (!digest) {
      const hash = createHash("sha256"),
        buffer = Buffer.alloc(1024 * 1024);
      const deadline = performance.now() + 10000;
      let position = 0;
      while (position < Number(before.size)) {
        check();
        if (performance.now() > deadline) throw new Error();
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, Number(before.size) - position),
          position,
        );
        if (!bytesRead) throw new Error();
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      digest = hash.digest("hex");
    }
    check();
    if (
      stamp(await file.stat({ bigint: true })) !== metadata ||
      stamp(await lstat(path, { bigint: true })) !== metadata ||
      (await realpath(path)) !== path
    )
      throw new Error();
    if (identityCache.size >= 32) identityCache.clear();
    identityCache.set(path, { stamp: metadata, digest });
    return createHash("sha256")
      .update(`${path}\0${metadata}\0${digest}`)
      .digest("hex");
  } catch {
    check();
    throw new AIError("cli_missing");
  } finally {
    await file?.close();
  }
}

export function engineCandidates(
  provider: ProviderId,
  app: string,
  home: string,
  platform: string = process.platform,
  arch: string = process.arch,
): string[] {
  if (platform === "darwin") return macEngineCandidates(provider, app, home);
  app = app.replace(/\/$/, "");
  if (platform !== "linux" || !["arm64", "x64"].includes(arch)) return [];
  const pkg =
    provider === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code";
  const payload =
    provider === "codex"
      ? `vendor/${arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl/bin/codex`
      : "claude";
  return [
    ...[
      `${app}/.tools/ai-clis/node_modules`,
      "/usr/local/lib/node_modules",
      "/usr/lib/node_modules",
      `${home}/.npm-global/lib/node_modules`,
    ].flatMap((m) => [
      `${m}/${pkg}-linux-${arch}/${payload}`,
      `${m}/${pkg}/node_modules/${pkg}-linux-${arch}/${payload}`,
    ]),
    `${home}/.local/bin/${provider}`,
    `/usr/local/bin/${provider}`,
    `/usr/bin/${provider}`,
  ];
}
// Check all canonical ancestors before trusting bounded nvm metadata. Never source nvm.
async function trustedDirectory(path: string): Promise<boolean> {
  try {
    if ((await realpath(path)) !== path) return false;
    if (process.platform === "darwin") {
      await trustedMacPath(path);
      return true;
    }
    for (let p = path; ; p = dirname(p)) {
      const s = await lstat(p);
      if (
        !s.isDirectory() ||
        s.isSymbolicLink() ||
        s.mode & 0o022 ||
        ![0, process.getuid?.()].includes(s.uid)
      )
        return false;
      if (p === parse(p).root) return true;
    }
  } catch {
    return false;
  }
}
export async function nvmCandidates(
  provider: ProviderId,
  home: string,
): Promise<string[]> {
  const root = `${home}/.nvm/versions/node`;
  if (!(await trustedDirectory(root))) return [];
  const entries: string[] = [];
  const dir = await opendir(root);
  for await (const entry of dir) {
    if (entries.length >= 32) return []; // bounded; ambiguous oversized installations fail closed
    entries.push(entry.name);
  }
  const result: string[] = [];
  for (const version of entries
    .filter((v) => /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v))
    .sort()
    .reverse()) {
    if (await trustedDirectory(`${root}/${version}`))
      result.push(`${root}/${version}/bin/${provider}`);
  }
  return result;
}
export async function resolveLocalEngine(
  provider: ProviderId,
  configured?: string,
): Promise<string> {
  if (process.platform === "darwin") {
    if (configured) return resolveMacEngine(provider, configured);
    try {
      return await resolveMacEngine(provider);
    } catch {
      /* bounded nvm fallback */
    }
    for (const p of await nvmCandidates(provider, userInfo().homedir)) {
      try {
        return await resolveMacEngine(provider, p);
      } catch {
        /* reject wrappers */
      }
    }
  } else if (process.platform === "linux") {
    if (configured) return nativeExecutable(configured);
    for (const p of [
      ...engineCandidates(provider, projectRoot, userInfo().homedir),
      ...(await nvmCandidates(provider, userInfo().homedir)),
    ]) {
      try {
        const resolved = await realpath(p);
        if (!(await trustedDirectory(dirname(resolved)))) continue;
        if (
          provider === "codex" &&
          resolved.endsWith("/@openai/codex/bin/codex.js")
        ) {
          const modules = resolved.slice(
            0,
            -"/@openai/codex/bin/codex.js".length,
          );
          const payload = `vendor/${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl/bin/codex`;
          for (const native of [
            `${modules}/@openai/codex/node_modules/@openai/codex-linux-${process.arch}/${payload}`,
            `${modules}/@openai/codex-linux-${process.arch}/${payload}`,
          ]) {
            try {
              if (await trustedDirectory(dirname(native)))
                return await nativeExecutable(native);
            } catch {
              /* next */
            }
          }
        } else return await nativeExecutable(p);
      } catch {
        /* next fixed candidate */
      }
    }
  }
  throw new AIError("cli_missing");
}
