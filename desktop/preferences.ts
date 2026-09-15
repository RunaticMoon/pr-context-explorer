import {
  openSync,
  constants,
  fstatSync,
  readFileSync,
  closeSync,
  lstatSync,
  writeFileSync,
  renameSync,
  rmSync,
  existsSync,
} from "node:fs";
import path from "node:path";
export interface Preferences {
  autoCheck: boolean;
  autoDownload: boolean;
}
export const defaultPreferences: Preferences = {
  autoCheck: true,
  autoDownload: false,
};
export function validatePreferences(value: unknown): Preferences {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid preferences");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((k) => !["autoCheck", "autoDownload"].includes(k)) ||
    typeof v.autoCheck !== "boolean" ||
    typeof v.autoDownload !== "boolean"
  )
    throw Error("Invalid preferences");
  return { autoCheck: v.autoCheck, autoDownload: v.autoDownload };
}
export function privateRead(file: string, limit = 16384): Buffer {
  if (!path.isAbsolute(file) || file.length > 4096)
    throw Error("Private file path denied");
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw Error("Private file symlink denied");
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.uid !== process.getuid?.() ||
      (st.mode & 0o077) !== 0 ||
      st.size > limit
    )
      throw Error("Private file must be owned, mode 0600 and bounded");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function privateWrite(file: string, data: Buffer | string) {
  const temp = file + "." + process.pid + ".tmp";
  try {
    writeFileSync(temp, data, { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}
export function validateCredential(value: string): string {
  const token = value.trim();
  if (!/^github_pat_[A-Za-z0-9_]{40,240}$/.test(token))
    throw Error("Use a fine-grained read-only GitHub release token");
  return token;
}
export function readSelectedCredential(file: string): string {
  return validateCredential(privateRead(file, 512).toString("utf8"));
}
export interface Encryption {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}
export class CredentialVault {
  constructor(
    private file: string,
    private encryption: Encryption,
  ) {}
  private requireEncryption() {
    if (!this.encryption.isEncryptionAvailable())
      throw Error("OS encrypted credential storage unavailable");
  }
  load(): string | undefined {
    this.requireEncryption();
    return existsSync(this.file)
      ? validateCredential(
          this.encryption.decryptString(privateRead(this.file, 4096)),
        )
      : undefined;
  }
  save(token: string) {
    this.requireEncryption();
    privateWrite(
      this.file,
      this.encryption.encryptString(validateCredential(token)),
    );
  }
  clear() {
    rmSync(this.file, { force: true });
  }
}
export function loadPreferences(file: string): Preferences {
  try {
    return validatePreferences(JSON.parse(privateRead(file).toString()));
  } catch {
    return { ...defaultPreferences };
  }
}
