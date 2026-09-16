import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url),
  asar = require("@electron/asar");
const app = path.resolve(
  process.env.PRCE_DESKTOP_APP || "release/mac-arm64/PR Context Explorer.app",
);
test("packaged app has actual arm64 Mach-O main and Node, runtime, resources, sealed minimal asar (structural, not macOS execution)", async () => {
  const resources = path.join(app, "Contents/Resources");
  for (const name of [
    "Contents/MacOS/PR Context Explorer",
    "Contents/Resources/node/bin/node",
  ]) {
    const bytes = await readFile(path.join(app, name));
    assert.equal(bytes.readUInt32LE(0), 0xfeedfacf);
    assert.equal(bytes.readUInt32LE(4), 0x0100000c);
  }
  for (const name of [
    "node/LICENSE",
    "node/provenance.json",
    "runtime/desktop/backend.js",
    "runtime/src/server/ai/index.js",
    "runtime/src/server/ai/launcher.cjs",
    "runtime/dist/index.html",
    "runtime/references/pr-context-reviewer-prompts/runtime/00-common-system.md",
  ])
    await access(path.join(resources, name));
  const files = asar.listPackage(path.join(resources, "app.asar"));
  assert.ok(files.includes("/main.cjs"));
  assert.ok(files.includes("/preload.cjs"));
  assert.ok(!files.some((f) => f.includes("node_modules")));
  const pkg = JSON.parse(
    asar.extractFile(path.join(resources, "app.asar"), "package.json"),
  );
  assert.equal(pkg.version, JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")).version);
  const plist = await readFile(path.join(app, "Contents/Info.plist"), "utf8");
  assert.ok(plist.includes("com.runaticmoon.pr-context-explorer"));
  const {
    getCurrentFuseWire,
    FuseV1Options,
    FuseState,
  } = require("@electron/fuses");
  const wire = await getCurrentFuseWire(app);
  for (const option of [
    FuseV1Options.RunAsNode,
    FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    FuseV1Options.EnableNodeCliInspectArguments,
  ])
    assert.equal(wire[option], FuseState.DISABLE);
  for (const option of [
    FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
    FuseV1Options.OnlyLoadAppFromAsar,
  ])
    assert.equal(wire[option], FuseState.ENABLE);
  assert.ok(plist.includes("ElectronAsarIntegrity"));
});
