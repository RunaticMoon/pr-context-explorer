import { contextBridge, ipcRenderer } from "electron";
// Read-only, no arguments, no general-purpose IPC or credential/file/shell bridge.
contextBridge.exposeInMainWorld(
  "prceDesktop",
  Object.freeze({ status: () => ipcRenderer.invoke("prce:status") }),
);
