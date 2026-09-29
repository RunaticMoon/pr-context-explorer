import * as nodeFs from "node:fs";
// Electron's main process patches node:fs so *.asar paths are virtual
// directories. Update validation must read and write app.asar as a plain
// file, so use Electron's unpatched original-fs there. Plain Node (the
// install helper and tests) has no such builtin and keeps node:fs.
const fs: typeof nodeFs =
  (process.getBuiltinModule?.("original-fs") as typeof nodeFs | undefined) ??
  nodeFs;
export const constants = fs.constants;
export const {
  lstat,
  link,
  unlink,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
} = fs.promises;
export type { FileHandle } from "node:fs/promises";
