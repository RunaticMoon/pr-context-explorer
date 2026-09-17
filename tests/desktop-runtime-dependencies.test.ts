import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  cp,
  rm,
  access,
  symlink,
  writeFile,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
const {
  getFileMatchers,
  copyFiles,
} = require("app-builder-lib/out/fileMatcher.js");
const config = require("../desktop/electron-builder.cjs");

let compiled: string;
before(async () => {
  compiled = await realpath(
    await mkdtemp(path.join(tmpdir(), "prce-runtime-source-")),
  );
  await mkdir(path.join(compiled, "desktop"));
  for (const name of ["node_modules", "src", "references"])
    await symlink(
      path.join(process.cwd(), name),
      path.join(compiled, name),
      "dir",
    );
  for (const name of await readdir("desktop"))
    if (name.endsWith(".mjs") || name === "backend.ts")
      await cp(
        path.join("desktop", name),
        path.join(compiled, "desktop", name),
      );
  await cp("package.json", path.join(compiled, "package.json"));
  await cp("scripts", path.join(compiled, "scripts"), { recursive: true });
  await cp("desktop/native", path.join(compiled, "desktop/native"), {
    recursive: true,
  });
  await mkdir(path.join(compiled, "dist"));
  await writeFile(
    path.join(compiled, "dist/index.html"),
    "<!doctype html><title>fixture</title>",
  );
  execFileSync(
    process.execPath,
    [path.join(compiled, "desktop/build.mjs"), "--runtime-only"],
    { stdio: "pipe", timeout: 150000 },
  );
});
after(async () => {
  if (compiled) await rm(compiled, { recursive: true, force: true });
});

test("runtime producer excludes dependency repository metadata before inventory creation", async () => {
  const runtime = path.join(compiled, "desktop/build/runtime");
  const inventory = JSON.parse(await readFile(path.join(runtime, "runtime-dependencies.json"), "utf8"));
  for (const name of ["fast-uri", "json-schema-traverse"]) {
    await access(path.join(process.cwd(), "node_modules", name, ".github"));
    await assert.rejects(access(path.join(runtime, "node_modules", name, ".github")), { code: "ENOENT" });
  }
  assert.equal(Object.keys(inventory.files).some(file => file.split("/").some(part => [".git", ".github"].includes(part.toLowerCase()))), false);
  const { verifyRuntimeDependencies } = await import(pathToFileURL(path.resolve("desktop/runtime-dependencies.mjs")).href);
  await verifyRuntimeDependencies(runtime);
});

async function fixture(t: any) {
  const dir = await realpath(
    await mkdtemp(path.join(tmpdir(), "prce-runtime-pack-")),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "project");
  const resources = path.join(
    dir,
    "PR Context Explorer.app/Contents/Resources",
  );
  await mkdir(path.join(source, "desktop/build"), { recursive: true });
  // Real compiled modules and real npm packages, never placeholder dependencies.
  await cp(
    path.join(compiled, "desktop/build/runtime"),
    path.join(source, "desktop/build/runtime"),
    { recursive: true },
  );
  return { source, resources };
}
async function pack(
  source: string,
  resources: string,
  extraResources: unknown,
) {
  const matchers = getFileMatchers(
    { ...config, extraResources },
    "extraResources",
    resources,
    {
      defaultSrc: source,
      globalOutDir: path.join(source, "release"),
      macroExpander: (s: string) => s,
      customBuildOptions: {},
    },
  );
  await copyFiles(matchers, null, false);
}
function importGit(resources: string) {
  const module = path.join(resources, "runtime/src/server/git.js");
  return execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(module)})`],
    {
      cwd: "/",
      env: { PATH: "", NODE_PATH: "", NODE_OPTIONS: "" },
      encoding: "utf8",
      timeout: 15000,
      stdio: "pipe",
    },
  );
}

test("pinned builder root-relative node_modules filter reproduces shipped TypeScript loss independently of files excludes", async (t) => {
  assert.equal(require("app-builder-lib/package.json").version, "26.16.1");
  const { source, resources } = await fixture(t);
  await pack(source, resources, [
    {
      from: "desktop/build/runtime",
      to: "runtime",
      filter: ["**/*", "node_modules/**/*"],
    },
  ]);
  await access(path.join(resources, "runtime/src/server/git.js"));
  await assert.rejects(
    access(
      path.join(resources, "runtime/node_modules/typescript/package.json"),
    ),
    { code: "ENOENT" },
  );
  assert.throws(() => importGit(resources), /Cannot find package 'typescript'/);
});

test("configured real builder copier packages a standalone compiled git runtime with TypeScript", async (t) => {
  const { source, resources } = await fixture(t);
  await pack(
    source,
    resources,
    config.extraResources.filter((r: any) => r.to !== "node"),
  );
  assert.doesNotThrow(() => importGit(resources));
  await access(
    path.join(resources, "runtime/node_modules/typescript/package.json"),
  );
  const runtime = path.join(resources, "runtime");
  const { verifyRuntimeDependencies } = await import(
    pathToFileURL(path.resolve("desktop/runtime-dependencies.mjs")).href
  );
  const closure = await verifyRuntimeDependencies(runtime);
  assert.deepEqual(
    closure.map((p: any) => p.name).sort(),
    [
      "typescript",
      "ajv",
      "fast-deep-equal",
      "fast-uri",
      "json-schema-traverse",
      "require-from-string",
    ].sort(),
  );
  // Exercise AST and JSON schema behavior, not merely the presence of filenames.
  const probe = path.join(runtime, "dependency-probe.mjs");
  await writeFile(
    probe,
    `import assert from 'node:assert/strict';
