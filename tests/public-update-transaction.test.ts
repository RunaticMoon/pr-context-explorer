import "./public-update-test-support.ts";
import { realpath, chmod } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  replaceTransaction,
  acquireLock,
} from "../desktop/public-update/transaction.ts";
import { createRequire } from "node:module";
import {
  verifyMachO,
  asarPackage,
} from "../desktop/public-update/validate-app.ts";
import { privateDirectory } from "../desktop/public-update/files.ts";
test("Mach-O gate rejects synthetic non-arm64 executable bytes", async () => {
  const root = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "public-macho-"),
  );
  try {
    const f = path.join(root, "x");
    await writeFile(f, "not executable");
    await assert.rejects(verifyMachO(f));
    const b = Buffer.alloc(32);
    b.writeUInt32LE(0xfeedfacf);
    b.writeUInt32LE(0x0100000c, 4);
    b.writeUInt32LE(2, 12);
    await writeFile(f, b);
    await assert.rejects(verifyMachO(f));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("synthetic Linux transaction rolls back startup failure and preserves old app sentinel", async () => {
  const root = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "public-swap-"),
  );
  try {
    const app = path.join(root, "PR Context Explorer.app"),
      stage = await privateDirectory(path.join(root, ".prce-update-test"));
    const candidate = path.join(stage, "PR Context Explorer.app");
    await mkdir(app);
    await mkdir(candidate);
    await writeFile(path.join(app, "sentinel"), "old");
    await writeFile(path.join(candidate, "sentinel"), "new");
    await assert.rejects(
      replaceTransaction(
        {
          appPath: app,
          stagedApp: candidate,
          workDir: stage,
          version: "0.6.0",
          oldVersion: "0.5.1",
        },
        {
          validate: async () => {},
          launch: async (p) => {
            assert.equal(
              await readFile(path.join(p, "sentinel"), "utf8"),
              "new",
            );
            throw Error("startup failed");
          },
          rollbackLaunch: async () => {},
          checkpoint: async () => {},
        },
      ),
    );
    assert.equal(await readFile(path.join(app, "sentinel"), "utf8"), "old");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("synthetic transaction locks out another writer and rollback covers failure after old rename", async () => {
  for (const step of ["old-renamed", "new-renamed"]) {
    const root = await mkdtemp(
      path.join(await realpath(os.tmpdir()), "public-swap-"),
    );
    try {
      const app = path.join(root, "PR Context Explorer.app"),
        stage = await privateDirectory(path.join(root, ".prce-update-test")),
        candidate = path.join(stage, "PR Context Explorer.app");
      await mkdir(app);
      await mkdir(candidate);
      await writeFile(path.join(app, "sentinel"), "old");
      await writeFile(path.join(candidate, "sentinel"), "new");
      await assert.rejects(
        replaceTransaction(
          {
            appPath: app,
            stagedApp: candidate,
            workDir: stage,
            version: "0.6.0",
            oldVersion: "0.5.1",
          },
          {
            validate: async () => {},
            launch: async () => {},
            rollbackLaunch: async () => {},
            checkpoint: async (s) => {
              if (s === step) throw Error("injected fault");
            },
          },
        ),
      );
      assert.equal(await readFile(path.join(app, "sentinel"), "utf8"), "old");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("lock ownership excludes competing writers without touching app", async () => {
  const root = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "public-lock-"),
  );
  try {
    const app = path.join(root, "PR Context Explorer.app");
    await mkdir(app);
    await writeFile(path.join(app, "sentinel"), "old");
    const lock = await acquireLock(app);
    await assert.rejects(acquireLock(app), /UPDATE_LOCKED/);
    assert.equal(await readFile(path.join(app, "sentinel"), "utf8"), "old");
    await lock.release();
    const next = await acquireLock(app);
    await next.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("successful readiness is the commit point: journaling fault cannot kill new user work", async () => {
  const root = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "public-commit-"),
  );
  try {
    const app = path.join(root, "PR Context Explorer.app"),
      stage = await privateDirectory(path.join(root, ".prce-update-test")),
      candidate = path.join(stage, "PR Context Explorer.app");
    await mkdir(app);
    await mkdir(candidate);
    await writeFile(path.join(app, "sentinel"), "old");
    await writeFile(path.join(candidate, "sentinel"), "new");
    let stopped = false;
    await replaceTransaction(
      {
        appPath: app,
        stagedApp: candidate,
        workDir: stage,
        version: "0.6.0",
        oldVersion: "0.5.1",
      },
      {
        validate: async () => {},
        launch: async () => {
          await writeFile(path.join(stage, "result.json"), "occupied");
        },
        stopFailedLaunch: async () => {
          stopped = true;
        },
        rollbackLaunch: async () => {},
        checkpoint: async () => {},
      },
    );
    assert.equal(stopped, false);
    assert.equal(await readFile(path.join(app, "sentinel"), "utf8"), "new");
    assert.equal(
      await readFile(path.join(stage, "previous.app/sentinel"), "utf8"),
      "old",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("actual ASAR package reader validates bounded embedded package version", async () => {
  const root = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "public-asar-"),
  );
  try {
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(
      path.join(source, "package.json"),
      JSON.stringify({ name: "pr-context-explorer", version: "0.6.0" }),
    );
    const archive = path.join(root, "app.asar");
    const { createPackage } = createRequire(import.meta.url)("@electron/asar");
    await createPackage(source, archive);
    await chmod(archive, 0o644);
    assert.equal((await asarPackage(archive)).version, "0.6.0");
    await writeFile(archive, "malformed");
    await assert.rejects(asarPackage(archive));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
