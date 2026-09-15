import {
  mkdir,
  readFile,
  writeFile,
  rm,
  cp,
  chmod,
  mkdtemp,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const version = "24.21.0";
// Official nodejs.org SHASUMS256.txt, independently pinned; never trust a newly downloaded checksum.
const sums = {
  "darwin-arm64":
    "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
  "linux-arm64":
    "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5",
  "linux-x64":
    "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
};
const target =
  process.argv[2] === "--host"
    ? `${process.platform}-${process.arch}`
    : process.argv[2] || "darwin-arm64";
if (!Object.hasOwn(sums, target))
  throw Error("Unsupported Node sidecar target");
const cache = path.join(root, "desktop/vendor");
await mkdir(cache, { recursive: true });
const name = `node-v${version}-${target}`,
  archive = path.join(cache, name + ".tar.gz");
let bytes;
try {
  bytes = await readFile(archive);
} catch {
  const response = await fetch(
    `https://nodejs.org/dist/v${version}/${name}.tar.gz`,
    { redirect: "error", signal: AbortSignal.timeout(120000) },
  );
  if (!response.ok) throw Error("Official Node download failed");
  bytes = Buffer.from(await response.arrayBuffer());
}
if (createHash("sha256").update(bytes).digest("hex") !== sums[target])
  throw Error("Node sidecar checksum mismatch");
await writeFile(archive, bytes, { mode: 0o600 });
const temp = await mkdtemp(path.join(cache, "extract-"));
const dest = path.join(cache, "node-" + target);
try {
  execFileSync(
    "/usr/bin/tar",
    ["-xzf", archive, "-C", temp, `${name}/bin/node`, `${name}/LICENSE`],
    { timeout: 60000, stdio: "pipe" },
  );
  await rm(dest, { recursive: true, force: true });
  await mkdir(path.join(dest, "bin"), { recursive: true });
  await cp(path.join(temp, name, "bin/node"), path.join(dest, "bin/node"));
  await chmod(path.join(dest, "bin/node"), 0o755);
  await cp(path.join(temp, name, "LICENSE"), path.join(dest, "LICENSE"));
  await writeFile(
    path.join(dest, "provenance.json"),
    JSON.stringify(
      {
        version,
        target,
        archive: name + ".tar.gz",
        sha256: sums[target],
        source: `https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
      },
      null,
      2,
    ),
  );
  if (process.argv[2] === "--host")
    await cp(dest, path.join(root, "desktop/build/node"), { recursive: true });
} finally {
  await rm(temp, { recursive: true, force: true });
}
console.log(`Verified Node ${version} ${target}: ${dest}`);
