import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const builder = require("electron-builder/out/builder.js");
const { Packager } = require("app-builder-lib");
const {
  PublishManager,
} = require("app-builder-lib/out/publish/PublishManager.js");

test("npm build-only mac scripts deliver scalar never to the real builder publish processor even with redundant CI flags", async () => {
  const root = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), "prce-build-args-"));
  try {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: pkg.scripts }),
    );
    await mkdir(path.join(dir, "bin"));
    // Execute npm's real compound script in an isolated cwd. Replace only costly
    // build/download commands; capture the actual final executable argv.
    for (const command of ["npm", "node", "electron-builder"])
      await writeFile(
        path.join(dir, "bin", command),
        `#!${process.execPath}\nif (${JSON.stringify(command)} === 'node' && process.argv[2] === 'desktop/package-mac.mjs') { const r = require('node:child_process').spawnSync(process.execPath, process.argv.slice(2), {stdio:'inherit', env:process.env}); process.exit(r.status ?? 1); } require('node:fs').appendFileSync(process.env.CAPTURE, JSON.stringify({command:${JSON.stringify(command)},args:process.argv.slice(2)})+'\\n');\n`,
        { mode: 0o755 },
      );
    // A wrapper, if present, runs for real with its pinned parser/build imports.
    await symlink(path.join(root, "desktop"), path.join(dir, "desktop"), "dir");
    const npm = execFileSync("/bin/sh", ["-c", "command -v npm"], {
      encoding: "utf8",
    }).trim();
    for (const script of ["desktop:dist:mac", "desktop:pack:mac"]) {
      const capture = path.join(dir, `${script.replaceAll(":", "-")}.jsonl`);
      execFileSync(
        process.execPath,
        [
          npm,
          "run",
          script,
          "--",
          "--publish",
          "never",
          "-c.directories.output=release",
        ],
        {
          cwd: dir,
          encoding: "utf8",
          env: {
            PATH: path.join(dir, "bin") + ":" + process.env.PATH,
            HOME: dir,
            CAPTURE: capture,
            npm_config_update_notifier: "false",
          },
        },
      );
      const commands = (await readFile(capture, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const invocation = commands.find(
        (item) => item.command === "electron-builder",
      );
      assert.ok(invocation, "actual electron-builder executable reached");
      const options = builder.normalizeOptions(
        builder
          .configureBuildCommand(builder.createYargs())
          .parse(invocation.args),
      );
      assert.equal(
        options.publish,
        "never",
        "never must be a scalar, not a repeated-option array",
      );
      const packager = new Packager(options);
      const manager = new PublishManager(packager, options);
      assert.equal(
        manager.isPublish,
        false,
        "real publisher processor must not initialize publishing",
      );
      await packager.emitArtifactCreated({
        file: "not-uploaded.zip",
        publishConfig: require("../desktop/electron-builder.cjs").publish[0],
      });
      await manager.awaitTasks();
      assert.equal(
        manager.nameToPublisher.size,
        0,
        "artifact events must not create GitHubPublisher",
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
