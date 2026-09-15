import { AIError } from "./errors.ts";
import { dirname, isAbsolute, normalize, resolve } from "node:path";
import { lstat, open, realpath, readlink } from "node:fs/promises";
import { constants } from "node:fs";

/** Check every intermediate symlink and target ancestor, not only realpath's
 * final payload. Relative links are resolved against their validated parent. */
export async function trustedMacPath(path: string): Promise<string> {
  quotedPath(path);
  let links = 0;
  const inspect = async (absolute: string): Promise<string> => {
    let current = "/";
    for (const part of absolute.split("/").filter(Boolean)) {
      current = resolve(current, part);
      const s = await lstat(current);
      if (s.uid !== 0 && s.uid !== process.getuid?.())
        throw new AIError("cli_missing");
      const systemTemporaryRoot =
        ["/tmp", "/private/tmp"].includes(current) &&
        s.isDirectory() &&
        s.uid === 0 &&
        s.mode & 0o1000;
      if (!s.isSymbolicLink() && s.mode & 0o022 && !systemTemporaryRoot)
        throw new AIError("cli_missing");
      if (s.isSymbolicLink()) {
        if (++links > 40) throw new AIError("cli_missing");
        const target = await readlink(current);
        // Preserve literal components: unsafe/../payload must inspect unsafe,
        // and a symlink followed by .. ascends its resolved target, not its name.
        current = await inspect(
          isAbsolute(target) ? target : `${dirname(current)}/${target}`,
        );
      }
    }
    return current;
  };
  const checked = await inspect(path);
  if (checked !== (await realpath(path))) throw new AIError("cli_missing");
  return checked;
}
/** Validate a native payload and load commands without running otool or a shell. */
export async function validateMacNative(path: string): Promise<void> {
  const resolved = await trustedMacPath(path);
  const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.mode & 0o022) throw new AIError("cli_missing");
    const head = Buffer.alloc(4096);
    await file.read(head, 0, head.length, 0);
    if (!isArm64MachO(head)) throw new AIError("cli_missing");
    let offset = 0,
      sliceEnd = stat.size;
    let subtype: number | undefined;
    if (head.readUInt32LE(0) !== 0xfeedfacf) {
      const fat64 = head.readUInt32BE(0) === 0xcafebabf;
      const count = head.readUInt32BE(4),
        entrySize = fat64 ? 32 : 20;
      const tableEnd = 8 + count * entrySize;
      const ranges: Array<{ start: number; end: number }> = [];
      for (let i = 0; i < count; i++) {
        const pos = 8 + i * entrySize;
        const start = fat64
          ? Number(head.readBigUInt64BE(pos + 8))
          : head.readUInt32BE(pos + 8);
        const length = fat64
          ? Number(head.readBigUInt64BE(pos + 16))
          : head.readUInt32BE(pos + 12);
        const alignment = head.readUInt32BE(pos + (fat64 ? 24 : 16));
        const end = start + length;
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(length) ||
          !Number.isSafeInteger(end) ||
          start < tableEnd ||
          length < 32 ||
          end > stat.size ||
          alignment > 31 ||
          start % 2 ** alignment !== 0 ||
          (fat64 && head.readUInt32BE(pos + 28) !== 0) ||
          ranges.some((range) => start < range.end && end > range.start)
        )
          throw new AIError("cli_missing");
        ranges.push({ start, end });
        if (head.readUInt32BE(pos) === 0x0100000c) {
          offset = start;
          sliceEnd = end;
          subtype = head.readUInt32BE(pos + 4);
        }
      }
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + 32 > stat.size)
      throw new AIError("cli_missing");
    const header = Buffer.alloc(32);
    await file.read(header, 0, 32, offset);
    if (
      header.readUInt32LE(0) !== 0xfeedfacf ||
      !isArm64MachO(header) ||
      (subtype !== undefined && header.readUInt32LE(8) !== subtype)
    )
      throw new AIError("cli_missing");
    const size = header.readUInt32LE(20),
      count = header.readUInt32LE(16);
    if (size > 1024 * 1024 || count > 4096 || offset + 32 + size > sliceEnd)
      throw new AIError("cli_missing");
    const cmds = Buffer.alloc(size);
    await file.read(cmds, 0, size, offset + 32);
    for (let i = 0, p = 0; i < count; i++) {
      if (p + 8 > size) throw new AIError("cli_missing");
      const cmd = cmds.readUInt32LE(p),
        len = cmds.readUInt32LE(p + 4);
      if (len < 8 || p + len > size) throw new AIError("cli_missing");
      // LC_DYLD_ENVIRONMENT must not undo the scrubbed launch environment.
      if (cmd === 0x27) throw new AIError("cli_missing");
      // LC_LOAD_DYLIB, WEAK, REEXPORT, UPWARD and lazy loads. No @rpath,
      // @loader_path or host plugins. System dependencies live on sealed macOS.
      if ([0xc, 0x80000018, 0x8000001f, 0x80000023, 0x20].includes(cmd)) {
        if (len < 24) throw new AIError("cli_missing");
        const name = cmds.readUInt32LE(p + 8);
        if (name < 24 || name >= len) throw new AIError("cli_missing");
        const end = cmds.indexOf(0, p + name);
        if (end < 0 || end >= p + len) throw new AIError("cli_missing");
        const dependency = cmds.toString("utf8", p + name, end);
        if (
          !/^\/(?:usr\/lib\/|System\/Library\/(?:Frameworks|PrivateFrameworks)\/)/.test(
            dependency,
          ) ||
          normalize(dependency) !== dependency
        )
          throw new AIError("cli_missing");
      }
      p += len;
    }
  } finally {
    await file.close();
  }
}

