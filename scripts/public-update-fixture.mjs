// CI-only fixture construction. Never imported by the shipped application.
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fixtureConsent from "./public-update-fixture-consent.cjs";
const require = createRequire(import.meta.url);
const command = (file, args) =>
  execFileSync(file, args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 4_000_000,
  });

/**
 * Bounded quit-observability file written beside the quit file by the fixture
 * main: fixed keys, one pid, booleans only. Diagnostics — never an assertion.
 */
export const FIXTURE_QUIT_STATE = "fixture-quit-state.json";

/**
 * Fixture-only consent module bundled into the repacked app.asar beside the
 * generated main. It carries the single simulated user answer the gate is
 * allowed to get; the shipped bundle never contains it.
 */
export const FIXTURE_CONSENT_MODULE = "public-update-fixture-consent.cjs";

// Canonical quit-request builder shared with the gate: the request binds to
// the fixture instance through the per-launch token and pid from its ready
// handshake.
export const fixtureQuitRequest = fixtureConsent.fixtureQuitRequest;

/**
 * Writes the generated fixture main and bundles the consent module beside it.
 * Portable: only file writes into `directory`, no platform or identity
 * assertions — makeFixture owns the macOS/codesign boundary.
 */
export async function writeFixtureShim({
  directory,
  readyFile,
  quitFile,
  original,
}) {
  await copyFile(
    fileURLToPath(new URL(`./${FIXTURE_CONSENT_MODULE}`, import.meta.url)),
    path.join(directory, FIXTURE_CONSENT_MODULE),
  );
  await writeFile(
    path.join(directory, "ci-fixture-main.cjs"),
    `const {app,dialog}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const ready=${JSON.stringify(readyFile)}, quit=${JSON.stringify(quitFile)};
const stateFile=path.join(path.dirname(quit),${JSON.stringify(FIXTURE_QUIT_STATE)});
const quitToken=crypto.randomBytes(16).toString('hex');
const quitState={pid:process.pid,consumed:false,requested:false,called:false,beforeQuit:false,willQuit:false,quit:false,consent:false};
const record=()=>{try{fs.writeFileSync(stateFile+'.tmp',JSON.stringify(quitState),{mode:0o600});fs.renameSync(stateFile+'.tmp',stateFile)}catch{}};
record();
const shim=require(${JSON.stringify("./" + FIXTURE_CONSENT_MODULE)}).createFixtureConsent({token:quitToken,pid:process.pid,onConsent:()=>{quitState.consent=true;record()}});
dialog.showMessageBox=shim.showMessageBox(dialog.showMessageBox.bind(dialog));
app.on('before-quit',()=>{shim.beforeQuit();quitState.beforeQuit=true;record()});
app.on('will-quit',()=>{quitState.willQuit=true;record()});
app.on('quit',()=>{shim.quit();quitState.quit=true;record()});
app.on('browser-window-created',(_event,win)=>{
  const timer=setInterval(()=>{
    if(win.isDestroyed()) return clearInterval(timer);
    if(!win.isVisible() || win.webContents.isLoading() || !win.webContents.getURL().startsWith('http://127.0.0.1:')) return;
    let m;try{m=JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'desktop-runtime.json'),'utf8'))}catch{return}
    if(m.pid!==process.pid || m.ready!==true) return;
    fs.writeFileSync(ready+'.tmp',JSON.stringify({pid:process.pid,version:app.getVersion(),visible:true,ready:true,url:win.webContents.getURL(),data:app.getPath('userData'),quitToken}),{mode:0o600});
    fs.renameSync(ready+'.tmp',ready); clearInterval(timer);
  },100);
});
setInterval(()=>{if(fs.existsSync(quit)){quitState.consumed=true;let content=null;try{content=fs.readFileSync(quit,'utf8')}catch{}try{fs.unlinkSync(quit)}catch{}if(shim.consume(content)){quitState.requested=true;quitState.called=true;record();app.quit()}else record()}},100).unref();
require(${JSON.stringify(original)});
`,
  );
  return "ci-fixture-main.cjs";
}

export async function makeFixture({
  source,
  destination,
  version,
  scratch,
  readyFile,
  quitFile,
  brokenBackend = false,
}) {
  assert.equal(process.platform, "darwin", "fixtures require macOS");
  assert.equal(
    process.env.PRCE_PUBLIC_UPDATE_CI,
    "1",
    "explicit fixture consent required",
  );
  assert.ok(
    destination !== source &&
      destination.startsWith(path.dirname(scratch) + path.sep),
  );
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  command("/usr/bin/ditto", [source, destination]);
  const resources = path.join(destination, "Contents/Resources");
  const archive = path.join(resources, "app.asar");
  const asar = require("@electron/asar");
  await mkdir(scratch, { mode: 0o700 });
  asar.extractAll(archive, scratch);
  const pkgPath = path.join(scratch, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  pkg.version = version;
  if (!brokenBackend) {
    const original = "./" + pkg.main.replace(/^\.\//, "");
    // Observes the real production window; never manufactures updater receipts.
    // The generated main additionally simulates ONE user answer — the
    // affirmative response to the exact exit-work confirmation — and only
    // while a quit request validated against this instance's token and pid is
    // in flight. Production code is unchanged; the consent module ships only
    // inside this repacked fixture.
    pkg.main = await writeFixtureShim({
      directory: scratch,
      readyFile,
      quitFile,
      original,
    });
  } else {
    // Real packaged backend failure after production main has registered boot.
    await writeFile(
      path.join(resources, "runtime/desktop/backend.js"),
      "throw new Error('EXPLICIT CI FIXTURE: backend startup failure');\n",
    );
  }
  await writeFile(pkgPath, JSON.stringify(pkg));
  await rm(archive);
  await asar.createPackage(scratch, archive);
  const plist = path.join(destination, "Contents/Info.plist");
  const info = JSON.parse(
    command("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]),
  );
  info.CFBundleShortVersionString = version;
  info.CFBundleVersion = version;
  if (info.ElectronAsarIntegrity) {
    assert.ok(
      info.ElectronAsarIntegrity["Resources/app.asar"],
      "unexpected ASAR integrity layout",
    );
    info.ElectronAsarIntegrity["Resources/app.asar"] = {
      algorithm: "SHA256",
      hash: createHash("sha256")
        .update(asar.getRawHeader(archive).headerString)
        .digest("hex"),
    };
  }
  await writeFile(plist, JSON.stringify(info));
  command("/usr/bin/plutil", ["-convert", "xml1", plist]);
  command("/usr/bin/codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    "--preserve-metadata=entitlements",
    destination,
  ]);
  command("/usr/bin/codesign", ["--verify", "--deep", "--strict", destination]);
  await rm(scratch, { recursive: true });
  return destination;
}
