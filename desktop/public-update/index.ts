import { bindNativeACL } from "./acl.ts";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { rename, lstat, rm } from "node:fs/promises";
import {
  APP_NAME,
  UpdateError,
  fail,
  version,
  compareVersions,
  validateManifest,
  type Manifest,
} from "./policy.ts";
import { discover, downloadAsset } from "./network.ts";
import {
  privateDirectory,
  ancestors,
  exclusiveFile,
  safeFile,
  ownedRemove,
  writePrivate,
  hashFile,
} from "./files.ts";
import { extractVerifiedZip } from "./archive.ts";
import { validateApp } from "./validate-app.ts";
import {
  processIdentity,
  ownedAppIdentity,
  type InstallPlan,
} from "./helper.ts";
export { registerStartup, acknowledgeStartup } from "./helper.ts";
export type Phase =
  | "idle"
  | "checking"
  | "available"
  | "current"
  | "downloading"
  | "downloaded"
  | "preparing"
  | "ready"
  | "cancelled"
  | "error";
export interface PublicUpdateStatus {
  phase: Phase;
  version?: string;
  received?: number;
  total?: number;
  errorCode?: string;
}
export interface PublicUpdaterOptions {
  currentVersion: string;
  appPath: string;
  dataDir: string;
  nodePath: string;
  helperPath: string;
  isBusy: () => boolean;
  onStatus?: (status: PublicUpdateStatus) => void;
}
async function copyOwned(source: string, destination: string, mode = 0o600) {
  const input = await safeFile(source),
    output = await exclusiveFile(destination, mode);
  try {
    for await (const b of input.createReadStream({ autoClose: false }))
      await output.writeFile(b);
    await output.sync();
  } finally {
    await input.close();
    await output.close();
  }
}
export class PublicUpdater {
  private state: PublicUpdateStatus = { phase: "idle" };
  private manifest: Manifest | null = null;
  private archive: string | null = null;
  private cacheJob: string | null = null;
  private work: string | null = null;
  private handed = false;
  private controller: AbortController | null = null;
  private pending: Promise<unknown> | null = null;
  private closed = false;
  private options: PublicUpdaterOptions;
  constructor(options: PublicUpdaterOptions) {
    version(options.currentVersion);
    this.options = { ...options };
    bindNativeACL(
      path.join(
        options.appPath,
        "Contents/Resources/runtime/native/prce-macos-acl",
      ),
    );
  }
  get status(): PublicUpdateStatus {
    return { ...this.state };
  }
  private emit(state: PublicUpdateStatus) {
    this.state = state;
    try {
      this.options.onStatus?.({ ...state });
    } catch {
      /* host observers cannot alter update control flow */
    }
  }
  private run<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new UpdateError("CLOSED"));
    if (this.pending) return Promise.reject(new UpdateError("IN_PROGRESS"));
    const c = new AbortController();
    this.controller = c;
    const promise = action(c.signal)
      .catch((error) => {
        const code = c.signal.aborted
          ? "CANCELLED"
          : error instanceof UpdateError
            ? error.code
            : "UPDATE_FAILED";
        this.emit({
          phase: code === "CANCELLED" ? "cancelled" : "error",
          errorCode: code,
        });
        throw new UpdateError(code);
      })
      .finally(() => {
        this.pending = null;
        this.controller = null;
      });
    this.pending = promise;
    return promise;
  }
  check(): Promise<PublicUpdateStatus> {
    return this.run(async (signal) => {
      if (this.handed) fail("HANDOFF_ACTIVE");
      this.emit({ phase: "checking" });
      const manifest = await discover(this.options.currentVersion, signal);
      if (signal.aborted) fail("CANCELLED");
      await this.clearDownload();
      this.manifest = manifest;
      this.emit(
        manifest
          ? { phase: "available", version: manifest.version }
          : { phase: "current", version: this.options.currentVersion },
      );
      return this.status;
    });
  }
  download(): Promise<PublicUpdateStatus> {
    return this.run(async (signal) => {
      if (this.handed) fail("HANDOFF_ACTIVE");
      if (!this.manifest) fail("NO_UPDATE");
      const manifest = validateManifest(this.manifest, this.manifest.tag);
      if (compareVersions(manifest.version, this.options.currentVersion) <= 0)
        fail("INVALID_VERSION");
      await this.clearDownload();
      await privateDirectory(this.options.dataDir);
      const cache = await privateDirectory(
        path.join(this.options.dataDir, "public-updates"),
      );
      this.cacheJob = await privateDirectory(
        path.join(cache, randomBytes(16).toString("hex")),
      );
      const partial = path.join(this.cacheJob, "download.partial");
      const file = await exclusiveFile(partial);
      this.emit({
        phase: "downloading",
        version: manifest.version,
        received: 0,
        total: manifest.asset.size,
      });
      try {
        await downloadAsset(manifest, file, signal, (n) =>
          this.emit({
            phase: "downloading",
            version: manifest.version,
            received: n,
            total: manifest.asset.size,
          }),
        );
      } catch (e) {
        await file.close();
        await this.clearDownload();
        throw e;
      }
      await file.close();
      if (signal.aborted) {
        await this.clearDownload();
        fail("CANCELLED");
      }
      this.archive = path.join(this.cacheJob, "update.zip");
      await rename(partial, this.archive);
      this.emit({
        phase: "downloaded",
        version: manifest.version,
        received: manifest.asset.size,
        total: manifest.asset.size,
      });
      return this.status;
    });
  }
  prepareInstall(): Promise<PublicUpdateStatus> {
    return this.run(async (signal) => {
      if (this.options.isBusy()) fail("BUSY");
      if (this.handed) fail("HANDOFF_ACTIVE");
      if (!this.manifest || !this.archive) fail("NOT_DOWNLOADED");
      if (process.platform !== "darwin" || process.arch !== "arm64")
        fail("UNSUPPORTED_PLATFORM");
      const { appPath, currentVersion, nodePath, helperPath } = this.options;
      if (
        path.basename(appPath) !== APP_NAME ||
        nodePath !== path.join(appPath, "Contents/Resources/node/bin/node") ||
        helperPath !==
          path.join(appPath, "Contents/Resources/public-update-helper.cjs")
      )
        fail("UNSAFE_HOST_PATH");
      await ancestors(path.dirname(appPath));
      await validateApp(appPath, currentVersion);
      const manifest = validateManifest(this.manifest, this.manifest.tag),
        nonce = randomBytes(32).toString("hex");
      this.work = await privateDirectory(
        path.join(path.dirname(appPath), `.prce-update-${nonce}`),
      );
      const work = this.work;
      let spawned = false;
      this.emit({ phase: "preparing", version: manifest.version });
      try {
        await copyOwned(this.archive, path.join(work, "update.zip"));
        const app = await extractVerifiedZip(
          path.join(work, "update.zip"),
          path.join(work, "stage"),
          manifest,
          signal,
        );
        await validateApp(app, manifest.version);
        await copyOwned(nodePath, path.join(work, "node"), 0o700);
        await copyOwned(helperPath, path.join(work, "helper.cjs"));
        await copyOwned(
          path.join(
            appPath,
            "Contents/Resources/runtime/native/prce-macos-acl",
          ),
          path.join(work, "prce-macos-acl"),
          0o700,
        );
        const identity = await processIdentity(process.pid);
        if (!identity || !ownedAppIdentity(identity, appPath))
          fail("PROCESS_IDENTITY");
        const plan: InstallPlan = {
          schemaVersion: 1,
          nonce,
          appPath,
          workDir: work,
          oldVersion: currentVersion,
          manifest,
          oldPid: process.pid,
          oldIdentity: identity,
          deadline: Date.now() + 180000,
          nodeHash: (await hashFile(path.join(work, "node"))).sha256,
          helperHash: (await hashFile(path.join(work, "helper.cjs"))).sha256,
        };
        await writePrivate(path.join(work, "plan.json"), plan);
        if (signal.aborted) fail("CANCELLED");
        if (this.options.isBusy()) fail("BUSY");
        const child = spawn(
          path.join(work, "node"),
          [path.join(work, "helper.cjs"), path.join(work, "plan.json")],
          {
            detached: true,
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            cwd: work,
            env: {
              PATH: "/usr/bin:/bin",
              LANG: "C",
              LC_ALL: "C",
              HOME: process.env.HOME || "",
            },
          },
        );
        spawned = true;
        await this.waitReady(child, nonce, signal);
        await this.clearDownload();
        if (signal.aborted || this.options.isBusy()) {
          await this.cancelHandoff();
          fail(signal.aborted ? "CANCELLED" : "BUSY");
        }
        this.handed = true;
        this.emit({ phase: "ready", version: manifest.version });
        return this.status;
      } catch (e) {
        if (spawned) await this.cancelHandoff();
        else {
          await ownedRemove(work);
          this.work = null;
        }
        throw e;
      }
    });
  }
  private waitReady(
    child: ChildProcess,
    nonce: string,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => done(new UpdateError("HELPER_TIMEOUT")),
        120000,
      );
      const abort = () => done(new UpdateError("CANCELLED"));
      const error = () => done(new UpdateError("HELPER_FAILED"));
      const message = (m: unknown) => {
        if (
          m &&
          typeof m === "object" &&
          (m as { type?: string }).type === "ready" &&
          (m as { nonce?: string }).nonce === nonce
        )
          done();
        else done(new UpdateError("HELPER_PROTOCOL"));
      };
      let finished = false;
      function done(e?: Error) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        child.off("message", message);
        child.off("exit", error);
        child.off("error", error);
        if (child.connected) child.disconnect();
        child.unref();
        e ? reject(e) : resolve();
      }
      child.on("message", message);
      child.once("error", error);
      child.once("exit", error);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  private async cancelHandoff() {
    if (this.work) {
      const file = path.join(this.work, "cancel.json");
      if (!(await lstat(file).catch(() => null)))
        await writePrivate(file, { cancel: true });
    }
  }
  async cancel(): Promise<void> {
    this.controller?.abort();
    if (this.work) await this.cancelHandoff();
    await this.pending?.catch(() => {});
    if (!this.handed) await this.clearDownload();
    this.emit({ phase: "cancelled" });
  }
  private async clearDownload() {
    this.archive = null;
    if (this.cacheJob) {
      const dir = this.cacheJob;
      this.cacheJob = null;
      await ownedRemove(dir);
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.handed) {
      this.controller?.abort();
      await this.pending?.catch(() => {});
      await this.clearDownload();
    }
  }
}
