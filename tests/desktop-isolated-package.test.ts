import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm, cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = fileURLToPath(new URL("..", import.meta.url));
const helperURL = new URL(
  "./e2e/desktop-package-isolation.mjs",
  import.meta.url,
);

test("actual Node import exposes missing typescript only after leaving checkout ancestry", async () => {
  // Deliberately incomplete fixture: no dependency files are invented or shipped.
  const local = await mkdtemp(path.join(root, ".isolated-regression-"));
  let isolated:
    { root: string; home: string; cleanup(): Promise<void> } | undefined;
  try {
    const source = path.join(local, "runtime");
    await mkdir(source);
    await writeFile(
      path.join(source, "backend.mjs"),
      'import ts from "typescript"; export default ts.version;',
    );
    const inCheckout = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(path.join(source, "backend.mjs"))})`,
      ],
      { env: {}, encoding: "utf8" },
    );
    assert.equal(inCheckout, "");
    const helpers = await import(helperURL.href);
    const outside: { root: string; home: string; cleanup(): Promise<void> } =
      await helpers.createIsolatedInstall(root);
    isolated = outside;
    await cp(source, path.join(outside.root, "runtime"), { recursive: true });
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `await import(${JSON.stringify(path.join(outside.root, "runtime/backend.mjs"))})`,
          ],
          {
            cwd: outside.root,
            env: helpers.isolatedEnvironment(outside.home),
            stdio: "pipe",
          },
        ),
      /ERR_MODULE_NOT_FOUND/,
    );
  } finally {
    await isolated?.cleanup();
    await rm(local, { recursive: true, force: true });
  }
});

test("runtime probe imports complete closure and rejects missing or escaping dependencies", async () => {
  const helpers = await import(helperURL.href);
  const isolated = await helpers.createIsolatedInstall(root);
  try {
    const runtime = path.join(isolated.root, "runtime");
    await mkdir(path.join(runtime, "desktop"), { recursive: true });
    await writeFile(
      path.join(runtime, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    await writeFile(
      path.join(runtime, "desktop/backend.js"),
      'import ts from "typescript"; import Ajv from "ajv"; if (!ts.version || !new Ajv()) throw Error("fixture import failed");',
    );
    for (const name of [
      "typescript",
      "ajv",
      "fast-deep-equal",
      "fast-uri",
      "json-schema-traverse",
      "require-from-string",
    ])
      await cp(
        path.join(root, "node_modules", name),
        path.join(runtime, "node_modules", name),
        { recursive: true },
      );
    const args = {
      node: process.execPath,
      runtime,
      cwd: isolated.root,
      home: isolated.home,
    };
    assert.equal(helpers.probeRuntime(args).backendImported, true);
    await rm(path.join(runtime, "node_modules/typescript"), {
      recursive: true,
    });
    assert.throws(
      () => helpers.probeRuntime(args),
      /Cannot find module 'typescript'/,
    );
    const { symlink } = await import("node:fs/promises");
    await symlink(
      path.join(root, "node_modules/typescript"),
      path.join(runtime, "node_modules/typescript"),
    );
    assert.throws(
      () => helpers.probeRuntime(args),
      /Dependency escaped installed runtime/,
    );
  } finally {
    await isolated.cleanup();
  }
});

test("final ZIP extraction uses a new outside directory and rejects traversal", async () => {
  const helpers = await import(helperURL.href);
  const isolated = await helpers.createIsolatedInstall(root);
  try {
    const archive = path.join(isolated.root, "fixture.zip");
    execFileSync("/usr/bin/python3", [
      "-c",
      "import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:z.writestr('PR Context Explorer.app/Contents/fixture.txt','fixture only')",
      archive,
    ]);
    const app = await helpers.extractDistributable(archive, isolated, root);
    const { readFile } = await import("node:fs/promises");
    assert.equal(
      await readFile(path.join(app, "Contents/fixture.txt"), "utf8"),
      "fixture only",
    );
    await assert.rejects(
      helpers.extractDistributable(archive, isolated, root),
      /Extraction destination must be new/,
    );
    await rm(path.join(isolated.root, "installed"), { recursive: true });
    execFileSync("/usr/bin/python3", [
      "-c",
      "import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:z.writestr('../escape','bad')",
      archive,
    ]);
    await assert.rejects(
      helpers.extractDistributable(archive, isolated, root),
      /Unsafe archive member/,
    );
    await assert.rejects(
      helpers.extractDistributable(app, isolated, root),
      /final ZIP/,
    );
  } finally {
    await isolated.cleanup();
  }
});

test("isolation rejects an ancestor node_modules even when empty", async () => {
  const helpers = await import(helperURL.href);
  const isolated = await helpers.createIsolatedInstall(root);
  try {
    const nested = path.join(isolated.root, "nested");
    await mkdir(nested);
    await mkdir(path.join(isolated.root, "node_modules"));
    await assert.rejects(
      helpers.assertIsolated(nested, root),
      /ancestor node_modules/,
    );
    await assert.rejects(
      helpers.assertIsolated(root, root),
      /outside checkout/,
    );
    assert.equal(
      helpers.isolatedEnvironment(isolated.home).NODE_PATH,
      undefined,
    );
    assert.equal(
      helpers.isolatedEnvironment(isolated.home).NODE_OPTIONS,
      undefined,
    );
  } finally {
    await isolated.cleanup();
  }
});
