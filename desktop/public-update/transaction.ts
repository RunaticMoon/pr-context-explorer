import { mkdir, lstat, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  ancestors,
  privateDirectory,
  writePrivate,
  readPrivate,
  syncDirectory,
  uid,
} from "./files.ts";
import { APP_NAME, errorCode, fail } from "./policy.ts";
export interface Transaction {
  appPath: string;
  stagedApp: string;
  workDir: string;
  version: string;
  oldVersion: string;
}
export interface TransactionPorts {
  validate: (app: string, version: string) => Promise<void>;
  launch: (app: string) => Promise<void>;
  rollbackLaunch: (app: string) => Promise<void>;
  stopFailedLaunch?: () => Promise<void>;
  checkpoint: (step: string) => Promise<void>;
}
export interface UpdateLock {
  path: string;
  nonce: string;
  release: () => Promise<void>;
}
export async function acquireLock(appPath: string): Promise<UpdateLock> {
  const directory = path.join(
    path.dirname(appPath),
    ".prce-public-update.lock",
  );
  await ancestors(path.dirname(directory));
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch {
    fail("UPDATE_LOCKED");
  }
  const nonce = randomBytes(32).toString("hex");
  await writePrivate(path.join(directory, "owner.json"), {
    nonce,
    pid: process.pid,
  });
  return {
    path: directory,
    nonce,
    release: async () => {
      await privateDirectory(directory);
      const owner = (await readPrivate(path.join(directory, "owner.json"))) as {
        nonce?: string;
      };
      if (owner.nonce !== nonce) fail("UPDATE_LOCKED");
      await rm(directory, { recursive: true });
      await syncDirectory(path.dirname(directory));
    },
  };
}
export async function replaceTransaction(
  t: Transaction,
  ports: TransactionPorts,
  heldLock?: UpdateLock,
) {
  if (
    path.basename(t.appPath) !== APP_NAME ||
    path.basename(t.stagedApp) !== APP_NAME ||
    !t.stagedApp.startsWith(t.workDir + path.sep) ||
    path.dirname(t.workDir) !== path.dirname(t.appPath)
  )
    fail("UNSAFE_PLAN");
  await ancestors(path.dirname(t.appPath));
  await privateDirectory(t.workDir);
  const appStat = await lstat(t.appPath),
    workStat = await lstat(t.workDir);
  if (
    !appStat.isDirectory() ||
    appStat.isSymbolicLink() ||
    appStat.uid !== uid() ||
    appStat.dev !== workStat.dev
  )
    fail("UNSAFE_APP");
  const lock = heldLock ?? (await acquireLock(t.appPath));
  let oldMoved = false,
    newMoved = false,
    finished = false;
  const backup = path.join(t.workDir, "previous.app"),
    failed = path.join(t.workDir, "failed.app");
  try {
    if (
      (await lstat(backup).catch(() => null)) ||
      (await lstat(failed).catch(() => null))
    )
      fail("BACKUP_EXISTS");
    await ports.validate(t.appPath, t.oldVersion);
    await ports.validate(t.stagedApp, t.version);
    await ports.checkpoint("validated");
    await rename(t.appPath, backup);
    oldMoved = true;
    await syncDirectory(path.dirname(t.appPath));
    await ports.checkpoint("old-renamed");
    await rename(t.stagedApp, t.appPath);
    newMoved = true;
    await syncDirectory(path.dirname(t.appPath));
    await ports.checkpoint("new-renamed");
    await ports.validate(t.appPath, t.version);
    await ports.launch(t.appPath);
    // Readiness is irreversible: the new instance may now admit user work.
    // Post-commit journal failures must never trigger rollback or process signals.
    finished = true;
    await ports.checkpoint("started").catch(() => {});
    await writePrivate(path.join(t.workDir, "result.json"), {
      phase: "installed",
      version: t.version,
    }).catch(() => {});
  } catch (error) {
    if (oldMoved) {
      let stage = "marking";
      try {
        await ports.checkpoint("restoring");
        if (newMoved) {
          stage = "stop-failed";
          await ports.stopFailedLaunch?.();
          stage = "parking-failed";
          await rename(t.appPath, failed);
        }
        stage = "restoring";
        await rename(backup, t.appPath);
        await syncDirectory(path.dirname(t.appPath));
        stage = "revalidating";
        await ports.validate(t.appPath, t.oldVersion);
        stage = "relaunching";
        await ports.checkpoint("relaunching");
        await ports.rollbackLaunch(t.appPath);
        stage = "recording";
        await writePrivate(path.join(t.workDir, "result.json"), {
          phase: "rolled-back",
        });
        finished = true;
      } catch (rollbackError) {
        // Preserve primary and cleanup causes; both are bounded codes, never
        // arbitrary error text.
        await writePrivate(path.join(t.workDir, "failure.json"), {
          phase: "failed",
          code: errorCode(error, "TRANSACTION_FAILED"),
          rollbackCode: errorCode(rollbackError, "ROLLBACK_STEP_FAILED"),
          stage,
          at: Date.now(),
        }).catch(() => {});
        fail("ROLLBACK_FAILED");
      }
    } else finished = true;
    throw error;
  } finally {
    // Preserve lock on uncertain rollback. Never auto-steal a stale lock.
    if (finished) await lock.release();
  }
}
