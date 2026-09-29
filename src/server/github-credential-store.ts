import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export type CredentialBackend = "keychain" | "file" | "off";

export interface GitHubCredentialStore {
  readonly backend: CredentialBackend;
  load(connectionId: string): Promise<string | null>;
  save(connectionId: string, token: string): Promise<boolean>;
  delete(connectionId: string): Promise<void>;
}

export type SecurityRunner = (
  args: string[],
  stdin?: string,
) => Promise<{ code: number; stdout: string }>;

/** macOS keychain service name shared by every stored GitHub PAT. */
const SERVICE = "PR Context Explorer GitHub PAT";
const FILE_NAME = "github-credentials.json";
const ENV_NAME = "PRCE_GITHUB_CREDENTIAL_STORE";
const MAX_FILE_BYTES = 64 * 1024;
const CONNECTION_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const TOKEN_CHARS = /[\s\x00-\x1f\x7f]/;
const TEMP_PREFIX = ".github-credentials.";
const TEMP_SUFFIX = ".tmp";
const DELETE_FAILED = "credential delete failed";

function validConnectionId(value: unknown): value is string {
  return typeof value === "string" && CONNECTION_ID.test(value);
}

function validToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 8192 &&
    !TOKEN_CHARS.test(value)
  );
}

/** Runs the macOS `security` binary without a shell; never echoes stdin. */
const defaultSecurityRunner: SecurityRunner = (args, stdin) =>
  new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {};
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.HOME) env.HOME = process.env.HOME;
    const child = execFile(
      "/usr/bin/security",
      args,
      { timeout: 10000, env },
      (error, stdout) => {
        const raw = error ? (error as NodeJS.ErrnoException).code : 0;
        const code = typeof raw === "number" ? raw : error ? 1 : 0;
        resolve({ code, stdout: stdout ? stdout.toString() : "" });
      },
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
  });

class OffCredentialStore implements GitHubCredentialStore {
  readonly backend: CredentialBackend = "off";
  async load(): Promise<string | null> {
    return null;
  }
  async save(): Promise<boolean> {
    return false;
  }
  async delete(): Promise<void> {}
}

class KeychainCredentialStore implements GitHubCredentialStore {
  readonly backend: CredentialBackend = "keychain";
  constructor(private readonly run: SecurityRunner) {}

  async load(connectionId: string): Promise<string | null> {
    if (!validConnectionId(connectionId)) return null;
    try {
      const { code, stdout } = await this.run([
        "find-generic-password",
        "-s",
        SERVICE,
        "-a",
        connectionId,
        "-w",
      ]);
      if (code !== 0) return null;
      const token = stdout.trim();
      return validToken(token) ? token : null;
    } catch {
      return null;
    }
  }

