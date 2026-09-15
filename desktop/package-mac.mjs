import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  createYargs,
  configureBuildCommand,
} = require("electron-builder/out/builder.js");
const parse = (args) =>
  configureBuildCommand(createYargs()).exitProcess(false).parse(args);
const args = process.argv.slice(2);
const policy = parse(args).publish;
if (
  policy !== undefined &&
  ![policy].flat().every((value) => value === "never")
)
  throw Error("Desktop packaging is build-only; publishing is not permitted");
const forwarded = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--publish" || args[i] === "-p") {
    i++;
    continue;
  }
  if (args[i].startsWith("--publish=") || args[i].startsWith("-p=")) continue;
  forwarded.push(args[i]);
}
forwarded.push("--publish", "never");
// Verify with the same pinned parser used by the child: duplicate options are
// arrays in electron-builder 26, and an array is not the policy string "never".
if (parse(forwarded).publish !== "never")
  throw Error("Ambiguous build-only publish policy");
const result = spawnSync("electron-builder", forwarded, {
  stdio: "inherit",
  shell: false,
});
if (result.error) throw Error("Unable to start desktop packager");
process.exitCode = result.status ?? 1;
