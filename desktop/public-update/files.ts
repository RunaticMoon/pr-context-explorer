import { constants } from "node:fs";
import {
  lstat,
  link,
  unlink,
  mkdir,
  open,
  realpath,
  rm,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fail } from "./policy.ts";
import { checkNativeACL } from "./acl.ts";
export const uid = () => process.getuid?.() ?? fail("UNSUPPORTED_PLATFORM");
export async function ancestors(directory: string) {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory)
    fail("UNSAFE_PATH");
  let cursor = path.parse(directory).root;
  for (const part of [
    "",
    ...directory.slice(cursor.length).split(path.sep).filter(Boolean),
  ]) {
    if (part) cursor = path.join(cursor, part);
    const s = await lstat(cursor);
    if (
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      ![0, uid()].includes(s.uid) ||
      ((s.mode & 0o022) !== 0 &&
        !(s.uid === 0 && (s.mode & 0o1000) !== 0) &&
        !(
          process.platform === "darwin" &&
          cursor === "/Applications" &&
          s.uid === 0 &&
          s.gid === 80 &&
          (s.mode & 0o777) === 0o775
        ))
    )
      fail("UNSAFE_DIRECTORY");
    await checkNativeACL(cursor, true);
  }
  if ((await realpath(directory)) !== directory) fail("UNSAFE_DIRECTORY");
}
export async function privateDirectory(directory: string) {
  await ancestors(path.dirname(directory));
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const s = await lstat(directory);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== uid() ||
    (s.mode & 0o777) !== 0o700
  )
    fail("UNSAFE_DIRECTORY");
  await checkNativeACL(directory, true);
  return directory;
}
export async function safeFile(
  file: string,
  privateOnly = false,
): Promise<FileHandle> {
  await ancestors(path.dirname(file));
  const h = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await h.stat();
    if (
      !s.isFile() ||
      s.nlink !== 1 ||
      s.uid !== uid() ||
      s.mode & (privateOnly ? 0o077 : 0o022)
    )
      fail("UNSAFE_FILE");
    await checkNativeACL(file, false);
    return h;
  } catch (e) {
    await h.close();
    throw e;
  }
}
export async function exclusiveFile(file: string, mode = 0o600) {
  await ancestors(path.dirname(file));
  return open(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    mode,
  );
}
export async function writePrivate(file: string, value: unknown) {
  const temp = path.join(
    path.dirname(file),
    `.receipt-${randomBytes(16).toString("hex")}`,
  );
  const h = await exclusiveFile(temp);
  try {
    await h.writeFile(JSON.stringify(value));
    await h.sync();
  } finally {
    await h.close();
  }
  try {
    // Atomic no-replace publication: readers never observe an incomplete JSON
    // document and an existing foreign directory entry is never overwritten.
    await link(temp, file);
  } finally {
    await unlink(temp);
  }
}
export async function readPrivate(
  file: string,
  limit = 32768,
): Promise<unknown> {
  // Hard-link publication has a very short nlink=2 interval. Never accept the
  // extra link; wait for its removal, then perform the ordinary nofollow check.
  for (let attempt = 0; attempt < 20; attempt++) {
    const stat = await lstat(file);
    if (stat.nlink !== 2) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  const h = await safeFile(file, true);
  try {
    if ((await h.stat()).size > limit) fail("BODY_LIMIT");
    return JSON.parse(await h.readFile("utf8"));
  } finally {
    await h.close();
  }
}
export async function hashFile(
  file: string,
): Promise<{ size: number; sha256: string }> {
  const h = await safeFile(file);
  try {
    const hash = createHash("sha256");
    let size = 0;
    for await (const b of h.createReadStream({ autoClose: false })) {
      size += b.length;
      hash.update(b);
    }
    return { size, sha256: hash.digest("hex") };
  } finally {
    await h.close();
  }
}
export async function ownedRemove(directory: string) {
  await privateDirectory(directory);
  await rm(directory, { recursive: true, force: false });
}
export async function syncDirectory(directory: string) {
  const h = await open(directory, constants.O_RDONLY);
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}
