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
import { mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { BackendProcess } from "./lifecycle.ts";
import { validStatusSender, signatureAllowed } from "./security.ts";
import {
  CredentialVault,
  loadPreferences,
  privateWrite,
  readSelectedCredential,
  validatePreferences,
} from "./preferences.ts";
import { SignedUpdater, releaseIdentity } from "./signed-updater.ts";
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
    "This personal unsigned/ad-hoc app uses the separate authenticated prce update manager. It checks private GitHub releases using your own gh login, verifies asset checksums and replaces the app only while it is stopped.\n\nInstall/update destination: ~/Applications/PR Context Explorer.app. Run prce --help in Terminal; see docs/MACOS-RELEASE.md. An optional user LaunchAgent can check periodically. This app does not execute Terminal commands or receive the manager’s credentials.\n\nUse Quit for External Update when ready. No Gatekeeper or quarantine bypass is performed.",
  );
}
function buildMenu() {
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
            label: "Preferences and Update Status…",
            click: nativeAction(async () =>
              message(
                "Desktop Preferences",
                `Version ${app.getVersion()} • stable arm64\nUpdate mode: ${updates.state.enabled ? "signed in-app (optional)" : "external authenticated manager"}\nStatus: ${phase?.phase}${phase?.percent === undefined ? "" : ` ${phase.percent}%`}\n${phase?.message || ""}\n\nApp data: ${data}\nAI config: ${path.join(data, "ai-config.json")}\nSettings are native-menu-only; source cannot invoke update/install actions.`,
              ),
            ),
          },
          {
            label: "External Update Manager…",
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
                  const installed = await updates.state.install(
                    () => backend!.active(),
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
                      window?.destroy();
                      void backend?.stop().then(() => {
                        rmSync(marker, { force: true });
                        updates.install();
                      });
                    },
                  );
                  if (!installed)
                    await message(
                      "Update deferred",
                      "Finish or cancel active work before restarting.",
                    );
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
    },
    () => {
      if (!quitting) {
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
      preferences: { ...preferences },
    };
  });
  smokeStage("window-load");
  await window.loadURL(origin + "/");
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
  });
  // OS termination is not a renderer command. Cancel jobs before closing the IPC sidecar.
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      if (quitting) return;
      quitting = true;
      window?.hide();
      for (const timer of timers) clearTimeout(timer);
      updates?.cancel();
      void Promise.resolve(backend?.stop()).then(() => {
        rmSync(marker, { force: true });
        app.quit();
      });
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
      await backend?.stop();
      rmSync(marker, { force: true });
      app.quit();
    });
}