  async save(connectionId: string, token: string): Promise<boolean> {
    if (!validConnectionId(connectionId)) return false;
    if (!validToken(token)) return false;
    // The token reaches `security -i` through stdin only, so it never appears
    // in argv (visible via ps). Quotes/backslashes would break the command.
    if (/["'\\]/.test(token)) return false;
    try {
      const { code } = await this.run(
        ["-i"],
        `add-generic-password -U -s "${SERVICE}" -a "${connectionId}" -w "${token}"\n`,
      );
      return code === 0;
    } catch {
      return false;
    }
  }

  async delete(connectionId: string): Promise<void> {
    if (!validConnectionId(connectionId)) return;
    let code: number;
    try {
      ({ code } = await this.run([
        "delete-generic-password",
        "-s",
        SERVICE,
        "-a",
        connectionId,
      ]));
    } catch {
      throw Error(DELETE_FAILED);
    }
    // 0 = deleted, 44 = entry did not exist (already absent).
    if (code !== 0 && code !== 44) throw Error(DELETE_FAILED);
  }
}

class FileCredentialStore implements GitHubCredentialStore {
  readonly backend: CredentialBackend = "file";
  private readonly file: string;
  constructor(private readonly dataDir: string) {
    this.file = path.join(dataDir, FILE_NAME);
  }

  /**
   * Removes leftover atomic-write temp files that could still hold a plaintext
   * PAT. Symlinks are unlinked but never followed; only regular files owned by
   * the current user are removed. Best effort: failures are ignored.
   */
  private cleanupStaleTemps(): void {
    let names: string[];
    try {
      names = readdirSync(this.dataDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith(TEMP_PREFIX) || !name.endsWith(TEMP_SUFFIX))
        continue;
      const candidate = path.join(this.dataDir, name);
      try {
        const info = lstatSync(candidate);
        if (info.isSymbolicLink()) {
          unlinkSync(candidate);
          continue;
        }
        if (!info.isFile()) continue;
        if (
          typeof process.getuid === "function" &&
          info.uid !== process.getuid()
        )
          continue;
        unlinkSync(candidate);
      } catch {
        // Ignore anything we cannot inspect or remove.
      }
    }
  }

  /**
   * Reads the credential file with an O_NOFOLLOW open plus fstat, so a symlink
   * swapped in between checks cannot be followed. Returns a discriminated state
   * so callers can tell "nothing stored" (missing), "stored but untrusted"
   * (untrusted), and "could not read" (error) apart.
   */
  private readState():
    | { kind: "missing" }
    | { kind: "untrusted" }
    | { kind: "error" }
    | { kind: "trusted"; tokens: Record<string, string> } {
    let fd: number;
    try {
      // O_NONBLOCK keeps a FIFO/device from blocking the open forever; a
      // regular file ignores it. Platforms without it fall back to 0.
      fd = openSync(
        this.file,
        constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Nothing stored.
      if (code === "ENOENT") return { kind: "missing" };
      // O_NOFOLLOW refused a symlink: untrusted, but we know it is not ours.
      if (code === "ELOOP") return { kind: "untrusted" };
      // Any other open failure (EACCES, EMFILE, EISDIR, ENOTDIR, EIO, ...) is
      // treated as an error so callers never overwrite data they cannot read.
      return { kind: "error" };
    }
    try {
      let info;
      try {
        info = fstatSync(fd);
      } catch {
        return { kind: "error" };
      }
      // Reject anything that is not a private regular file owned by us.
      if (!info.isFile()) return { kind: "untrusted" };
      if (typeof process.getuid === "function" && info.uid !== process.getuid())
        return { kind: "untrusted" };
      if ((info.mode & 0o077) !== 0) return { kind: "untrusted" };
      if (info.size > MAX_FILE_BYTES) return { kind: "untrusted" };
      let text: string;
      try {
        text = readFileSync(fd, "utf8");
      } catch {
        return { kind: "error" };
      }
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { kind: "untrusted" };
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return { kind: "untrusted" };
      if (parsed.version !== 1) return { kind: "untrusted" };
      const tokens = parsed.tokens;
      if (!tokens || typeof tokens !== "object" || Array.isArray(tokens))
        return { kind: "untrusted" };
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(tokens))
        if (validToken(value)) result[key] = value;
      return { kind: "trusted", tokens: result };
    } finally {
      closeSync(fd);
    }
  }

  private readTokens(): Record<string, string> {
    const state = this.readState();
    return state.kind === "trusted" ? state.tokens : {};
  }

  private writeTokens(tokens: Record<string, string>): void {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.cleanupStaleTemps();
    const temp = path.join(
      this.dataDir,
      `${TEMP_PREFIX}${randomBytes(8).toString("hex")}${TEMP_SUFFIX}`,
    );
    const data = JSON.stringify({ version: 1, tokens });
    try {
      const fd = openSync(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        writeFileSync(fd, data);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.file);
    } catch (error) {
      // Never leave a plaintext PAT behind in a stray temp file.
      try {
        unlinkSync(temp);
      } catch {
        // Nothing useful to do if even the cleanup fails.
      }
      throw error;
    }
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // Best effort; the file was created with 0600 already.
    }
  }

  private unlinkCredentialFile(): void {
    try {
      unlinkSync(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw Error(DELETE_FAILED);
    }
  }

  async load(connectionId: string): Promise<string | null> {
    if (!validConnectionId(connectionId)) return null;
    const tokens = this.readTokens();
    const token = tokens[connectionId];
    return typeof token === "string" ? token : null;
  }

  async save(connectionId: string, token: string): Promise<boolean> {
    if (!validConnectionId(connectionId)) return false;
    if (!validToken(token)) return false;
    const state = this.readState();
    // A transient read failure must not clobber credentials we cannot see.
    if (state.kind === "error") return false;
    const tokens = state.kind === "trusted" ? state.tokens : {};
    tokens[connectionId] = token;
    try {
      this.writeTokens(tokens);
      return true;
    } catch {
      return false;
    }
  }

  async delete(connectionId: string): Promise<void> {
    if (!validConnectionId(connectionId)) return;
    this.cleanupStaleTemps();
    const state = this.readState();
    if (state.kind === "missing") return;
    if (state.kind === "error") {
      // Cannot read the file, so do not risk deleting the wrong thing.
      throw Error(DELETE_FAILED);
    }
    if (state.kind === "untrusted") {
      // The entry exists but cannot be trusted or parsed, so drop it entirely
      // rather than leaving a stale PAT behind. A symlink is unlinked, never
      // followed, so its target is preserved.
      this.unlinkCredentialFile();
      return;
    }
    const tokens = state.tokens;
    if (!Object.prototype.hasOwnProperty.call(tokens, connectionId)) return;
    delete tokens[connectionId];
    if (Object.keys(tokens).length === 0) {
      this.unlinkCredentialFile();
      return;
    }
    try {
      this.writeTokens(tokens);
    } catch {
      throw Error(DELETE_FAILED);
    }
  }
}

function selectBackend(options: {
  backend?: CredentialBackend;
  platform?: NodeJS.Platform;
}): CredentialBackend {
  if (
    options.backend === "keychain" ||
    options.backend === "file" ||
    options.backend === "off"
  )
    return options.backend;
  const env = process.env[ENV_NAME];
  if (env === "keychain" || env === "file" || env === "off") return env;
  const platform = options.platform ?? process.platform;
  return platform === "darwin" ? "keychain" : "file";
}

export function createGitHubCredentialStore(options: {
  dataDir: string;
  backend?: CredentialBackend;
  platform?: NodeJS.Platform;
  runSecurity?: SecurityRunner;
}): GitHubCredentialStore {
  const backend = selectBackend(options);
  if (backend === "off") return new OffCredentialStore();
  if (backend === "keychain")
    return new KeychainCredentialStore(
      options.runSecurity ?? defaultSecurityRunner,
    );
  return new FileCredentialStore(options.dataDir);
}
