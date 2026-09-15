import { execFileSync } from "node:child_process";
import {
  mkdir,
  lstat,
  realpath,
  mkdtemp,
  chmod,
  rename,
  rm,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Build-time only. End users execute the bundled Mach-O, never this script.
if (process.platform !== "darwin") throw new Error("macOS build host required");
const args = process.argv.slice(2);
const host =
  process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x86_64" : "";
const arch =
  args.length === 0
    ? host
    : args.length === 2 && args[0] === "--arch"
      ? args[1]
      : "";
if (!["arm64", "x86_64"].includes(arch))
  throw new Error("Expected --arch arm64 or --arch x86_64");
const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
let out = root;
for (const part of ["desktop", "build", "runtime", "native"]) {
  out = join(out, part);
  await mkdir(out).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await lstat(out);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(out)) !== out
  )
    throw new Error("Unsafe native helper output directory");
}
const temp = await mkdtemp(join(out, ".acl-build-"));
const binary = join(temp, "prce-macos-acl");
const options = {
  cwd: root,
  env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  encoding: "utf8",
  timeout: 60000,
  maxBuffer: 65536,
  shell: false,
};
try {
  execFileSync(
    "/usr/bin/clang",
    [
      "-std=c11",
      "-D_DARWIN_C_SOURCE",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      "-arch",
      arch,
      "-mmacosx-version-min=13.0",
      "-fstack-protector-strong",
      "-o",
      binary,
      join(root, "desktop/native/macos-acl.c"),
    ],
    options,
  );
  // Ad-hoc identity only; no paid Developer ID, entitlement, or system-policy bypass.
  execFileSync(
    "/usr/bin/codesign",
    ["--force", "--sign", "-", binary],
    options,
  );
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", binary], options);
  const libraries = execFileSync("/usr/bin/otool", ["-L", binary], options)
    .split("\n")
    .slice(1)
    .filter(Boolean);
  if (
    libraries.length !== 1 ||
    !/^\s+\/usr\/lib\/libSystem\.B\.dylib \(/.test(libraries[0])
  )
    throw new Error("Unexpected native helper library dependency");
  await chmod(binary, 0o755);
  await rename(binary, join(out, "prce-macos-acl"));
  console.log(
    `Built native ACL helper (${arch}) at desktop/build/runtime/native/prce-macos-acl`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
