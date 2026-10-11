import { contextBridge, ipcRenderer } from "electron";
// Finite app-update capability only; no general IPC, filesystem, shell or URLs.
contextBridge.exposeInMainWorld(
  "prceDesktop",
  Object.freeze({
    status: () => ipcRenderer.invoke("prce:status"),
    onOpenUpdates: (listener: () => void) => {
      if (typeof listener !== "function")
        throw new TypeError("Listener required");
      // Never forward Electron's event object or arbitrary message payloads.
      const open = () => listener();
      ipcRenderer.on("prce:open-updates", open);
      return () => ipcRenderer.removeListener("prce:open-updates", open);
    },
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
