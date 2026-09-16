import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  session,
  safeStorage,
} from "electron";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { BackendProcess } from "./lifecycle.ts";
import {
  validStatusSender,
  validUpdateCommand,
  type UpdateCommand,
  signatureAllowed,
} from "./security.ts";
import {
  CredentialVault,
  loadPreferences,
  privateWrite,
  readSelectedCredential,
  validatePreferences,
} from "./preferences.ts";
import { SignedUpdater, releaseIdentity } from "./signed-updater.ts";
import {
  PublicUpdater,
  registerStartup,
  acknowledgeStartup,
} from "./public-update/index.ts";
import { installPublicUpdate } from "./public-update-host.ts";
declare const __PRCE_PUBLIC_UPDATES__: boolean;
declare const __PRCE_SIGNED_BUILD__: boolean;
declare const __PRCE_TEAM_ID__: string;
process.umask(0o077);
app.setName("PR Context Explorer");
app.setPath(
  "userData",
  path.join(app.getPath("appData"), "PR Context Explorer"),
);
// User-data override is allowed ONLY for nonpackaged test launches, never from source or renderer.
if (!app.isPackaged && process.env.PRCE_DESKTOP_TEST_DATA)
  app.setPath("userData", process.env.PRCE_DESKTOP_TEST_DATA);
app.enableSandbox();
let window: BrowserWindow | undefined,
  backend: BackendProcess | undefined,
  origin = "",
  quitting = false,
  quitPending = false,
  nativeBusy = false;
let updates: SignedUpdater;
let publicUpdates: PublicUpdater | undefined;
let admissionHeld = false,
  startupCommitted = false,
  runtimeFailed = false,
  publicOperation = false;
let lastChecked: string | undefined, publicError: string | undefined;
let publicTimer: ReturnType<typeof setTimeout> | undefined;
function publicStatus() {
  return {
    enabled: !!publicUpdates && startupCommitted,
    channel: __PRCE_SIGNED_BUILD__ ? "signed-private" : "public-personal",
    reason: publicUpdates
      ? undefined
      : "설치된 macOS Apple Silicon 개인용 앱에서만 사용할 수 있습니다. 개발/브라우저 모드는 네트워크 업데이트를 실행하지 않습니다.",
    ...(publicUpdates?.status || { phase: "unavailable" }),
    lastChecked,
    errorCode: publicError || publicUpdates?.status.errorCode,
  };
}
async function publicCommand(command: UpdateCommand) {
  if (!publicUpdates || !startupCommitted || quitting || quitPending)
    throw Error("Update unavailable");
  if (command.action === "cancel") {
    if (publicUpdates.status.phase === "ready") return;
    try {
      await publicUpdates.cancel();
    } catch {
      publicError = "UPDATE_FAILED";
    }
    return;
  }
  if (publicOperation) return;
  publicOperation = true;
  publicError = undefined;
  try {
    if (command.action === "preferences") {
      const next = validatePreferences({
        autoCheck: command.autoCheck,
        autoDownload: command.autoDownload,
      });
      privateWrite(preferencesFile, JSON.stringify(next));
      preferences = next;
    } else if (command.action === "check") {
      await publicUpdates.check();
      lastChecked = new Date().toISOString();
      if (
        preferences.autoDownload &&
        publicUpdates.status.phase === "available"
      )
        await publicUpdates.download();
    } else if (command.action === "download") await publicUpdates.download();
    else if (command.action === "install") {
      if (publicUpdates.status.phase !== "downloaded")
        throw Error("NOT_DOWNLOADED");
      const result = await installPublicUpdate({
        version: () => publicUpdates!.status.version,
        confirm: async (version) =>
          (
            await dialog.showMessageBox({
              type: "question",
              message: `버전 ${version} 설치 후 재시작할까요?`,
              detail:
                "공개 개인용(ad-hoc) 배포입니다. Apple Developer ID 인증/공증을 제공하지 않습니다. 앱과 포함된 Node/런타임만 교체하며 분석 데이터와 설정은 보존합니다. 진행 중인 분석은 취소하지 않습니다.",
              buttons: ["나중에", "설치 및 재시작"],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            })
          ).response === 1,
        lock: async () => {
          admissionHeld = await backend!.admission(true);
          return admissionHeld;
        },
        unlock: async () => {
          await backend!.admission(false);
          admissionHeld = false;
        },
        prepare: () => publicUpdates!.prepareInstall(),
        quit: async () => {
          quitting = true;
          clearTimeout(publicTimer);
          for (const timer of timers) clearTimeout(timer);
          window?.hide();
          await publicUpdates!.close();
          await backend!.stop();
          rmSync(marker, { force: true });
          app.quit();
        },
      });
      if (result === "BUSY") publicError = "BUSY";
    }
  } catch {
    publicError = publicUpdates.status.errorCode || "UPDATE_FAILED";
  } finally {
    publicOperation = false;
    buildMenu();
  }
}
function schedulePublicChecks() {
  const tick = async () => {
    if (quitting || !startupCommitted || !publicUpdates) return;
    if (
      preferences.autoCheck &&
      !["downloaded", "preparing", "ready", "downloading"].includes(
        publicUpdates.status.phase,
      )
    )
      await publicCommand({ action: "check" }).catch(() => {});
    if (!quitting && startupCommitted)
      publicTimer = setTimeout(tick, 6 * 60 * 60 * 1000);
  };
  publicTimer = setTimeout(tick, 30000);
}
let timers: ReturnType<typeof setTimeout>[] = [];
const data = app.getPath("userData"),
  marker = path.join(data, "desktop-runtime.json"),
  preferencesFile = path.join(data, "preferences.json");
