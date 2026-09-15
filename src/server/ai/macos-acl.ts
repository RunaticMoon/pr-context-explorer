import { AIError } from "./errors.ts";
import {
  execFile,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { lstat, realpath } from "node:fs/promises";

const nativeExec = promisify(execFile);
type AclExecutor = (
  file: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
) => Promise<{ stdout: string; stderr: string }>;

// Trusted application module location, NOT the inspected repository or environment.
const helper = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "../../../desktop/build/runtime/native/prce-macos-acl"
      : "../../../native/prce-macos-acl",
    import.meta.url,
  ),
);

/** Metadata-only code-level test seam; it cannot select the production executable. */
export async function assertMacAclHelperFile(file: string): Promise<void> {
  try {
    const stat = await lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !(stat.mode & 0o111) ||
      stat.mode & 0o022 ||
      (stat.uid !== 0 && stat.uid !== process.getuid?.()) ||
      (await realpath(file)) !== file
    )
      throw new Error("helper");
  } catch {
    throw new AIError("sandbox_unavailable");
  }
}

/** Code-only executor injection supports tests; never expose it to IPC/HTTP. */
export async function readMacDirectoryAcl(
  path: string,
  execute: AclExecutor = nativeExec,
): Promise<string> {
  try {
    if (
      !isAbsolute(path) ||
      normalize(path) !== path ||
      (path !== "/" && path.endsWith("/")) ||
      /[\x00-\x1f\x7f]/.test(path)
    )
      throw new Error("path");
    if (execute === nativeExec) {
      if (process.platform !== "darwin") throw new Error("platform");
      await assertMacAclHelperFile(helper);
    }
    const { stdout, stderr } = await execute(helper, [path], {
      cwd: "/",
      env: { LANG: "C", LC_ALL: "C" },
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 1024,
      killSignal: "SIGKILL",
      shell: false,
    });
    if (stderr !== "" || Buffer.byteLength(stdout, "utf8") > 1024)
      throw new Error("output");
    assertSafeMacDirectoryAcl(stdout, path);
    return stdout;
  } catch {
    throw new AIError("sandbox_unavailable");
  }
}

/** Exact wire grammar rejects duplicates, extensions, unknowns and partial output. */
export function assertSafeMacDirectoryAcl(output: string, _path: string): void {
  if (
    output !== '{"version":1,"status":"empty"}\n' &&
    output !== '{"version":1,"status":"deny-only"}\n'
  )
    throw new AIError("sandbox_unavailable");
}
