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
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

test("rebuilding compiled desktop output preserves the prepared host Node sidecar used before firstWindow", async () => {
  const root = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), "prce-rebuild-"));
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
      timeout: 30000,
    });
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
    await access(path.join(dir, "desktop/build/app/main.cjs"));
    await access(path.join(dir, "desktop/build/runtime/desktop/backend.js"));
    await assert.rejects(
      access(path.join(dir, "desktop/build/runtime/stale.js")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
