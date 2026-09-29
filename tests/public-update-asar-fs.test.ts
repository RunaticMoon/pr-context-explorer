import { nativeACLHelper } from "./public-update-test-support.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { asarPackage } from "../desktop/public-update/validate-app.ts";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL("..", import.meta.url));
const validateApp = path.join(repo, "desktop/public-update/validate-app.ts");
const files = path.join(repo, "desktop/public-update/files.ts");
const acl = path.join(repo, "desktop/public-update/acl.ts");

// Electron's main process patches node:fs so app.asar behaves like a virtual
// directory. Regression: update validation runs in that process (or under
// ELECTRON_RUN_AS_NODE=1) and must still read app.asar as a plain file.
const electron = (() => {
  try {
    return require("electron") as string;
  } catch {
    return null;
  }
})();
const hasElectron = typeof electron === "string" && existsSync(electron);

async function fixture() {
  const root = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "public-asar-fs-"),
  );
  const source = path.join(root, "source"),
    archive = path.join(root, "app.asar");
  await mkdir(source);
  await writeFile(
    path.join(source, "package.json"),
    JSON.stringify({ name: "pr-context-explorer", version: "0.9.0" }),
  );
  const { createPackage } = require("@electron/asar");
  await createPackage(source, archive);
  await chmod(archive, 0o644);
  return { root, archive };
}

async function bundle(root: string, name: string, entry: string) {
  const source = path.join(root, `${name}.ts`),
    outfile = path.join(root, `${name}.cjs`);
  await writeFile(source, entry);
  await build({
    entryPoints: [source],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
  });
  return outfile;
}

async function runAsNode(outfile: string, ...args: string[]) {
  return exec(electron as string, [outfile, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    timeout: 30000,
  });
}

test("Electron run-as-node reads app.asar as a file through the unpatched fs", async (t) => {
  if (!hasElectron) return t.skip("electron binary not installed");
  const { root, archive } = await fixture();
  try {
    const outfile = await bundle(
      root,
      "read-entry",
      `import { asarPackage } from ${JSON.stringify(validateApp)};
import { bindNativeACL } from ${JSON.stringify(acl)};
import { open as patchedOpen } from "node:fs/promises";
const helper = process.argv[3];
if (helper) bindNativeACL(helper);
(async () => {
  let patchedOpenCode = "OK";
  try {
    const handle = await patchedOpen(process.argv[2], "r");
    await handle.close();
  } catch (error) {
    patchedOpenCode = (error as { code?: string }).code ?? "UNKNOWN";
  }
  try {
    const pkg = await asarPackage(process.argv[2]);
    process.stdout.write(
      JSON.stringify({ version: pkg.version, patchedOpen: patchedOpenCode }),
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        error: (error as { code?: string }).code ?? "UNKNOWN",
        patchedOpen: patchedOpenCode,
      }),
    );
    process.exit(1);
  }
})();
`,
    );
    let stdout: string;
    try {
      ({ stdout } = await runAsNode(outfile, archive, nativeACLHelper ?? ""));
    } catch (error) {
      assert.fail(
        `electron run-as-node failed to read app.asar: ${
          (error as { stdout?: string }).stdout?.trim() || String(error)
        }`,
      );
    }
    assert.deepEqual(JSON.parse(stdout.trim()), {
      version: "0.9.0",
      // node:fs stays patched in the child, so only this suite's unpatched fs
      // can read the archive. An "OK" here means the Electron patch vanished
      // or the entry ran outside Electron.
      patchedOpen: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plain Node reads the synthetic app.asar through asarPackage", async () => {
  const { root, archive } = await fixture();
  try {
    assert.equal((await asarPackage(archive)).version, "0.9.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Electron run-as-node creates a new app.asar file through the unpatched fs", async (t) => {
  if (!hasElectron) return t.skip("electron binary not installed");
  const { root } = await fixture();
  const target = path.join(root, "x", "app.asar");
  try {
    await mkdir(path.dirname(target), { mode: 0o700 });
    const outfile = await bundle(
      root,
      "create-entry",
      `import { exclusiveFile } from ${JSON.stringify(files)};
import { bindNativeACL } from ${JSON.stringify(acl)};
const helper = process.argv[3];
if (helper) bindNativeACL(helper);
(async () => {
  try {
    const handle = await exclusiveFile(process.argv[2]);
    await handle.writeFile("created");
    await handle.close();
    process.stdout.write(JSON.stringify({ created: true }));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ error: (error as { code?: string }).code ?? "UNKNOWN" }),
    );
    process.exit(1);
  }
})();
`,
    );
    let stdout: string;
    try {
      ({ stdout } = await runAsNode(outfile, target, nativeACLHelper ?? ""));
    } catch (error) {
      assert.fail(
        `electron run-as-node failed to create app.asar: ${
          (error as { stdout?: string }).stdout?.trim() || String(error)
        }`,
      );
    }
    assert.deepEqual(JSON.parse(stdout.trim()), { created: true });
    assert.equal(await readFile(target, "utf8"), "created");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
