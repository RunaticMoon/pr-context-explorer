import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  cp,
  symlink,
  readFile,
  writeFile,
  rm,
  access,
  readdir,
  lstat,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

test("every desktop runtime build invokes the native ACL builder only on Darwin after runtime generation", async () => {
  const source = await readFile("desktop/build.mjs", "utf8");
  const hook = source.indexOf('if (process.platform === "darwin")');
  assert.ok(
    hook > source.indexOf('await cp("dist"'),
    "native build follows runtime cleanup and generation",
  );
  assert.match(source.slice(hook), /execFileSync\(\s*process\.execPath/);
  assert.match(source.slice(hook), /scripts\/build-macos-acl\.mjs/);
});

test("build rejects a symlinked output root without deleting foreign files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prce-build-link-"));
  try {
    await mkdir(path.join(dir, "desktop"));
    await mkdir(path.join(dir, "foreign"));
    await writeFile(path.join(dir, "foreign/keep.txt"), "external sentinel");
    await symlink(
      path.join(dir, "foreign"),
      path.join(dir, "desktop/build"),
      "dir",
    );
    await symlink(
      path.join(process.cwd(), "node_modules"),
      path.join(dir, "node_modules"),
      "dir",
    );
    await cp(
      path.join(process.cwd(), "desktop/build.mjs"),
      path.join(dir, "desktop/build.mjs"),
    );
    assert.throws(() =>
      execFileSync(process.execPath, [path.join(dir, "desktop/build.mjs")], {
        timeout: 10000,
        stdio: "pipe",
      }),
    );
    assert.equal(
      await readFile(path.join(dir, "foreign/keep.txt"), "utf8"),
      "external sentinel",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rebuilding compiled desktop output preserves the prepared host Node sidecar used before firstWindow", async () => {
  const root = process.cwd();
  const dir = await realpath(
    await mkdtemp(path.join(tmpdir(), "prce-rebuild-")),
  );
  try {
    await mkdir(path.join(dir, "desktop/build/node/bin"), { recursive: true });
    // Real executable, not a fabricated readiness response. Node provisioning is
    // separately checksum tested; this reproduces prepare -> rebuild -> launch.
    await symlink(
      process.execPath,
      path.join(dir, "desktop/build/node/bin/node"),
    );
    await writeFile(
      path.join(dir, "desktop/build/node/provenance.json"),
      '{"fixture":"prepared-host"}',
    );
    await mkdir(path.join(dir, "desktop/build/runtime"));
    await writeFile(
      path.join(dir, "desktop/build/runtime/stale.js"),
      "throw Error('stale')",
    );
    for (const name of ["node_modules", "src", "references"])
      await symlink(path.join(root, name), path.join(dir, name), "dir");
    // Copy rather than symlink: the builder anchors output to import.meta.url.
    await mkdir(path.join(dir, "scripts"));
    await cp(
      path.join(root, "scripts/build-macos-acl.mjs"),
      path.join(dir, "scripts/build-macos-acl.mjs"),
    );
    await cp(
      path.join(root, "desktop/native"),
      path.join(dir, "desktop/native"),
      { recursive: true },
    );
    await cp(path.join(root, "package.json"), path.join(dir, "package.json"));
    await cp(
      path.join(root, "desktop/build.mjs"),
      path.join(dir, "desktop/build.mjs"),
    );
    for (const name of await readdir(path.join(root, "desktop")))
      if (name.endsWith(".ts"))
        await symlink(
          path.join(root, "desktop", name),
          path.join(dir, "desktop", name),
        );
    await mkdir(path.join(dir, "dist"));
    await writeFile(
      path.join(dir, "dist/index.html"),
      "<!doctype html><title>Build fixture</title>",
    );
    execFileSync(process.execPath, [path.join(dir, "desktop/build.mjs")], {
      cwd: dir,
      stdio: "pipe",
      timeout: 150000,
    });
    const helper = path.join(
      dir,
      "desktop/build/runtime/native/prce-macos-acl",
    );
    const verifyHelper = async () => {
      if (process.platform !== "darwin") {
        await assert.rejects(access(helper), { code: "ENOENT" });
        return;
      }
      assert.equal((await lstat(helper)).mode & 0o7777, 0o755);
      assert.equal(
        execFileSync("/usr/bin/lipo", ["-archs", helper], {
          encoding: "utf8",
        }).trim(),
        process.arch === "x64" ? "x86_64" : process.arch,
      );
      execFileSync("/usr/bin/codesign", ["--verify", "--strict", helper]);
      // Run the compiled reader from a foreign cwd with no compiler/PATH.
      const reader = path.join(
        dir,
        "desktop/build/runtime/src/server/ai/macos-acl.js",
      );
      const probe = path.join(dir, "acl-probe");
      await mkdir(probe, { recursive: true });
      execFileSync("/bin/chmod", ["-N", probe]);
      const output = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const {readMacDirectoryAcl} = await import(${JSON.stringify(reader)}); process.stdout.write(await readMacDirectoryAcl(${JSON.stringify(probe)}));`,
        ],
        {
          cwd: "/",
          env: { LANG: "C", LC_ALL: "C" },
          encoding: "utf8",
          timeout: 5000,
        },
      );
      assert.equal(output, '{"version":1,"status":"empty"}\n');
    };
    await access(path.join(dir, "desktop/build/app/main.cjs"));
    await verifyHelper();
    // Exercise runtime-only too; neither build may depend on a previous helper.
    if (process.platform === "darwin") await rm(helper);
    execFileSync(
      process.execPath,
      [path.join(dir, "desktop/build.mjs"), "--runtime-only"],
      {
        cwd: "/",
        stdio: "pipe",
        timeout: 150000,
      },
    );
    await verifyHelper();
    const node = path.join(dir, "desktop/build/node/bin/node");
    await access(node); // RED: build.mjs currently removes all desktop/build.
    assert.equal(
      execFileSync(node, ["--version"], { encoding: "utf8" }).trim(),
      process.version,
    );
    assert.equal(
      await readFile(
        path.join(dir, "desktop/build/node/provenance.json"),
        "utf8",
      ),
      '{"fixture":"prepared-host"}',
    );
    await access(path.join(dir, "desktop/build/runtime/desktop/backend.js"));
    await assert.rejects(
      access(path.join(dir, "desktop/build/runtime/stale.js")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
