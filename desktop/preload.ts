import { contextBridge, ipcRenderer } from "electron";
// Finite app-update capability only; no general IPC, filesystem, shell or URLs.
contextBridge.exposeInMainWorld(
  "prceDesktop",
  Object.freeze({
    status: () => ipcRenderer.invoke("prce:status"),
    checkUpdate: () => ipcRenderer.invoke("prce:update", { action: "check" }),
    downloadUpdate: () =>
      ipcRenderer.invoke("prce:update", { action: "download" }),
    cancelUpdate: () => ipcRenderer.invoke("prce:update", { action: "cancel" }),
    installUpdate: () =>
      ipcRenderer.invoke("prce:update", { action: "install" }),
    updatePreferences: (autoCheck: boolean, autoDownload: boolean) =>
      ipcRenderer.invoke("prce:update", {
        action: "preferences",
        autoCheck,
        autoDownload,
      }),
  }),
);
