// CI-only fixture construction. Never imported by the shipped application.
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const command = (file, args) =>
  execFileSync(file, args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 4_000_000,
  });

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
    pkg.main = "ci-fixture-main.cjs";
    // Observes the real production window; never manufactures updater receipts.
    await writeFile(
      path.join(scratch, pkg.main),
      `const {app}=require('electron');
const fs=require('node:fs');
const ready=${JSON.stringify(readyFile)}, quit=${JSON.stringify(quitFile)};
app.on('browser-window-created',(_event,win)=>{
  const timer=setInterval(()=>{
    if(win.isDestroyed()) return clearInterval(timer);
    if(!win.isVisible() || win.webContents.isLoading() || !win.webContents.getURL().startsWith('http://127.0.0.1:')) return;
    fs.writeFileSync(ready+'.tmp',JSON.stringify({pid:process.pid,version:app.getVersion(),visible:true,url:win.webContents.getURL(),data:app.getPath('userData')}),{mode:0o600});
    fs.renameSync(ready+'.tmp',ready); clearInterval(timer);
  },100);
});
setInterval(()=>{if(fs.existsSync(quit)){fs.unlinkSync(quit);app.quit();}},100).unref();
require(${JSON.stringify(original)});
`,
    );
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
