import { MacUpdater } from "electron-updater";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
import { CancellationToken } from "builder-util-runtime";
import type { RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import { updateRequest, REPOSITORY } from "./security.ts";
import { UpdateState } from "./update-state.ts";
class RestrictedExecutor extends ElectronHttpExecutor {
  constructor() {
    super(undefined);
  }
  createRequest(
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ): any {
    const raw = `${options.protocol || "https:"}//${options.hostname || options.host}${options.port ? ":" + options.port : ""}${options.path || "/"}`;
    const headers = updateRequest(
      raw,
      options.headers as Record<string, unknown>,
    );
    // Pin redirects to manual even for differential/provider calls. Every follow-up is revalidated here.
    return super.createRequest(
      { ...options, headers, redirect: "manual" } as any,
      callback as any,
    );
  }
}
/** Uses pinned official private GitHub provider. No environment/provider auto-discovery. */
export class SignedUpdater {
  readonly state: UpdateState;
  private updater?: MacUpdater;
  private cancellation?: CancellationToken;
  constructor(enabled: boolean, changed: () => void) {
    this.state = new UpdateState(enabled, changed);
  }
  configure(token: string) {
    if (!this.state.enabled) throw Error("Signed updates disabled");
    if (this.updater) {
      this.cancel();
      this.updater.removeAllListeners();
    }
    const updater = (this.updater = new MacUpdater({
      provider: "github",
      ...REPOSITORY,
      private: true,
      token,
      releaseType: "release",
    }));
    // Pinned electron-updater internal injection: official executor with mandatory destination/header policy.
    Object.assign(updater, { httpExecutor: new RestrictedExecutor() });
    updater.logger = null;
    updater.channel = "latest";
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.disableDifferentialDownload = true;
    updater.on("error", () => this.state.fail());
    updater.on("update-available", (info) =>
      this.state.available(info.version),
    );
    updater.on("update-not-available", () => this.state.current());
    updater.on("download-progress", (info) =>
      this.state.progress(info.percent),
    );
    updater.on("update-downloaded", () => this.state.downloaded());
  }
  async check(autoDownload: boolean) {
    if (!this.updater || !this.state.beginCheck()) return;
    try {
      await this.updater.checkForUpdates();
      if (autoDownload) await this.download();
    } catch {
      this.state.fail();
    }
  }
  async download() {
    if (!this.updater || !this.state.beginDownload()) return;
    this.cancellation = new CancellationToken();
    try {
      await this.updater.downloadUpdate(this.cancellation);
    } catch {
      if (!this.cancellation.cancelled) this.state.fail();
    }
  }
  cancel() {
    this.cancellation?.cancel();
    this.state.cancel();
  }
  install() {
    if (this.state.enabled && this.state.status.phase === "installing")
      this.updater?.quitAndInstall();
  }
  clear() {
    this.cancel();
    this.updater?.removeAllListeners();
    this.updater = undefined;
  }
}
/** Identity preview is separate from updater endpoints; rejects every redirect and keeps errors generic. */
export async function releaseIdentity(token: string): Promise<string> {
  async function get(endpoint: string) {
    const response = await fetch("https://api.github.com" + endpoint, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error("Release credential could not be verified");
    const text = await response.text();
    if (text.length > 131072) throw Error("Release identity response limit");
    return JSON.parse(text);
  }
  const user = await get("/user");
  const repo = await get("/repos/RunaticMoon/pr-context-explorer");
  if (
    typeof user.login !== "string" ||
    !/^[a-zA-Z0-9-]{1,39}$/.test(user.login) ||
    repo.full_name !== "RunaticMoon/pr-context-explorer" ||
    repo.private !== true
  )
    throw Error("Release identity mismatch");
  return user.login;
}