/** Thin ARM64 MH_EXECUTE or a bounded universal container containing one. */
export function isArm64MachO(bytes: Buffer): boolean {
  if (bytes.length < 32) return false;
  if (bytes.readUInt32LE(0) === 0xfeedfacf)
    return bytes.readUInt32LE(4) === 0x0100000c && bytes.readUInt32LE(12) === 2;
  const magic = bytes.readUInt32BE(0);
  if (magic !== 0xcafebabe && magic !== 0xcafebabf) return false;
  const count = bytes.readUInt32BE(4),
    size = magic === 0xcafebabf ? 32 : 20;
  if (count < 1 || count > 32 || 8 + count * size > bytes.length) return false;
  let armSlices = 0;
  for (let i = 0; i < count; i++) {
    const p = 8 + i * size;
    if (bytes.readUInt32BE(p) === 0x0100000c) armSlices++;
  }
  // Do not let dyld select an unvalidated ARM64/ARM64e alternative.
  return armSlices === 1;
}
export function macInvocationArgs(args: string[], schema?: string): string[] {
  return args.map((arg, index) =>
    schema &&
    args[index - 1] === "--output-schema" &&
    arg === "/runtime/schema.json"
      ? schema
      : arg,
  );
}

function quotedPath(path: string): string {
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    path === "/" ||
    /[\x00-\x1f\x7f]/.test(path)
  )
    throw new AIError("sandbox_unavailable");
  return JSON.stringify(path);
}
export interface SeatbeltInput {
  executable: string;
  writable: string[];
  readOnly: string[];
  proxyPort?: number;
}
/** No imports of permissive system profiles. No home/source trees, mach services,
 * DNS, Unix sockets or arbitrary loopback. A native engine runs directly; fork is
 * denied, rather than pretending POSIX process groups are a PID namespace. */
export function buildSeatbeltProfile(input: SeatbeltInput): string {
  const exe = quotedPath(input.executable);
  for (const p of input.writable) {
    quotedPath(p);
    if (!/^\/private\/tmp\/[^/]+\/[^/]+$/.test(p))
      throw new AIError("sandbox_unavailable");
  }
  if (
    input.proxyPort !== undefined &&
    (!Number.isInteger(input.proxyPort) ||
      input.proxyPort < 1 ||
      input.proxyPort > 65535)
  )
    throw new AIError("sandbox_unavailable");
  const systems = [
    "/usr/lib",
    "/System/Library/Frameworks",
    "/System/Library/PrivateFrameworks",
    "/System/Library/dyld",
  ];
  return [
    "(version 1)",
    "(deny default)",
    "(deny process-fork)",
    `(allow process-exec (literal ${exe}))`,
    `(allow file-read* file-map-executable (literal ${exe}))`,
    `(deny file-write* (literal ${exe}))`,
    `(allow file-read-metadata (path-ancestors ${exe}))`,
    ...input.writable.map(
      (p) => `(allow file-read-metadata (literal ${quotedPath(dirname(p))}))`,
    ),
    ...systems.map(
      (p) =>
        `(allow file-read* file-map-executable (subpath ${quotedPath(p)}))`,
    ),
    '(allow file-read* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (literal "/private/etc/ssl/cert.pem"))',
    '(allow file-write-data (literal "/dev/null"))',
    '(allow file-read-metadata (literal "/") (literal "/private") (literal "/private/tmp"))',
    '(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name "kern.osrelease") (sysctl-name "kern.osversion") (sysctl-name "kern.ostype") (sysctl-name "kern.osproductversion") (sysctl-name "kern.version") (sysctl-name "kern.argmax") (sysctl-name "kern.maxfilesperproc") (sysctl-name "kern.hostname") (sysctl-name "sysctl.proc_cputype"))',
    ...input.writable.flatMap((p) => [
      `(allow file-read* file-write* (subpath ${quotedPath(p)}))`,
      `(deny file-write-unlink (literal ${quotedPath(p)}))`,
    ]),
    ...input.readOnly.flatMap((p) => [
      `(allow file-read* (literal ${quotedPath(p)}))`,
      `(deny file-write* (literal ${quotedPath(p)}))`,
    ]),
    ...(input.proxyPort === undefined
      ? []
      : [
          `(allow network-outbound (remote tcp "127.0.0.1:${input.proxyPort}"))`,
        ]),
  ].join("\n");
}
