import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
test("personal macOS defaults use real ad-hoc signing without certificate or invalid hardened library validation", () => {
  const config = require("../desktop/electron-builder.cjs");
  assert.equal(config.mac.identity, "-");
  assert.equal(config.mac.notarize, false);
  assert.equal(config.mac.hardenedRuntime, false);
  assert.equal(config.forceCodeSigning, false);
});
test("desktop web build never auto-loads project env or config files", () => {
  assert.ok(existsSync("desktop/build-web.mjs"));
  const code = readFileSync("desktop/build-web.mjs", "utf8").replace(/\s/g, "");
  for (const boundary of ["configFile:false", "envDir:false", "envPrefix:[]"])
    assert.ok(code.includes(boundary), boundary);
});
test("desktop composition pins sandbox, no navigation/permissions, finite scoped update IPC and native install consent (source invariant)", () => {
  assert.ok(existsSync("desktop/main.ts"), "real Electron entry exists");
  const main = readFileSync("desktop/main.ts", "utf8"),
    preload = readFileSync("desktop/preload.ts", "utf8");
  for (const invariant of [
    "sandbox:true",
    "contextIsolation:true",
    "nodeIntegration:false",
    "requestSingleInstanceLock",
    "setWindowOpenHandler",
    "setPermissionRequestHandler",
    "will-attach-webview",
    "validStatusSender",
    "desktop-runtime.json",
    "Quit for External Update",
  ])
    assert.ok(
      main.replace(/\s/g, "").includes(invariant.replace(/\s/g, "")),
      invariant,
    );
  assert.match(preload, /contextBridge.exposeInMainWorld/);
  assert.match(preload, /prce:status/);
  assert.ok(!preload.includes("send("));
  assert.ok(!preload.includes("token"));
  assert.ok(!main.includes("shell.openExternal"));
});
