import * as yauzl from "yauzl";
import { crc32 } from "node:zlib";
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { APP_NAME, MAX_EXPANDED, fail, type Manifest } from "./policy.ts";
import { safeFile, exclusiveFile, ancestors, ownedRemove } from "./files.ts";
interface Item {
  entry: yauzl.Entry;
  name: string;
  kind: "directory" | "file" | "link";
  mode: number;
  target?: string;
}
export function archivePath(name: string): string {
  if (
    name.length > 1024 ||
    name !== name.normalize("NFC") ||
    /[\\:\x00-\x1f\x7f]/.test(name) ||
    name.startsWith("/")
  )
    fail("ZIP_PATH");
  const normalized = name.replace(/\/$/, "");
  const parts = normalized.split("/");
  if (
    parts[0] !== APP_NAME ||
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        p.startsWith("._") ||
        p === "__MACOSX" ||
        /[. ]$/.test(p),
    )
  )
    fail("ZIP_PATH");
  return normalized;
}
export async function extractVerifiedZip(
  file: string,
  destination: string,
  manifest: Manifest,
  signal: AbortSignal,
): Promise<string> {
  const h = await safeFile(file, true);
  let zip: yauzl.ZipFile | undefined;
  let made = false;
  const cancelled = () => {
    if (signal.aborted) fail("CANCELLED");
  };
  try {
    const size = (await h.stat()).size;
    if (size !== manifest.asset.size) fail("HASH_MISMATCH");
    const hash = createHash("sha256");
    for await (const b of h.createReadStream({ autoClose: false, start: 0 })) {
      cancelled();
      hash.update(b);
    }
    if (hash.digest("hex") !== manifest.asset.sha256) fail("HASH_MISMATCH");
    zip = await yauzl.fromFdPromise(h.fd, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    });
    let zipError: Error | undefined;
    zip.on("error", (e) => {
      zipError = e;
    });
    if (zip.entryCount > 50000 || zip.entryCount === 0) fail("ZIP_LIMIT");
    const items: Item[] = [],
      names = new Map<string, Item>(),
      caseNames = new Map<string, string>();
    let expanded = 0;
    const ranges: { start: number; end: number }[] = [];
    for await (const entry of zip.eachEntry()) {
      cancelled();
      const name = archivePath(entry.fileName);
      const mode = entry.externalFileAttributes >>> 16,
        type = mode & 0o170000;
      if (
        (entry.generalPurposeBitFlag & ~0x080e) !== 0 ||
        ![0, 8].includes(entry.compressionMethod) ||
        (mode & 0o7000) !== 0
      )
        fail("ZIP_UNSUPPORTED");
      const kind =
        type === 0o120000
          ? "link"
          : entry.fileName.endsWith("/")
            ? "directory"
            : "file";
      if (
        type &&
        type !==
          (kind === "link"
            ? 0o120000
            : kind === "directory"
              ? 0o040000
              : 0o100000)
      )
        fail("ZIP_TYPE");
      if (
        !Number.isSafeInteger(entry.uncompressedSize) ||
        entry.uncompressedSize < 0 ||
        entry.uncompressedSize > 1_000_000_000 ||
        entry.compressedSize < 0 ||
        entry.uncompressedSize > Math.max(entry.compressedSize * 300, 1_000_000)
      )
        fail("ZIP_LIMIT");
      expanded += entry.uncompressedSize;
      if (
        expanded > MAX_EXPANDED ||
        (kind === "directory" && entry.uncompressedSize !== 0) ||
        (kind === "link" && entry.uncompressedSize > 1024)
      )
        fail("ZIP_LIMIT");
      if (names.has(name)) fail("ZIP_DUPLICATE");
      // Check every component, including implicitly-created directories.
      const parts = name.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join("/"),
          key = prefix.normalize("NFD").toLowerCase();
        const prior = caseNames.get(key);
        if (prior && prior !== prefix) fail("ZIP_CASE_COLLISION");
        caseNames.set(key, prefix);
      }
      const local = Buffer.alloc(30);
      if (
        (await h.read(local, 0, 30, entry.relativeOffsetOfLocalHeader))
          .bytesRead !== 30 ||
        local.readUInt32LE(0) !== 0x04034b50 ||
        local.readUInt16LE(6) !== entry.generalPurposeBitFlag ||
        local.readUInt16LE(8) !== entry.compressionMethod
      )
        fail("ZIP_LOCAL_HEADER");
      const nameSize = local.readUInt16LE(26),
        extraSize = local.readUInt16LE(28),
        rawName = Buffer.alloc(nameSize);
      await h.read(
        rawName,
        0,
        nameSize,
        entry.relativeOffsetOfLocalHeader + 30,
      );
      if (!rawName.equals(entry.fileNameRaw)) fail("ZIP_LOCAL_HEADER");
      const end =
        entry.relativeOffsetOfLocalHeader +
        30 +
        nameSize +
        extraSize +
        entry.compressedSize;
      if (end > size) fail("ZIP_LIMIT");
      ranges.push({ start: entry.relativeOffsetOfLocalHeader, end });
      const item: Item = { entry, name, kind, mode };
      items.push(item);
      names.set(name, item);
    }
    ranges.sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i++)
      if (ranges[i].start < ranges[i - 1].end) fail("ZIP_OVERLAP");
    for (const item of items) {
      let parent = path.posix.dirname(item.name);
      while (parent !== ".") {
        const ancestor = names.get(parent);
        if (ancestor && ancestor.kind !== "directory") fail("ZIP_LINK_PARENT");
        parent = path.posix.dirname(parent);
      }
    }
    async function consume(item: Item, sink: (chunk: Buffer) => Promise<void>) {
      cancelled();
      let actual = 0,
        crc = 0;
      const stream = await zip!.openReadStreamPromise(item.entry);
      try {
        for await (const b of stream) {
          cancelled();
          const chunk = Buffer.from(b);
          actual += chunk.length;
          if (actual > item.entry.uncompressedSize) fail("ZIP_LIMIT");
          crc = crc32(chunk, crc);
          await sink(chunk);
        }
      } finally {
        stream.destroy();
      }
      if (actual !== item.entry.uncompressedSize || crc !== item.entry.crc32)
        fail("ZIP_CRC");
    }
    // Read and resolve all symlinks before creating any extracted file.
    for (const item of items.filter((i) => i.kind === "link")) {
      const chunks: Buffer[] = [];
      await consume(item, async (c) => {
        chunks.push(c);
      });
      const raw = Buffer.concat(chunks);
      const target = raw.toString("utf8");
      if (
        !Buffer.from(target).equals(raw) ||
        !target ||
        target.startsWith("/") ||
        /[\\:\x00-\x1f\x7f]/.test(target)
      )
        fail("ZIP_LINK");
      item.target = target;
    }
    const existing = (p: string) =>
      names.has(p) || items.some((i) => i.name.startsWith(p + "/"));
    for (const item of items.filter((i) => i.kind === "link")) {
      let resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(item.name), item.target!),
      );
      let hops = 0;
      for (;;) {
        if (resolved !== APP_NAME && !resolved.startsWith(APP_NAME + "/"))
          fail("ZIP_LINK");
        const parts = resolved.split("/");
        let replaced = false;
        for (let i = 1; i <= parts.length; i++) {
          const prefix = parts.slice(0, i).join("/"),
            link = names.get(prefix);
          if (link?.kind === "link") {
            if (++hops > 32) fail("ZIP_LINK_CYCLE");
            resolved = path.posix.normalize(
              path.posix.join(
                path.posix.dirname(prefix),
                link.target!,
                ...parts.slice(i),
              ),
            );
            replaced = true;
            break;
          }
        }
        if (!replaced) break;
      }
      if (!existing(resolved)) fail("ZIP_LINK_MISSING");
    }
    if (zipError) fail("INVALID_ZIP");
    await ancestors(path.dirname(destination));
    await mkdir(destination, { mode: 0o700 });
    made = true;
    for (const item of items) {
      cancelled();
      const output = path.join(destination, item.name);
      await mkdir(path.dirname(output), { recursive: true, mode: 0o755 });
      if (item.kind === "directory") {
        await mkdir(output, { recursive: true, mode: 0o755 });
      } else if (item.kind === "file") {
        const out = await exclusiveFile(
          output,
          item.mode & 0o111 ? 0o755 : 0o644,
        );
        try {
          await consume(item, (c) => out.writeFile(c));
          await out.sync();
        } finally {
          await out.close();
        }
      }
    }
    for (const item of items.filter((i) => i.kind === "link"))
      await symlink(item.target!, path.join(destination, item.name));
    cancelled();
    if (zipError) fail("INVALID_ZIP");
    return path.join(destination, APP_NAME);
  } catch (e) {
    if (made) await ownedRemove(destination);
    throw e;
  } finally {
    await h.close();
  } // fromFd autoClose=false: the FileHandle owns the descriptor.
}
