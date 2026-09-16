import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { userInfo } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  chmod,
  lstat,
  readdir,
  readlink,
  rm,
} from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import {
  createIsolatedInstall,
  isolatedEnvironment,
  extractDistributable,
} from "./desktop-package-isolation.mjs";
import { makeFixture } from "../../scripts/public-update-fixture.mjs";

const checkout = fileURLToPath(new URL("../../", import.meta.url));
const APP = "PR Context Explorer.app";
export function validateGateInputs(env) {
  assert.equal(
    env.PRCE_PUBLIC_UPDATE_CI,
    "1",
    "PRCE_PUBLIC_UPDATE_CI=1 is required",
  );
  assert.equal(env.CI, "true", "run only in a dedicated CI account (CI=true)");
  assert.ok(
    env.PRCE_PUBLIC_UPDATE_ZIP?.endsWith(".zip"),
    "explicit final ZIP required",
  );
  assert.ok(
    env.PRCE_PUBLIC_UPDATE_MANIFEST,
    "explicit public manifest required",
  );
  assert.match(
    env.PRCE_PUBLIC_UPDATE_OLD_VERSION || "",
    /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/,
    "explicit stable fixture version required",
  );
  return {
    zip: path.resolve(env.PRCE_PUBLIC_UPDATE_ZIP),
    manifest: path.resolve(env.PRCE_PUBLIC_UPDATE_MANIFEST),
    oldVersion: env.PRCE_PUBLIC_UPDATE_OLD_VERSION,
  };
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function json(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
async function optionalJson(file) {
  try {
    return await json(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function until(label, fn, ms = 120000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await pause(150);
  }
  throw new Error(`Timed out: ${label}`);
}
async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
// Includes signatures, all resource bytes, paths, executable flags and links.
// Extraction deliberately restricts permission bits; read/write modes are not identity.
export async function treeDigest(root) {
  const hash = createHash("sha256");
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const file = path.join(dir, name),
        st = await lstat(file);
      hash.update(
        JSON.stringify([
          path.relative(root, file),
          st.isDirectory()
            ? "directory"
            : st.isSymbolicLink()
              ? "link"
              : "file",
          Boolean(st.mode & 0o111),
        ]),
      );
      if (st.isSymbolicLink()) hash.update(await readlink(file));
      else if (st.isDirectory()) await walk(file);
      else {
        assert.ok(st.isFile());
        hash.update(await digest(file));
      }
    }
  }
  await walk(root);
  return hash.digest("hex");
}

export async function runMacGate() {
  assert.ok(
    process.platform === "darwin" && process.arch === "arm64",
    "public update gate requires macOS arm64",
  );
  process.umask(0o077);
  const inputs = validateGateInputs(process.env);
  const [
    { validateManifest, compareVersions },
    { bindNativeACL },
    { extractVerifiedZip },
    files,
    helper,
    { validateApp },
  ] = await Promise.all([
    import("../../desktop/public-update/policy.ts"),
    import("../../desktop/public-update/acl.ts"),
    import("../../desktop/public-update/archive.ts"),
    import("../../desktop/public-update/files.ts"),
    import("../../desktop/public-update/helper.ts"),
    import("../../desktop/public-update/validate-app.ts"),
  ]);
  const manifestInput = await json(inputs.manifest);
  const manifest = validateManifest(manifestInput, manifestInput.tag);
  assert.equal(path.basename(inputs.zip), manifest.asset.name);
  assert.ok(
    compareVersions(manifest.version, inputs.oldVersion) > 0,
    "old fixture must precede exact release version",
  );
  assert.equal(await digest(inputs.zip), manifest.asset.sha256);
  assert.equal((await lstat(inputs.zip)).size, manifest.asset.size);
  const install = await createIsolatedInstall(checkout);
  // LaunchServices resolves the actual account home, not an arbitrary HOME override.
  // Refuse existing app data, rather than deleting or redirecting a user's data.
  const accountHome = userInfo().homedir;
  const data = path.join(
    accountHome,
    "Library/Application Support/PR Context Explorer",
  );
  assert.equal(
    await lstat(data).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    }),
    null,
    "dedicated CI account must have no existing PRCE user data",
  );
  const processes = execFileSync("/bin/ps", ["-ww", "-axo", "pid=,comm="], {
    encoding: "utf8",
  });
  assert.ok(
    !processes
      .split("\n")
      .some((line) =>
        line.trim().endsWith("/Contents/MacOS/PR Context Explorer"),
      ),
    "existing PRCE process: refusing acceptance gate",
  );
  await mkdir(data, { mode: 0o700 });
  const dataIdentity = await lstat(data);
  const sentinel = randomBytes(32).toString("hex");
  await writeFile(
    path.join(data, "ci-update-preservation-sentinel"),
    sentinel,
    { mode: 0o600 },
  );
  const owned = new Map();
  const workers = new Map();
  const transactions = [];
  let success = false;
  const evidence = {
    schemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    releaseVersion: manifest.version,
    oldFixtureVersion: inputs.oldVersion,
    finalZipSha256: manifest.asset.sha256,
    cases: [],
  };
  async function track(pid, appPath) {
    const identity = await helper.processIdentity(pid);
    assert.ok(identity && helper.ownedAppIdentity(identity, appPath));
    owned.set(pid, identity);
    return identity;
  }
  async function stop(pid) {
    const expected = owned.get(pid);
    if (!expected) return;
    const actual = await helper.processIdentity(pid);
    if (actual === null) return;
    assert.equal(
      actual,
      expected,
      "refusing to signal changed process identity",
    );
    process.kill(pid, "SIGTERM");
    await until(
      "owned app exit",
      async () => (await helper.processIdentity(pid)) === null,
      20000,
    );
  }
  try {
    // Reuse the existing traversal-safe final-ZIP isolation installer to obtain
    // the signed ACL tool. The updater independently extracts its own target.
    const source = await extractDistributable(inputs.zip, install, checkout);
    execFileSync(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", source],
      { timeout: 120000 },
    );
    bindNativeACL(
      path.join(source, "Contents/Resources/runtime/native/prce-macos-acl"),
    );
    await validateApp(source, manifest.version);
    // Exercise a real extended ACL through the packaged signed native helper.
    const aclProbe = path.join(install.root, "acl-denial-probe");
    await mkdir(aclProbe, { mode: 0o700 });
    execFileSync("/bin/chmod", [
      "+a",
      `${userInfo().username} allow read,write,delete`,
      aclProbe,
    ]);
    try {
      await assert.rejects(
        files.ancestors(aclProbe),
        "permissive macOS ACL must fail closed",
      );
    } finally {
      execFileSync("/bin/chmod", ["-N", aclProbe]);
    }
    await files.ancestors(aclProbe);
    evidence.nativeAclDenial = true;
    const finalTree = await treeDigest(source);
    const fixtures = path.join(install.root, "CI-ONLY-FIXTURES-DO-NOT-PUBLISH");
    await mkdir(fixtures, { mode: 0o700 });
    await writeFile(
      path.join(fixtures, "README.txt"),
      "Explicit locally modified and ad-hoc signed CI fixtures. NOT releases. Never upload.\n",
    );
    for (const rollback of [false, true]) {
      const caseName = rollback ? "rollback" : "install";
      const caseRoot = path.join(fixtures, caseName);
      await mkdir(caseRoot, { mode: 0o700 });
      const appPath = path.join(caseRoot, APP);
      const readyFile = path.join(caseRoot, "fixture-window-ready.json");
      const quitFile = path.join(caseRoot, "fixture-quit");
      await makeFixture({
        source,
        destination: appPath,
        version: inputs.oldVersion,
        scratch: path.join(caseRoot, "asar-scratch"),
        readyFile,
        quitFile,
      });
      await validateApp(appPath, inputs.oldVersion);
      const oldTree = await treeDigest(appPath);
      let zip = inputs.zip,
        candidateManifest = manifest;
      if (rollback) {
        const badDir = path.join(caseRoot, "bad");
        await mkdir(badDir, { mode: 0o700 });
        const badApp = await makeFixture({
          source,
          destination: path.join(badDir, APP),
          version: manifest.version,
          scratch: path.join(badDir, "asar-scratch"),
          brokenBackend: true,
        });
        await validateApp(badApp, manifest.version);
        zip = path.join(caseRoot, "CI-ONLY-broken-backend.zip");
        execFileSync(
          "/usr/bin/ditto",
          ["-c", "-k", "--norsrc", "--keepParent", badApp, zip],
          { timeout: 120000 },
        );
        candidateManifest = validateManifest(
          {
            ...manifest,
            asset: {
              ...manifest.asset,
              size: (await lstat(zip)).size,
              sha256: await digest(zip),
            },
          },
          manifest.tag,
        );
      }
      const child = spawn(
        path.join(appPath, "Contents/MacOS/PR Context Explorer"),
        [],
        {
          cwd: caseRoot,
          env: isolatedEnvironment(accountHome),
          stdio: "ignore",
        },
      );
      child.on("error", (error) => console.error(error));
      await until(
        "owned fixture process identity",
        async () => {
          const identity = await helper.processIdentity(child.pid);
          if (!identity || !helper.ownedAppIdentity(identity, appPath))
            return false;
          owned.set(child.pid, identity);
          return true;
        },
        10000,
      );
      const oldReady = await until(
        "old packaged app real visible window",
        async () => optionalJson(readyFile),
      );
      assert.equal(oldReady.pid, child.pid);
      assert.equal(oldReady.version, inputs.oldVersion);
      assert.equal(oldReady.visible, true);
      assert.equal(oldReady.data, data);
      const oldIdentity = await track(oldReady.pid, appPath);
      // A trusted test driver stages a local artifact; no production discovery URL,
      // transport bypass, renderer API or public release is introduced.
      const nonce = randomBytes(32).toString("hex");
      const work = path.join(caseRoot, `.prce-update-${nonce}`);
      await files.privateDirectory(work);
      await copyFile(zip, path.join(work, "update.zip"));
      await chmod(path.join(work, "update.zip"), 0o600);
      const staged = await extractVerifiedZip(
        path.join(work, "update.zip"),
        path.join(work, "stage"),
        candidateManifest,
        new AbortController().signal,
      );
      await validateApp(staged, candidateManifest.version);
      if (!rollback)
        assert.equal(
          await treeDigest(staged),
          finalTree,
          "release bundle must remain byte-identical",
        );
      for (const [from, to, mode] of [
        ["node/bin/node", "node", 0o700],
        ["public-update-helper.cjs", "helper.cjs", 0o600],
        ["runtime/native/prce-macos-acl", "prce-macos-acl", 0o700],
      ]) {
        await copyFile(
          path.join(appPath, "Contents/Resources", from),
          path.join(work, to),
        );
        await chmod(path.join(work, to), mode);
      }
      const plan = {
        schemaVersion: 1,
        nonce,
        appPath,
        workDir: work,
        oldVersion: inputs.oldVersion,
        manifest: candidateManifest,
        oldPid: child.pid,
        oldIdentity,
        deadline: Date.now() + 180000,
        nodeHash: await digest(path.join(work, "node")),
        helperHash: await digest(path.join(work, "helper.cjs")),
      };
      const planPath = path.join(work, "plan.json");
      helper.validatePlan(plan, planPath);
      await files.writePrivate(planPath, plan);
      transactions.push({ work, appPath, readyFile });
      const worker = spawn(
        path.join(work, "node"),
        [path.join(work, "helper.cjs"), planPath],
        {
          cwd: work,
          env: isolatedEnvironment(accountHome),
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      let workerOutput = "";
      worker.stdout.on("data", (b) => {
        workerOutput += b;
      });
      worker.stderr.on("data", (b) => {
        workerOutput += b;
      });
      const workerDone = new Promise((resolve, reject) => {
        worker.once("error", reject);
        worker.once("exit", (code, signal) => resolve({ code, signal }));
      });
      const workerReady = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Helper readiness timeout: ${workerOutput}`)),
          120000,
        );
        worker.once("message", (msg) => {
          clearTimeout(timer);
          try {
            assert.deepEqual(msg, { type: "ready", nonce });
            resolve();
          } catch (e) {
            reject(e);
          }
        });
        worker.once("exit", (code) => {
          clearTimeout(timer);
          reject(
            new Error(`Helper exited before ready (${code}): ${workerOutput}`),
          );
        });
        worker.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      // Attach rejection handlers immediately; failure still propagates below.
      workerReady.catch(() => {});
      workerDone.catch(() => {});
      const workerIdentity = await helper.processIdentity(worker.pid);
      if (workerIdentity) workers.set(worker.pid, workerIdentity);
      await workerReady;
      // Assert the helper really waits for old-process exit before replacing anything.
      await pause(500);
      assert.equal(await helper.processIdentity(child.pid), oldIdentity);
      assert.equal(await treeDigest(appPath), oldTree);
      assert.equal(await optionalJson(path.join(work, "launch.json")), null);
      await rm(readyFile);
      await writeFile(quitFile, "quit fixture through Electron app.quit()", {
        mode: 0o600,
      });
      await until(
        "old app graceful exit",
        async () => (await helper.processIdentity(child.pid)) === null,
        30000,
      );
      const result = await until(
        "durable helper transaction result",
        async () => optionalJson(path.join(work, "result.json")),
        140000,
      );
      const boot = await json(path.join(work, "boot.json"));
      assert.equal(boot.nonce, nonce);
      assert.equal(boot.version, manifest.version);
      assert.notEqual(boot.pid, child.pid);
      const workerExit = await Promise.race([
        workerDone,
        pause(10000).then(() => {
          throw new Error("helper did not exit");
        }),
      ]);
      if (!rollback) {
        assert.deepEqual(result, {
          phase: "installed",
          version: manifest.version,
        });
        const startup = await json(path.join(work, "startup.json"));
        const commit = await json(path.join(work, "commit.json"));
        assert.deepEqual(startup, boot);
        assert.deepEqual(commit, { nonce, pid: boot.pid });
        assert.equal(await track(boot.pid, appPath), boot.identity);
        assert.equal(workerExit.code, 0, workerOutput);
        assert.equal(await treeDigest(appPath), finalTree);
        await validateApp(appPath, manifest.version);
        assert.equal(
          await helper.processIdentity(boot.pid),
          boot.identity,
          "new app must remain alive after committed bundle verification",
        );
        await stop(boot.pid);
      } else {
        assert.deepEqual(result, { phase: "rolled-back" });
        assert.equal(
          await optionalJson(path.join(work, "commit.json")),
          null,
          "failed startup must never commit",
        );
        assert.equal(
          await helper.processIdentity(boot.pid),
          null,
          "failed new process must be gone",
        );
        assert.equal(
          await treeDigest(appPath),
          oldTree,
          "rollback must restore every old bundle byte",
        );
        const restored = await until(
          "rollback real window, not just open exit zero",
          async () => optionalJson(readyFile),
        );
        assert.equal(restored.version, inputs.oldVersion);
        assert.equal(restored.visible, true);
        assert.notEqual(restored.pid, oldReady.pid);
        await track(restored.pid, appPath);
        await writeFile(quitFile, "quit", { mode: 0o600 });
        await until(
          "restored fixture exit",
          async () => (await helper.processIdentity(restored.pid)) === null,
          30000,
        );
        assert.notEqual(
          workerExit.code,
          0,
          "rollback is reported as failed install by the worker",
        );
      }
      assert.equal(
        await lstat(path.join(caseRoot, ".prce-public-update.lock")).catch(
          (e) => {
            if (e.code === "ENOENT") return null;
            throw e;
          },
        ),
        null,
      );
      assert.equal(
        await readFile(
          path.join(data, "ci-update-preservation-sentinel"),
          "utf8",
        ),
        sentinel,
      );
      evidence.cases.push({
        name: caseName,
        phase: result.phase,
        oldPid: child.pid,
        bootPid: boot.pid,
        nonce,
        workerExit,
      });
    }
    assert.equal(
      await digest(inputs.zip),
      manifest.asset.sha256,
      "final ZIP modified during gate",
    );
    assert.equal(await treeDigest(source), finalTree);
    success = true;
  } finally {
    // On assertion failure stop only captured worker identities, then discover any
    // real main process launched into our private transaction paths. Never kill by name.
    for (const [pid, expected] of workers) {
      const actual = await helper.processIdentity(pid);
      if (actual === null) continue;
      assert.equal(actual, expected, "worker PID identity changed");
      process.kill(pid, "SIGTERM");
      await until(
        "fixture worker exit",
        async () => (await helper.processIdentity(pid)) === null,
        20000,
      );
    }
    for (let scan = 0; scan < 2; scan++) {
      const list = execFileSync("/bin/ps", ["-ww", "-axo", "pid=,comm="], {
        encoding: "utf8",
      });
      for (const line of list.split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!match) continue;
        const transaction = transactions.find(
          (t) =>
            match[2] ===
            path.join(t.appPath, "Contents/MacOS/PR Context Explorer"),
        );
        if (transaction) await track(Number(match[1]), transaction.appPath);
      }
      for (const pid of owned.keys()) await stop(pid);
      if (!scan) await pause(500);
    }
    const now = await lstat(data);
    assert.equal(now.ino, dataIdentity.ino);
    assert.equal(now.dev, dataIdentity.dev);
    assert.equal(now.isSymbolicLink(), false);
    await rm(data, { recursive: true });
    if (success) await install.cleanup();
    else
      console.error(
        `Mac gate failed; private fixture evidence retained at ${install.root}. Never upload fixture assets.`,
      );
  }
  console.log("PUBLIC_UPDATE_MAC_ACCEPTANCE " + JSON.stringify(evidence));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Explicit invocation must fail, never skip into a green publisher gate.
  assert.ok(
    process.platform === "darwin" && process.arch === "arm64",
    "public update gate requires macOS arm64",
  );
  test(
    "final-ZIP public replacement, real startup commit, and real rollback",
    { timeout: 600000 },
    runMacGate,
  );
}
