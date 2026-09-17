// Build-time only. No package install, lifecycle scripts, or global resolution.
import {
  lstat,
  readdir,
  readFile,
  writeFile,
  mkdir,
  cp,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

export const runtimeDependencyRoots = ["typescript", "ajv"];
const manifestName = "runtime-dependencies.json";
const fail = (message) => {
  throw new Error(`Runtime dependency ${message}`);
};
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
};
async function regular(file, directory = false) {
  const stat = await lstat(file).catch(() => fail(`missing: ${file}`));
  if (
    stat.isSymbolicLink() ||
    !(directory ? stat.isDirectory() : stat.isFile())
  )
    fail(`unsafe ${directory ? "directory" : "file"}: ${file}`);
}
async function realComponents(root, file) {
  if (!inside(root, file)) fail(`path escapes bundle: ${file}`);
  await regular(root, true);
  let current = root;
  for (const part of path
    .relative(root, file)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    await regular(current, true);
  }
}
async function json(file) {
  await regular(file);
  return JSON.parse(await readFile(file, "utf8"));
}
function packageName(name) {
  if (
    !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) ||
    name.split("/").some((p) => p === "." || p === "..")
  )
    fail(`invalid package name: ${name}`);
  return name;
}
// Deliberately bounded: never let Node find a package in source/global ancestors.
async function resolvePackage(boundary, from, name, optional = false) {
  packageName(name);
  for (let dir = from; inside(boundary, dir); dir = path.dirname(dir)) {
    if (path.basename(dir) === "node_modules") continue;
    const candidate = path.join(dir, "node_modules", name);
    const stat = await lstat(candidate).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (stat) {
      await realComponents(boundary, candidate);
      const meta = await json(path.join(candidate, "package.json"));
      if (meta.name !== name || typeof meta.version !== "string")
        fail(`invalid manifest: ${name}`);
      return { directory: candidate, meta };
    }
    if (dir === boundary) break;
  }
  if (!optional) fail(`missing package ${name} (requested from ${from})`);
  return null;
}
function edges(meta) {
  const result = new Map();
  for (const name of Object.keys(meta.dependencies || {}))
    result.set(name, false);
  for (const name of Object.keys(meta.peerDependencies || {}))
    if (!result.has(name))
      result.set(name, meta.peerDependenciesMeta?.[name]?.optional === true);
  for (const name of Object.keys(meta.optionalDependencies || {}))
    result.set(name, true);
  return result;
}
async function graph(root, roots) {
  const packages = new Map();
  async function visit(from, name, optional = false) {
    const found = await resolvePackage(root, from, name, optional);
    if (!found || packages.has(found.directory)) return;
    packages.set(found.directory, found.meta);
    for (const [child, maybe] of edges(found.meta))
      await visit(found.directory, child, maybe);
  }
  for (const name of roots) await visit(root, name);
  return packages;
}
async function inventory(root, directory, result = {}) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await inventory(root, file, result);
    else {
      await regular(file);
      result[path.relative(root, file).split(path.sep).join("/")] = createHash(
        "sha256",
      )
        .update(await readFile(file))
        .digest("hex");
    }
  }
  return result;
}

async function checkManifestDestination(file) {
  const stat = await lstat(file).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1))
    fail('unsafe manifest destination');
}
async function writeManifest(file, text) {
  await checkManifestDestination(file);
  const temp = path.join(path.dirname(file), `.manifest-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, text, {flag: 'wx', mode: 0o600});
    await checkManifestDestination(file);
    // Rename replaces the directory entry; never opens/truncates the destination.
    await rename(temp, file);
  } finally { await rm(temp, {force: true}); }
}

export async function copyRuntimeDependencies(projectRoot, runtime) {
  // Resolve the installation once; dependency traversal remains inside it.
  const modules = await realpath(path.join(projectRoot, "node_modules"));
  const source = path.dirname(modules);
  if (path.basename(modules) !== "node_modules")
    fail("expected an npm node_modules installation");
  await realComponents(
    path.parse(path.resolve(runtime)).root,
    path.resolve(runtime),
  );
  await checkManifestDestination(path.join(runtime, 'package.json'));
  await checkManifestDestination(path.join(runtime, manifestName));
  const packages = await graph(source, runtimeDependencyRoots);
  const destination = path.join(runtime, "node_modules");
  await mkdir(destination, { recursive: true });
  await realComponents(runtime, destination);
  for (const directory of packages.keys()) {
    const target = path.join(runtime, path.relative(source, directory));
    await mkdir(path.dirname(target), { recursive: true });
    await realComponents(runtime, path.dirname(target));
    // Check before copying; never follow a foreign symlink in generated output.
    const existing = await lstat(target).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (existing) fail(`destination already exists: ${target}`);
    await inventory(source, directory); // refuse package symlinks/special files
    await cp(directory, target, {
      recursive: true,
      filter: (file) =>
        file === directory ||
        !path
          .relative(directory, file)
          .split(path.sep)
          .some((part) => ["node_modules", ".git", ".github"].includes(part.toLowerCase())),
    });
  }
  const dependencies = {};
  for (const name of runtimeDependencyRoots)
    dependencies[name] = (
      await resolvePackage(runtime, runtime, name)
    ).meta.version;
  await writeManifest(
    path.join(runtime, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies }, null, 2) +
      "\n",
  );
  await writeManifest(
    path.join(runtime, manifestName),
    JSON.stringify(
      {
        version: 1,
        roots: runtimeDependencyRoots,
        files: await inventory(runtime, destination),
      },
      null,
      2,
    ) + "\n",
  );
  return verifyRuntimeDependencies(runtime);
}

export async function verifyRuntimeDependencies(runtime) {
  runtime = path.resolve(runtime);
  await realComponents(path.parse(runtime).root, runtime);
  const meta = await json(path.join(runtime, "package.json"));
  for (const root of runtimeDependencyRoots)
    if (!meta.dependencies?.[root]) fail(`root manifest missing ${root}`);
  const packages = await graph(runtime, Object.keys(meta.dependencies));
  const expected = await json(path.join(runtime, manifestName));
  if (
    expected.version !== 1 ||
    JSON.stringify(expected.roots) !== JSON.stringify(runtimeDependencyRoots) ||
    !expected.files ||
    !Object.keys(expected.files).length
  )
    fail("invalid inventory");
  const actual = await inventory(runtime, path.join(runtime, "node_modules"));
  for (const file of new Set([
    ...Object.keys(expected.files),
    ...Object.keys(actual),
  ]))
    if (actual[file] !== expected.files[file])
      fail(`inventory mismatch: ${file}`);
  return [...packages.entries()].map(([directory, info]) => ({
    name: info.name,
    version: info.version,
    directory: path.relative(runtime, directory),
  }));
}
