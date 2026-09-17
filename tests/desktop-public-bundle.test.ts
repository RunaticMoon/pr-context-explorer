import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isBuiltin } from "node:module";
import { spawnSync } from "node:child_process";
test("public helper and main bundle package dependencies; standalone helper loads outside checkout", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prce-updater-bundle-"));
  try {
    for (const [entry, outfile, external] of [
      ["desktop/public-update/helper-entry.ts", "helper.cjs", []],
      ["desktop/main.ts", "main.cjs", ["electron"]],
    ] as const) {
      const output = await build({
        entryPoints: [entry],
        outfile: path.join(dir, outfile),
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node24",
        external: [...external],
        metafile: true,
        define: {
          __PRCE_SIGNED_BUILD__: "false",
          __PRCE_PUBLIC_UPDATES__: "true",
          __PRCE_TEAM_ID__: '""',
        },
      });
      for (const item of Object.values(output.metafile!.outputs))
        for (const dep of item.imports)
          assert.ok(
            !dep.external || isBuiltin(dep.path) || dep.path === "electron",
            dep.path,
          );
      if (outfile === "main.cjs")
        assert.ok(
          Object.keys(output.metafile!.inputs).some((p) =>
            p.includes("node_modules/yauzl/"),
          ),
        );
    }
    const result = spawnSync(process.execPath, [path.join(dir, "helper.cjs")], {
      cwd: dir,
      env: { PATH: "/usr/bin:/bin", HOME: dir },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 1, "no untrusted/missing plan is accepted");
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