let preferences = loadPreferences(preferencesFile);
const vault = new CredentialVault(
  path.join(data, "release-credential.enc"),
  safeStorage,
);
function smokeStage(stage: string) {
  if (!app.isPackaged && process.env.PRCE_DESKTOP_TEST_DATA)
    console.error(`[prce-smoke] ${stage}`);
}
async function message(title: string, detail: string) {
  if (title === "Unable to Start") smokeStage("startup-error-dialog");
  if (title === "Local Backend Stopped") smokeStage("backend-stopped-dialog");
  return dialog.showMessageBox({
    type: "info",
    title,
    message: title,
    detail,
    buttons: ["OK"],
    noLink: true,
  });
}
function nativeAction(action: () => Promise<unknown>) {
  return () => {
    if (nativeBusy || quitting) return;
    nativeBusy = true;
    void action()
      .catch(() =>
        message(
          "Action unavailable",
          "Check local dependencies, release access and OS credential storage. No credential or server response is logged.",
        ),
      )
      .finally(() => {
        nativeBusy = false;
      });
  };
}
async function confirmQuit() {
  if (quitting || quitPending) return;
  // A handoff/consent transaction owns admission. Network work can be cancelled
  // by ordinary quit; never interrupt an install by cancelling user analyses.
  if (
    publicOperation &&
    ["downloaded", "preparing", "ready"].includes(
      publicUpdates?.status.phase || "",
    )
  )
    return;
  quitPending = true;
  try {
    const active = await backend?.active();
    if (active) {
      smokeStage("active-work-confirmation");
      const answer = await dialog.showMessageBox({
        type: "warning",
        message: "Cancel active work and quit?",
        detail:
          "Collection or analysis is active (or its state is unavailable). Cancellation stops child processes; saved data is preserved.",
        buttons: ["Keep Working", "Cancel Work and Quit"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1) return;
    }
    quitting = true;
    window?.hide();
    for (const timer of timers) clearTimeout(timer);
    updates?.cancel();
    clearTimeout(publicTimer);
    await publicUpdates?.close().catch(() => {});
    smokeStage("normal-quit-backend-stop");
    await backend?.stop();
    smokeStage("normal-quit-backend-stopped");
    rmSync(marker, { force: true });
    app.quit();
  } finally {
    quitPending = false;
  }
}
async function externalUpdateInfo() {
  await message(
    "External Update Manager",
    "Legacy fallback only: anonymous public in-app updates are available in Settings → 업데이트. The separate authenticated prce manager is intended for maintainers. It is not required for public app updates. It checks private GitHub releases using your own gh login, verifies asset checksums and replaces the app only while it is stopped.\n\nInstall/update destination: ~/Applications/PR Context Explorer.app. Run prce --help in Terminal; see docs/MACOS-RELEASE.md. An optional user LaunchAgent can check periodically. This app does not execute Terminal commands or receive the manager’s credentials.\n\nUse Quit for External Update when ready. No Gatekeeper or quarantine bypass is performed.",
  );
}
function buildMenu() {
  const invokePublic = (command: UpdateCommand) => {
    void publicCommand(command).catch(() => {});
  };
  const phase = updates?.state.status;
  const save = (key: "autoCheck" | "autoDownload", checked: boolean) => {
    preferences = validatePreferences({ ...preferences, [key]: checked });
    privateWrite(preferencesFile, JSON.stringify(preferences));
    buildMenu();
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          {
            label: "공개 앱 업데이트",
            enabled: !!publicUpdates && startupCommitted,
            submenu: [
              {
                label: `설치 버전 ${app.getVersion()} · ${publicUpdates?.status.phase || "unavailable"}`,
                enabled: false,
              },
              {
                label: "업데이트 확인",
                click: () => {
                  invokePublic({ action: "check" });
                },
              },
              {
                label: "다운로드",
                enabled: publicUpdates?.status.phase === "available",
                click: () => {
                  invokePublic({ action: "download" });
                },
              },
              {
                label: "취소",
                enabled: ["checking", "downloading", "preparing"].includes(
                  publicUpdates?.status.phase || "",
                ),
                click: () => {
                  invokePublic({ action: "cancel" });
                },
              },
              {
                label: "설치 및 재시작…",
                enabled: publicUpdates?.status.phase === "downloaded",
                click: () => {
                  invokePublic({ action: "install" });
                },
              },
              {
                label: "자동 확인 (6시간)",
                type: "checkbox",
                checked: preferences.autoCheck,
                click: (item) => {
                  invokePublic({
                    action: "preferences",
                    ...preferences,
                    autoCheck: item.checked,
                  });
                },
              },
              {
                label: "자동 다운로드 (선택)",
                type: "checkbox",
                checked: preferences.autoDownload,
                click: (item) => {
                  invokePublic({
                    action: "preferences",
                    ...preferences,
                    autoDownload: item.checked,
                  });
                },
              },
            ],
          },
          {
            label: "Preferences and Update Status…",
            click: nativeAction(async () =>
              message(
                "Desktop Preferences",
                `Version ${app.getVersion()} • stable arm64\nUpdate mode: ${updates.state.enabled ? "signed in-app (optional)" : "anonymous public personal updates"}\nStatus: ${phase?.phase}${phase?.percent === undefined ? "" : ` ${phase.percent}%`}\n${phase?.message || ""}\n\nApp data: ${data}\nAI config: ${path.join(data, "ai-config.json")}\nPublic update controls are in Settings → 업데이트. Installation requires native confirmation; renderer cannot supply paths or URLs.`,
              ),
            ),
          },
          {
            label: "Legacy External Update Manager…",
            click: nativeAction(externalUpdateInfo),
          },
          {
            label: "Quit for External Update…",
            click: nativeAction(async () => {
              const answer = await dialog.showMessageBox({
                message: "Quit for the external update manager?",
                detail:
                  "The manager will update only while the app is stopped. Saved analysis and preferences stay in Application Support.",
                buttons: ["Cancel", "Quit"],
                defaultId: 0,
                cancelId: 0,
              });
              if (answer.response === 1) await confirmQuit();
            }),
          },
          { type: "separator" },
          {
            label: "Signed In-App Updates (optional)",
            enabled: updates?.state.enabled,
            submenu: [
              {
                label: "Select Read-Only Release Credential…",
                click: nativeAction(async () => {
                  if (
                    !updates.state.enabled ||
                    !safeStorage.isEncryptionAvailable()
                  )
                    throw Error("Encrypted credential storage unavailable");
                  const selected = await dialog.showOpenDialog({
                    title:
                      "Choose private (0600) fine-grained GitHub token file: Contents read-only, RunaticMoon/pr-context-explorer only",
                    properties: ["openFile"],
                    buttonLabel: "Verify Identity",
                  });
                  if (selected.canceled || selected.filePaths.length !== 1)
                    return;
                  const token = readSelectedCredential(selected.filePaths[0]);
                  const identity = await releaseIdentity(token);
                  const answer = await dialog.showMessageBox({
                    message: `Use release access as ${identity}?`,
                    detail:
                      "Repository: private RunaticMoon/pr-context-explorer. Grant only Contents: read-only. The token stays in main-only OS encrypted storage, never the renderer, backend or project config.",
                    buttons: ["Cancel", "Save Encrypted Credential"],
                    defaultId: 0,
                    cancelId: 0,
                  });
                  if (answer.response === 1) {
                    vault.save(token);
                    updates.configure(token);
                  }
                }),
              },
              {
                label: "Forget Release Credential",
                click: nativeAction(async () => {
                  updates.clear();
                  vault.clear();
                }),
              },
              {
                label: "Automatically Check (every 6 hours)",
                type: "checkbox",
                checked: preferences.autoCheck,
                click: (item) => save("autoCheck", item.checked),
              },
              {
                label: "Automatically Download",
                type: "checkbox",
                checked: preferences.autoDownload,
                click: (item) => save("autoDownload", item.checked),
              },
              {
                label: "Check Now",
                click: nativeAction(() =>
                  updates.check(preferences.autoDownload),
                ),
              },
              {
                label: "Download Update",
                enabled: phase?.phase === "available",
                click: nativeAction(() => updates.download()),
              },
              {
                label: "Cancel Download",
                enabled: phase?.phase === "downloading",
                click: () => updates.cancel(),
              },
              {
                label: "Restart and Apply…",
                enabled: phase?.phase === "ready",
                click: nativeAction(async () => {
                  let installed = false;
                  try {
                    installed = await updates.state.install(
                      async () => !(await backend!.admission(true)),
                      async () => {
                        const answer = await dialog.showMessageBox({
                          type: "question",
                          message:
                            "Restart to apply the downloaded signed update?",
                          detail:
                            "Saved data is preserved. Installation is refused while collection or analysis is active.",
                          buttons: ["Later", "Restart and Apply"],
                          defaultId: 0,
                          cancelId: 0,
                        });
                        return answer.response === 1;
                      },
                      () => {
                        quitting = true;
                        for (const timer of timers) clearTimeout(timer);
                        window?.destroy();
                        void backend?.stop().then(() => {
                          rmSync(marker, { force: true });
                          updates.install();
                        });
                      },
                    );
                  } finally {
                    if (!installed) await backend!.admission(false);
                  }
                  if (!installed) {
                    await message(
                      "Update deferred",
                      "Finish or cancel active work before restarting.",
                    );
                  }
                }),
              },
            ],
          },
          {
            label: "Dependency Diagnostics…",
            click: nativeAction(async () => {
              const results = [];
              for (const [name, args] of [
                ["/opt/homebrew/bin/git", ["--version"]],
                ["/usr/local/bin/git", ["--version"]],
                ["/usr/bin/git", ["--version"]],
                ["/opt/homebrew/bin/gh", ["--version"]],
                ["/usr/local/bin/gh", ["--version"]],
              ] as const) {
                try {
                  execFileSync(name, [...args], {
                    timeout: 5000,
                    maxBuffer: 16384,
                    env: {
                      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
                      HOME: path.join(data, "home"),
                    },
                    stdio: "pipe",
                  });
                  results.push(name + ": available");
                } catch {
                  results.push(name + ": unavailable");
                }
              }
              await message(
                "Dependency Diagnostics",
                results.join("\n") +
                  "\n\nGit is required (Apple Command Line Tools or Homebrew). Optional native Codex/Claude CLIs are detected by the isolated AI adapter, including /opt/homebrew locations. See docs/MACOS-ISOLATION.md. No login shell, target code or package install is run.",
              );
            }),
          },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}
function signatureValid() {
  if (
    !__PRCE_SIGNED_BUILD__ ||
    !app.isPackaged ||
    process.platform !== "darwin"
  )
    return false;
  try {
    const bundle = path.resolve(process.execPath, "../../..");
    execFileSync(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", bundle],
      { timeout: 15000, stdio: "pipe" },
    );
    // codesign diagnostic metadata is deliberately emitted on stderr.
    const result = spawnSync(
      "/usr/bin/codesign",
      ["-d", "--verbose=4", bundle],
      {
        timeout: 15000,
        encoding: "utf8",
        maxBuffer: 32768,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return signatureAllowed(
      __PRCE_SIGNED_BUILD__,
      app.isPackaged,
      process.platform,
      __PRCE_TEAM_ID__,
      result.stderr || "",
      result.status === 0,
    );
  } catch {
    return false;
  }
}
async function launch() {
  smokeStage("app-ready");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const bundlePath = app.isPackaged
    ? realpathSync(path.resolve(process.execPath, "../../.."))
    : app.getAppPath();
  const updateBoot =
    app.isPackaged && (await registerStartup(bundlePath, app.getVersion()));
  const base = app.isPackaged
    ? process.resourcesPath
    : path.resolve(__dirname, "..");
  const runtime = path.join(base, "runtime"),
    node = path.join(base, "node/bin/node");
  if (!existsSync(node)) throw Error("Bundled Node sidecar missing");
  updates = new SignedUpdater(signatureValid(), () => buildMenu());
  buildMenu();
  privateWrite(
    marker,
    JSON.stringify({
      pid: process.pid,
      executable: process.execPath,
      appPath: app.isPackaged
        ? path.resolve(process.execPath, "../../..")
        : app.getAppPath(),
      version: app.getVersion(),
      startedAt: new Date().toISOString(),
    }),
  );
  backend = new BackendProcess(
    {
      node,
      entry: path.join(runtime, "desktop/backend.js"),
      runtime,
      data,
      dist: path.join(runtime, "dist"),
      admissionClosed: true,
    },
    () => {
      if (!quitting) {
        admissionHeld = false;
        startupCommitted = false;
        runtimeFailed = true;
        publicError = "BACKEND_UNAVAILABLE";
        clearTimeout(publicTimer);
        void publicUpdates?.close().catch(() => {});
        void message(
          "Local Backend Stopped",
          "No work will run until the app is restarted. Check Git and dependency diagnostics.",
        );
        window?.hide();
      }
    },
  );
  smokeStage("backend-start");
  const starting = backend.start();
  // Record the owned sidecar before readiness, including startup-failure cases.
  privateWrite(
    marker,
    JSON.stringify({
      pid: process.pid,
      backendPid: backend.pid,
      executable: process.execPath,
      appPath: app.isPackaged
        ? path.resolve(process.execPath, "../../..")
        : app.getAppPath(),
      version: app.getVersion(),
      startedAt: new Date().toISOString(),
    }),
  );
  origin = await starting;
  smokeStage("backend-ready");
  privateWrite(
    marker,
    JSON.stringify({
      pid: process.pid,
      backendPid: backend.pid,
      executable: process.execPath,
      appPath: app.isPackaged
        ? path.resolve(process.execPath, "../../..")
        : app.getAppPath(),
      version: app.getVersion(),
      startedAt: new Date().toISOString(),
    }),
  );
  const isolated = session.fromPartition("prce-desktop");
  isolated.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  isolated.setPermissionCheckHandler(() => false);
  isolated.on("will-download", (event) => event.preventDefault());
  isolated.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: quitting || !details.url.startsWith(origin + "/") });
  });
  isolated.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    if (details.url.startsWith(origin + "/"))
      headers["X-PRCE-Desktop"] = backend!.key;
    callback({ requestHeaders: headers });
  });
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#111827",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      session: isolated,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== origin + "/") event.preventDefault();
  });
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      app.quit();
    }
  });
  window.webContents.on("render-process-gone", () => {
    runtimeFailed = true;
    startupCommitted = false;
    clearTimeout(publicTimer);
    void publicUpdates?.close().catch(() => {});
    if (!quitting)
      void message(
        "Renderer Stopped",
        "Restart the app to recover. Saved data is preserved.",
      );
  });
  ipcMain.handle("prce:status", (event, ...args) => {
    if (!window || !validStatusSender(event, window.webContents, origin, args))
      throw Error("IPC denied");
    return {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      updates: { ...updates.state.status },
      publicUpdates: publicStatus(),
      preferences: { ...preferences },
    };
  });
  ipcMain.handle("prce:update", async (event, ...args) => {
    if (
      !window ||
      !validStatusSender(event, window.webContents, origin, []) ||
      args.length !== 1 ||
      !validUpdateCommand(args[0])
    )
      throw Error("IPC denied");
    await publicCommand(args[0]);
    return {
      version: app.getVersion(),
      publicUpdates: publicStatus(),
      preferences: { ...preferences },
    };
  });
  smokeStage("window-load");
  await window.loadURL(origin + "/");
  // loadURL completion is renderer readiness; no user work before helper commit.
  if (
    runtimeFailed ||
    window.isDestroyed() ||
    window.webContents.isDestroyed() ||
    (await backend.active())
  )
    throw Error("Runtime readiness unavailable");
  if (updateBoot) await acknowledgeStartup(bundlePath, app.getVersion());
  if (runtimeFailed) throw Error("Runtime stopped before admission");
  if (!(await backend.admission(false)))
    throw Error("Backend admission unavailable");
  startupCommitted = true;
  if (
    __PRCE_PUBLIC_UPDATES__ &&
    !__PRCE_SIGNED_BUILD__ &&
    app.isPackaged &&
    process.platform === "darwin" &&
    process.arch === "arm64"
  ) {
    publicUpdates = new PublicUpdater({
      currentVersion: app.getVersion(),
      appPath: bundlePath,
      dataDir: realpathSync(data),
      nodePath: path.join(bundlePath, "Contents/Resources/node/bin/node"),
      helperPath: path.join(
        bundlePath,
        "Contents/Resources/public-update-helper.cjs",
      ),
      isBusy: () => !admissionHeld || !startupCommitted || quitting,
      onStatus: () => buildMenu(),
    });
    buildMenu();
    schedulePublicChecks();
  }
  window.show();
  smokeStage("window-shown");
  if (updates.state.enabled) {
    try {
      const token = vault.load();
      if (token) updates.configure(token);
    } catch {
      /* OS locked/unavailable: require explicit native credential selection */
    }
    const schedule = () => {
      timers.push(
        setTimeout(
          () => {
            if (preferences.autoCheck)
              void updates.check(preferences.autoDownload);
            schedule();
          },
          6 * 60 * 60 * 1000,
        ),
      );
    };
    timers.push(
      setTimeout(() => {
        if (preferences.autoCheck) void updates.check(preferences.autoDownload);
      }, 30000),
    );
    schedule();
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app.on("activate", () => {
    window?.show();
    window?.focus();
  });
  app.on("before-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      void confirmQuit();
    }
  });
  app.on("will-quit", () => {
    ipcMain.removeHandler("prce:status");
    ipcMain.removeHandler("prce:update");
    clearTimeout(publicTimer);
  });
  // OS termination is not a renderer command. Cancel jobs before closing the IPC sidecar.
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      if (quitting) return;
      quitting = true;
      window?.hide();
      for (const timer of timers) clearTimeout(timer);
      updates?.cancel();
      clearTimeout(publicTimer);
      void (async () => {
        await publicUpdates?.close().catch(() => {});
        await backend?.stop();
        rmSync(marker, { force: true });
        app.quit();
      })();
    });
  void app
    .whenReady()
    .then(launch)
    .catch(async () => {
      await message(
        "Unable to Start",
        "Bundled resources or Git are unavailable. Install Apple Command Line Tools or Git using Homebrew, then relaunch. No source code was executed.",
      );
      quitting = true;
      clearTimeout(publicTimer);
      await publicUpdates?.close().catch(() => {});
      await backend?.stop();
      rmSync(marker, { force: true });
      app.quit();
    });
}
