import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fail } from "./policy.ts";
const exec = promisify(execFile);
let helper: string | null = null,
  verified = false;
const checked = new Map<string, string>();
/** Trusted main/helper initialization only, never exposed by the service or IPC. */
export function bindNativeACL(file: string) {
  if (helper !== file) {
    helper = file;
    verified = false;
    checked.clear();
  }
}
export function validateACLResponse(stdout: string, stderr: string) {
  if (
    stderr !== "" ||
    ![
      '{"version":1,"status":"empty"}\n',
      '{"version":1,"status":"deny-only"}\n',
    ].includes(stdout)
  )
    fail("UNSAFE_ACL");
}
export async function checkNativeACL(file: string, directory: boolean) {
  if (process.platform !== "darwin") return;
  if (!helper || !path.isAbsolute(helper) || /[\x00-\x1f\x7f]/.test(file))
    fail("ACL_UNAVAILABLE");
  if (!verified) {
    const h = await lstat(helper);
    if (
      !h.isFile() ||
      h.isSymbolicLink() ||
      h.nlink !== 1 ||
      h.uid !== process.getuid?.() ||
      h.mode & 0o022 ||
      !(h.mode & 0o111) ||
      (await realpath(helper)) !== helper
    )
      fail("ACL_UNAVAILABLE");
    await exec("/usr/bin/codesign", ["--verify", "--strict", helper], {
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      timeout: 10000,
      maxBuffer: 4096,
    });
    verified = true;
  }
  const s = await lstat(file),
    stamp = `${s.dev}:${s.ino}:${s.ctimeMs}:${s.mode}:${s.uid}:${s.gid}`;
  if (checked.get(file) === stamp) return;
  const { stdout, stderr } = await exec(
    helper,
    directory ? [file] : ["--regular-file", file],
    {
      env: { LANG: "C", LC_ALL: "C" },
      cwd: "/",
      timeout: 2000,
      maxBuffer: 1024,
      encoding: "utf8",
    },
  );
  validateACLResponse(stdout, stderr);
  checked.set(file, stamp);
}
