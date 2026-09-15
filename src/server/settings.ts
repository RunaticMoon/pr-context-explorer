import {
  openSync,
  closeSync,
  readFileSync,
  lstatSync,
  fstatSync,
  constants,
} from "node:fs";
import path from "node:path";
/** Only callers in trusted server code choose this path, never request JSON. */
export function readServerSettings(
  file: string | undefined,
): Record<string, any> {
  if (!file) return {};
  if (!path.isAbsolute(file))
    throw Error("server settings require an explicit absolute path");
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw Error("server settings symlink denied");
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      (st.mode & 0o077) !== 0 ||
      st.uid !== process.getuid?.() ||
      st.size > 16384
    )
      throw Error(
        "server settings must be private (0600), owned, bounded JSON",
      );
    const value = JSON.parse(readFileSync(fd, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("server settings JSON object required");
    return value;
  } finally {
    closeSync(fd);
  }
}
