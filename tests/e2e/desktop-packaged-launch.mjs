import test, { before, after } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createIsolatedInstall,
  extractDistributable,
  probeRuntime,
  isolatedEnvironment,
  assertIsolated,
} from "./desktop-package-isolation.mjs";
import {
  bounded,
  identity,
  killIdentity,
} from "../../desktop/smoke-helpers.mjs";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  readFile,
  access,
  lstat,
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
const supported = process.platform === "darwin" && process.arch === "arm64";
const checkout = fileURLToPath(new URL("../..", import.meta.url));
const { version } = JSON.parse(
  await readFile(path.join(checkout, "package.json"), "utf8"),
);
let install, installedApp;
before(
  async () => {
    if (!supported) return;
    assert.equal(
      process.env.PRCE_PACKAGED_CI,
      "1",
      "requires an explicitly dedicated fresh macOS CI account (PRCE_PACKAGED_CI=1)",
    );
    assert.equal(
      process.env.PRCE_DESKTOP_APP,
      undefined,
      "build-directory smoke is forbidden; supply PRCE_DESKTOP_ZIP instead",
    );
    install = await createIsolatedInstall(checkout);
    installedApp = await extractDistributable(
      path.resolve(
        process.env.PRCE_DESKTOP_ZIP ||
          path.join(
            checkout,
            `release/PR-Context-Explorer-${version}-arm64.zip`,
          ),
      ),
      install,
      checkout,
    );
    await assertIsolated(installedApp, checkout);
    execFileSync(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", installedApp],
      {
        timeout: 30000,
        maxBuffer: 65536,
        env: isolatedEnvironment(install.home),
      },
    );
    const resources = path.join(installedApp, "Contents/Resources");
    const result = probeRuntime({
      node: path.join(resources, "node/bin/node"),
      runtime: path.join(resources, "runtime"),
      cwd: install.root,
      home: install.home,
    });
    assert.equal(result.backendImported, true);
    assert.ok(result.resolved.typescript);
  },
  { timeout: 180000 },
);
after(async () => {
  await install?.cleanup();
});
test(
  "packaged ACL helper is a real signed arm64 executable outside asar, usable without compiler",
  {
    skip: process.platform !== "darwin" || process.arch !== "arm64",
    timeout: 20000,
  },
  async () => {
    const resources = path.join(installedApp, "Contents/Resources");
    const helper = path.join(resources, "runtime/native/prce-macos-acl");
    const stat = await lstat(helper);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(stat.mode & 0o7777, 0o755);
    const run = (file, args) =>
      execFileSync(file, args, {
        cwd: "/",
        env: { LANG: "C", LC_ALL: "C" },
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 65536,
      });
    assert.equal(run("/usr/bin/lipo", ["-archs", helper]).trim(), "arm64");
    run("/usr/bin/codesign", ["--verify", "--strict", helper]);
    const libraries = run("/usr/bin/otool", ["-L", helper])
      .split("\n")
      .slice(1)
      .filter(Boolean);
    assert.equal(libraries.length, 1);
    assert.match(libraries[0], /^\s+\/usr\/lib\/libSystem\.B\.dylib \(/);
    const probe = await realpath(
      await mkdtemp(path.join(tmpdir(), "prce-packaged-acl-")),
    );
    try {
      run("/bin/chmod", ["-N", probe]);
      const module = path.join(resources, "runtime/src/server/ai/macos-acl.js");
      const output = run(path.join(resources, "node/bin/node"), [
        "--input-type=module",
        "-e",
        `const {readMacDirectoryAcl} = await import(${JSON.stringify(module)}); process.stdout.write(await readMacDirectoryAcl(${JSON.stringify(probe)}));`,
      ]);
      assert.equal(output, '{"version":1,"status":"empty"}\n');
    } finally {
      await rm(probe, { recursive: true, force: true });
    }
  },
);
// Run on a dedicated macOS CI account: this intentionally launches the actual sealed .app.
test(
  "actual packaged Apple Silicon app launches, serves demo and exits its standalone backend",
  {
    skip: process.platform !== "darwin" || process.arch !== "arm64",
    timeout: 90000,
  },
  async () => {
    const app = installedApp;
    const executable = path.join(app, "Contents/MacOS/PR Context Explorer");
    await access(executable);
    // Electron may use the account database rather than HOME for appData.
    // Refuse existing data in either location. Never delete/rename a user's store.
    const accountHome = execFileSync(
      "/usr/bin/python3",
      ["-c", "import os,pwd;print(pwd.getpwuid(os.getuid()).pw_dir)"],
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    const dataPaths = [...new Set([accountHome, install.home])].map((home) =>
      path.join(home, "Library/Application Support/PR Context Explorer"),
    );
    for (const data of dataPaths)
      assert.equal(
        existsSync(data),
        false,
        "dedicated CI account must have no existing app data; preserve it and provision a fresh account",
      );
    let marker;
    await assertIsolated(app, checkout);
    const child = spawn(
      executable,
      ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: install.root,
        detached: true,
        env: isolatedEnvironment(install.home),
      },
    );
    let browser;
    const ownedApp = identity(child.pid);
    let ownedBackend;
    child.stdout.resume();
    const captureBackend = async () => {
      for (const data of dataPaths) {
        const candidate = path.join(data, "desktop-runtime.json");
        try {
          const lease = JSON.parse(await readFile(candidate, "utf8"));
          if (lease.pid === child.pid && lease.executable === executable) {
            const observed = identity(lease.backendPid);
            if (
              observed?.parent === child.pid &&
              observed.command.includes(
                path.join(app, "Contents/Resources/node/bin/node"),
              )
            )
              ownedBackend = observed;
            marker = candidate;
          }
        } catch {
          /* no lease yet */
        }
      }
    };
    const timeout = setTimeout(async () => {
      await captureBackend();
      killIdentity(ownedBackend);
      killIdentity(ownedApp);
      child.kill("SIGKILL");
    }, 80000);
    try {
      const endpoint = await new Promise((resolve, reject) => {
        let log = "";
        child.stderr.on("data", (b) => {
          log = (log + b).slice(-32768);
          const match = log.match(
            /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/,
          );
          if (match) resolve(match[1]);
        });
        child.once("error", reject);
        child.once("exit", () =>
          reject(Error("Packaged app exited before Chromium startup")),
        );
      });
      browser = await chromium.connectOverCDP(endpoint, { timeout: 30000 });
      const context = browser.contexts()[0];
      const page = context.pages()[0] || (await context.waitForEvent("page"));
      await page.waitForFunction(
        () => typeof window.prceDesktop?.status === "function",
        undefined,
        { timeout: 30000 },
      );
      const status = await page.evaluate(() => window.prceDesktop.status());
      assert.equal(status.version, version);
      assert.equal(status.arch, "arm64");
      assert.equal(status.updates.phase, "external");
      assert.equal(await page.evaluate(() => typeof require), "undefined");
      assert.equal((await fetch(page.url())).status, 403);
      await page.waitForFunction(() =>
        document.body.innerText.includes("Demo"),
      );
      await captureBackend();
      assert.ok(marker, "isolated app must own its runtime lease");
      assert.ok(
        ownedBackend,
        "backend must be a verified child using the installed bundled Node",
      );
      const lease = JSON.parse(await readFile(marker, "utf8"));
      assert.equal(lease.pid, child.pid);
      assert.equal(lease.executable, executable);
      const ended = once(child, "exit");
      child.kill("SIGTERM");
      await bounded("normal-quit", () => ended, 10000);
      assert.equal(child.exitCode, 0);
      assert.equal(existsSync(marker), false);
      assert.equal(Number.isSafeInteger(lease.backendPid), true);
      assert.throws(() => process.kill(lease.backendPid, 0));
    } finally {
      clearTimeout(timeout);
      await captureBackend();
      try {
        await bounded("browser-disconnect", () => browser?.close(), 2000);
      } catch {
        /* retain original failure */
      }
      if (child.exitCode === null && child.signalCode === null) {
        const ended = once(child, "exit");
        child.kill("SIGTERM");
        try {
          await bounded("failure-quit", () => ended, 3000);
        } catch {
          killIdentity(ownedBackend);
          killIdentity(ownedApp);
          child.kill("SIGKILL");
          await bounded("failure-kill", () => ended, 3000);
        }
      }
      killIdentity(ownedBackend);
    }
  },
);