import ts from 'typescript'; import Ajv from 'ajv';
const source = ts.createSourceFile('fixture.ts', 'export const n: number = 3;', ts.ScriptTarget.Latest, true);
assert.equal(source.statements.length, 1);
const validate = new Ajv().compile({ type: 'object', properties: {n: {type: 'number'}}, required: ['n'] });
assert.equal(validate({n: 3}), true); assert.equal(validate({n: 'no'}), false);
await import('./desktop/backend.js');
console.log('AST, schema and backend module graph imported');`,
  );
  assert.match(
    execFileSync(process.execPath, [probe], {
      cwd: "/",
      env: {
        PATH: "",
        NODE_PATH: "",
        NODE_OPTIONS: "",
        HOME: path.dirname(runtime),
      },
      stdio: "pipe",
      encoding: "utf8",
      timeout: 15000,
    }),
    /AST, schema and backend/,
  );
});

test("verifier rejects missing package even when source ancestors could resolve it", async (t) => {
  const { source } = await fixture(t);
  await symlink(
    path.resolve("node_modules"),
    path.join(source, "node_modules"),
    "dir",
  );
  const runtime = path.join(source, "desktop/build/runtime");
  await rm(path.join(runtime, "node_modules/typescript"), { recursive: true });
  assert.ok(
    createRequire(path.join(runtime, "probe.cjs"))
      .resolve("typescript")
      .includes(process.cwd()),
  );
  const { verifyRuntimeDependencies } = await import(
    pathToFileURL(path.resolve("desktop/runtime-dependencies.mjs")).href
  );
  await assert.rejects(
    verifyRuntimeDependencies(runtime),
    /Runtime dependency missing package typescript/,
  );
});

test("inventory catches removed lazy package file and rejects foreign dependency symlinks", async (t) => {
  const { source } = await fixture(t);
  const runtime = path.join(source, "desktop/build/runtime");
  const { verifyRuntimeDependencies } = await import(
    pathToFileURL(path.resolve("desktop/runtime-dependencies.mjs")).href
  );
  await rm(path.join(runtime, "node_modules/typescript/lib/lib.es2024.d.ts"));
  await assert.rejects(
    verifyRuntimeDependencies(runtime),
    /inventory mismatch.*lib.es2024.d.ts/,
  );
  await rm(path.join(runtime, "node_modules/typescript"), { recursive: true });
  await symlink(
    path.resolve("node_modules/typescript"),
    path.join(runtime, "node_modules/typescript"),
    "dir",
  );
  await assert.rejects(
    verifyRuntimeDependencies(runtime),
    /unsafe directory.*typescript/,
  );
});

test("copy refuses a symlinked output before touching foreign files", async (t) => {
  const { source } = await fixture(t);
  const foreign = path.join(source, "foreign");
  await mkdir(foreign);
  await writeFile(path.join(foreign, "sentinel"), "untouched");
  const output = path.join(source, "linked-runtime");
  await symlink(foreign, output, "dir");
  const { copyRuntimeDependencies } = await import(
    pathToFileURL(path.resolve("desktop/runtime-dependencies.mjs")).href
  );
  await assert.rejects(
    copyRuntimeDependencies(process.cwd(), output),
    /unsafe directory/,
  );
  assert.deepEqual(await readdir(foreign), ["sentinel"]);
  assert.equal(
    await readFile(path.join(foreign, "sentinel"), "utf8"),
    "untouched",
  );
});

test("build fails for a new undeclared external runtime import", async () => {
  const backend = path.join(compiled, "desktop/backend.ts");
  const original = await readFile(backend, "utf8");
  try {
    await writeFile(
      backend,
      original + '\nimport "undeclared-runtime-package";\n',
    );
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [path.join(compiled, "desktop/build.mjs"), "--runtime-only"],
          { stdio: "pipe", timeout: 150000 },
        ),
      /Runtime dependency root not declared: undeclared-runtime-package/,
    );
  } finally {
    await writeFile(backend, original);
    execFileSync(
      process.execPath,
      [path.join(compiled, "desktop/build.mjs"), "--runtime-only"],
      { stdio: "pipe", timeout: 150000 },
    );
  }
});

test("afterPack refuses missing Ajv transitive dependencies before touching fuses/signing", async (t) => {
  const { source, resources } = await fixture(t);
  await pack(
    source,
    resources,
    config.extraResources.filter((r: any) => r.to !== "node"),
  );
  await rm(path.join(resources, "runtime/node_modules/fast-uri"), {
    recursive: true,
  });
  const afterPack = require("../desktop/after-pack.cjs");
  await assert.rejects(
    afterPack({
      appOutDir: path.dirname(path.dirname(path.dirname(resources))),
      packager: { appInfo: { productFilename: "PR Context Explorer" } },
    }),
    /Runtime dependency.*fast-uri/,
  );
});
