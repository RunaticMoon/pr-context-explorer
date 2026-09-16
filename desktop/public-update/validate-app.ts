import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { safeFile, ancestors, hashFile, uid } from "./files.ts";
import { APP_NAME, fail, record, version } from "./policy.ts";
const exec = promisify(execFile);
export async function systemCommand(
  file: string,
  args: string[],
): Promise<string> {
  const { stdout } = await exec(file, args, {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 2_000_000,
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  });
  return stdout.trim();
}
export async function verifyMachO(file: string) {
  const h = await safeFile(file);
  try {
    const s = await h.stat(),
      b = Buffer.alloc(32);
    if (
      (s.mode & 0o111) === 0 ||
      s.size < 32 ||
      (await h.read(b, 0, 32, 0)).bytesRead !== 32 ||
      b.readUInt32LE(0) !== 0xfeedfacf ||
      b.readUInt32LE(4) !== 0x0100000c ||
      b.readUInt32LE(12) !== 2 ||
      b.readUInt32LE(16) === 0 ||
      b.readUInt32LE(20) > s.size - 32
    )
      fail("INVALID_EXECUTABLE");
  } finally {
    await h.close();
  }
}
async function jsonFile(
  file: string,
  limit = 10_000_000,
): Promise<Record<string, unknown>> {
  const h = await safeFile(file);
  try {
    if ((await h.stat()).size > limit) fail("BODY_LIMIT");
    return record(JSON.parse(await h.readFile("utf8")));
  } finally {
    await h.close();
  }
}
export async function verifyRuntime(runtime: string) {
  await ancestors(runtime);
  const manifest = await jsonFile(
      path.join(runtime, "runtime-dependencies.json"),
    ),
    meta = await jsonFile(path.join(runtime, "package.json"));
  if (
    manifest.version !== 1 ||
    JSON.stringify(manifest.roots) !== '["typescript","ajv"]'
  )
    fail("DEPENDENCY_INVENTORY");
  const expected = record(manifest.files),
    actual: Record<string, string> = {};
  let count = 0;
  async function walk(dir: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (++count > 50000) fail("DEPENDENCY_LIMIT");
      const file = path.join(dir, e.name);
      if (e.isDirectory()) await walk(file);
      else {
        if (!e.isFile()) fail("DEPENDENCY_LINK");
        actual[path.relative(runtime, file).split(path.sep).join("/")] = (
          await hashFile(file)
        ).sha256;
      }
    }
  }
  await walk(path.join(runtime, "node_modules"));
  if (
    !Object.keys(expected).length ||
    Object.keys(expected).length !== Object.keys(actual).length ||
    Object.keys(expected).some(
      (k) => !/^node_modules\//.test(k) || actual[k] !== expected[k],
    )
  )
    fail("DEPENDENCY_INVENTORY");
  const visited = new Set<string>();
  async function resolve(from: string, name: string, optional: boolean) {
    if (
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) ||
      name.split("/").some((x) => x === "." || x === "..")
    )
      fail("DEPENDENCY_NAME");
    let dir = from;
    for (;;) {
      if (path.basename(dir) !== "node_modules") {
        const candidate = path.join(dir, "node_modules", name);
        const s = await lstat(candidate).catch((e) => {
          if (e.code === "ENOENT") return null;
          throw e;
        });
        if (s) {
          await ancestors(candidate);
          if (visited.has(candidate)) return;
          visited.add(candidate);
          const pkg = await jsonFile(path.join(candidate, "package.json"));
          if (pkg.name !== name || typeof pkg.version !== "string")
            fail("DEPENDENCY_MANIFEST");
          await edges(candidate, pkg);
          return;
        }
      }
      if (dir === runtime) break;
      dir = path.dirname(dir);
      if (!dir.startsWith(runtime + path.sep) && dir !== runtime)
        fail("DEPENDENCY_ESCAPE");
    }
    if (!optional) fail("DEPENDENCY_MISSING");
  }
  async function edges(from: string, pkg: Record<string, unknown>) {
    const deps = record(pkg.dependencies || {}),
      peers = record(pkg.peerDependencies || {}),
      optional = record(pkg.optionalDependencies || {}),
      peerMeta = record(pkg.peerDependenciesMeta || {});
    for (const name of new Set([
      ...Object.keys(deps),
      ...Object.keys(peers),
      ...Object.keys(optional),
    ]))
      await resolve(
        from,
        name,
        Object.hasOwn(optional, name) ||
          (!Object.hasOwn(deps, name) &&
            record(peerMeta[name] || {}).optional === true),
      );
  }
  const roots = record(meta.dependencies);
  if (!roots.typescript || !roots.ajv) fail("DEPENDENCY_MISSING");
  await edges(runtime, meta);
}
export async function asarPackage(
  file: string,
): Promise<Record<string, unknown>> {
  const h = await safeFile(file);
  try {
    const size = (await h.stat()).size,
      head = Buffer.alloc(16);
    if (
      (await h.read(head, 0, 16, 0)).bytesRead !== 16 ||
      head.readUInt32LE(0) !== 4
    )
      fail("INVALID_ASAR");
    const headerSize = head.readUInt32LE(4),
      jsonSize = head.readUInt32LE(12);
    if (
      headerSize < 8 ||
      headerSize > 4_000_000 ||
      jsonSize > headerSize - 8 ||
      headerSize + 8 > size
    )
      fail("INVALID_ASAR");
    const bytes = Buffer.alloc(jsonSize);
    await h.read(bytes, 0, jsonSize, 16);
    const header = record(JSON.parse(bytes.toString("utf8"))),
      entry = record(record(header.files)["package.json"]);
    if (
      entry.unpacked ||
      entry.link ||
      typeof entry.offset !== "string" ||
      !/^\d+$/.test(entry.offset) ||
      !Number.isSafeInteger(entry.size) ||
      (entry.size as number) > 65536 ||
      (entry.size as number) < 1
    )
      fail("INVALID_ASAR");
    const offset = 8 + headerSize + Number(entry.offset);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 8 + headerSize ||
      offset + (entry.size as number) > size
    )
      fail("INVALID_ASAR");
    const payload = Buffer.alloc(entry.size as number);
    await h.read(payload, 0, payload.length, offset);
    return record(JSON.parse(payload.toString("utf8")));
  } finally {
    await h.close();
  }
}
export async function validateApp(appPath: string, expectedVersion: string) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    fail("UNSUPPORTED_PLATFORM");
  version(expectedVersion);
  if (
    path.basename(appPath) !== APP_NAME &&
    path.basename(appPath) !== "previous.app" &&
    path.basename(appPath) !== "failed.app"
  )
    fail("APP_IDENTITY");
  await ancestors(appPath);
  const stat = await lstat(appPath);
  if (stat.uid !== uid()) fail("APP_NOT_OWNED");
  const plist = path.join(appPath, "Contents/Info.plist");
  const h = await safeFile(plist);
  await h.close();
  const info = record(
    JSON.parse(
      await systemCommand("/usr/bin/plutil", [
        "-convert",
        "json",
        "-o",
        "-",
        plist,
      ]),
    ),
  );
  if (
    info.CFBundleIdentifier !== "com.runaticmoon.pr-context-explorer" ||
    info.CFBundleShortVersionString !== expectedVersion ||
    info.CFBundleExecutable !== "PR Context Explorer" ||
    info.CFBundlePackageType !== "APPL"
  )
    fail("APP_IDENTITY");
  const resources = path.join(appPath, "Contents/Resources"),
    native = path.join(resources, "runtime/native/prce-macos-acl");
  for (const executable of [
    path.join(appPath, "Contents/MacOS/PR Context Explorer"),
    path.join(resources, "node/bin/node"),
    native,
  ]) {
    await verifyMachO(executable);
    if (
      (await systemCommand("/usr/bin/lipo", ["-archs", executable])) !== "arm64"
    )
      fail("INVALID_EXECUTABLE");
  }
  const pkg = await asarPackage(path.join(resources, "app.asar"));
  if (
    pkg.name !== "pr-context-explorer-desktop" &&
    pkg.name !== "pr-context-explorer"
  )
    fail("APP_PACKAGE");
  if (pkg.version !== expectedVersion) fail("APP_VERSION");
  await verifyRuntime(path.join(resources, "runtime"));
  await systemCommand("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    appPath,
  ]);
  await systemCommand("/usr/bin/codesign", ["--verify", "--strict", native]);
  const libs = (await systemCommand("/usr/bin/otool", ["-L", native]))
    .split("\n")
    .slice(1)
    .filter(Boolean);
  if (
    libs.length !== 1 ||
    !/^\s+\/usr\/lib\/libSystem\.B\.dylib \(/.test(libs[0])
  )
    fail("NATIVE_DEPENDENCY");
}
