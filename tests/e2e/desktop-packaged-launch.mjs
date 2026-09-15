import test from "node:test";
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
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
test(
  "packaged ACL helper is a real signed arm64 executable outside asar, usable without compiler",
  {
    skip: process.platform !== "darwin" || process.arch !== "arm64",
    timeout: 20000,
  },
  async () => {
    const resources = path.resolve(
      process.env.PRCE_DESKTOP_APP ||
        "release/mac-arm64/PR Context Explorer.app",
      "Contents/Resources",
    );
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
    const app = path.resolve(
      process.env.PRCE_DESKTOP_APP ||
        "release/mac-arm64/PR Context Explorer.app",
    );
    const executable = path.join(app, "Contents/MacOS/PR Context Explorer");
    await access(executable);
    const marker = path.join(
      homedir(),
      "Library/Application Support/PR Context Explorer/desktop-runtime.json",
    );
    assert.equal(
      existsSync(marker),
      false,
      "use a dedicated idle CI account; do not interfere with a running app",
    );
    const child = spawn(
      executable,
      ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: homedir(),
          LANG: "en_US.UTF-8",
        },
      },
    );
    let browser;
    const timeout = setTimeout(() => child.kill("SIGKILL"), 80000);
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
        { timeout: 30000 },
      );
      const status = await page.evaluate(() => window.prceDesktop.status());
      assert.equal(status.version, "0.4.0");
      assert.equal(status.arch, "arm64");
      assert.equal(status.updates.phase, "external");
      assert.equal(await page.evaluate(() => typeof require), "undefined");
      assert.equal((await fetch(page.url())).status, 403);
      await page.waitForFunction(() =>
        document.body.innerText.includes("Demo"),
      );
      const lease = JSON.parse(await readFile(marker, "utf8"));
      assert.equal(lease.pid, child.pid);
      assert.equal(lease.executable, executable);
      const ended = once(child, "exit");
      child.kill("SIGTERM");
      await ended;
      assert.equal(child.exitCode, 0);
      assert.equal(existsSync(marker), false);
      assert.equal(Number.isSafeInteger(lease.backendPid), true);
      assert.throws(() => process.kill(lease.backendPid, 0));
    } finally {
      clearTimeout(timeout);
      await browser?.close().catch(() => {});
      child.kill("SIGTERM");
    }
  },
);
