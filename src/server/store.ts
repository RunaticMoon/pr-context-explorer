import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  lstatSync,
  existsSync,
  chmodSync,
  openSync,
  constants,
  readFileSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
export const cacheKey = (value: unknown): string => {
  const stable = (v: any): any =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, stable(v[k])]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
};
export function privateDirectory(dir: string) {
  const absolute = path.resolve(dir);
  let p = path.parse(absolute).root;
  for (const part of absolute.slice(p.length).split(path.sep)) {
    p = path.join(p, part);
    if (
      existsSync(p) ||
      (() => {
        try {
          return lstatSync(p).isSymbolicLink();
        } catch {
          return false;
        }
      })()
    ) {
      const st = lstatSync(p);
      if (st.isSymbolicLink() || !st.isDirectory())
        throw Error("unsafe store directory");
    } else mkdirSync(p, { mode: 0o700 });
  }
  chmodSync(absolute, 0o700);
  return absolute;
}
const buckets = [
  "config",
  "snapshot",
  "analysis",
  "chunk",
  "jira",
  "selection",
] as const;
export type Bucket = (typeof buckets)[number];
export class LocalStore {
  readonly root: string;
  constructor(
    root: string,
    readonly retentionMs = 30 * 86400000,
  ) {
    this.root = privateDirectory(root);
    for (const b of buckets) privateDirectory(path.join(this.root, b));
  }
  private file(bucket: Bucket, key: string) {
    if (!buckets.includes(bucket) || !/^[a-f0-9]{64}$/.test(key))
      throw Error("invalid store key");
    privateDirectory(path.join(this.root, bucket));
    return path.join(this.root, bucket, key + ".json");
  }
  put(bucket: Bucket, key: string, value: unknown, now = Date.now()) {
    const file = this.file(bucket, key);
    const data = JSON.stringify({ version: 1, createdAt: now, value });
    if (Buffer.byteLength(data) > 64 * 1024 * 1024)
      throw Error("store size limit");
    if (existsSync(file) && lstatSync(file).isSymbolicLink())
      throw Error("unsafe store file");
    const temp = file + "." + randomBytes(8).toString("hex");
    const fd = openSync(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  }
  get<T = unknown>(bucket: Bucket, key: string, now = Date.now()): T | null {
    const file = this.file(bucket, key);
    let fd: number;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (e: any) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
    try {
      const st = lstatSync(file);
      if (!st.isFile() || st.size > 64 * 1024 * 1024)
        throw Error("invalid stored file");
      const data = JSON.parse(readFileSync(fd, "utf8"));
      if (data.version !== 1) throw Error("unsupported store version");
      if (bucket !== "config" && data.createdAt + this.retentionMs < now)
        return null;
      return data.value;
    } finally {
      closeSync(fd);
    }
  }
  list<T = unknown>(
    bucket: Bucket,
    now = Date.now(),
  ): { key: string; value: T }[] {
    return readdirSync(path.join(this.root, bucket))
      .filter((f) => /^[a-f0-9]{64}\.json$/.test(f))
      .flatMap((f) => {
        const key = f.slice(0, -5);
        const value = this.get<T>(bucket, key, now);
        return value === null ? [] : [{ key, value }];
      });
  }
  delete(bucket: Bucket, key: string) {
    const file = this.file(bucket, key);
    try {
      if (lstatSync(file).isSymbolicLink()) throw Error("unsafe store file");
      unlinkSync(file);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  clear(bucket: Bucket) {
    for (const name of readdirSync(path.join(this.root, bucket)))
      if (/^[a-f0-9]{64}\.json$/.test(name))
        this.delete(bucket, name.slice(0, -5));
  }
  prune(now = Date.now()) {
    let count = 0;
    for (const b of buckets.filter((b) => b !== "config"))
      for (const name of readdirSync(path.join(this.root, b))) {
        if (
          /^[a-f0-9]{64}\.json$/.test(name) &&
          this.get(b, name.slice(0, -5), now) === null
        ) {
          this.delete(b, name.slice(0, -5));
          count++;
        }
      }
    return count;
  }
}
