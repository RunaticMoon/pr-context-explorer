// Synthetic filesystem fixtures. On Darwin this builds only the metadata ACL
// helper; it is NOT evidence of an actual Electron update or replacement.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after } from "node:test";
import path from "node:path";
import os from "node:os";
import { bindNativeACL } from "../desktop/public-update/acl.ts";
if (process.platform === "darwin") {
  const temp = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "public-acl-fixture-"),
  );
  const helper = path.join(temp, "prce-macos-acl");
  const options = {
    timeout: 60000,
    maxBuffer: 65536,
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  };
  execFileSync(
    "/usr/bin/clang",
    [
      "-std=c11",
      "-D_DARWIN_C_SOURCE",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      "-arch",
      process.arch === "arm64" ? "arm64" : "x86_64",
      "-mmacosx-version-min=13.0",
      "-fstack-protector-strong",
      "-o",
      helper,
      fileURLToPath(new URL("../desktop/native/macos-acl.c", import.meta.url)),
    ],
    options,
  );
  execFileSync(
    "/usr/bin/codesign",
    ["--force", "--sign", "-", helper],
    options,
  );
  bindNativeACL(helper);
  after(() => rm(temp, { recursive: true, force: true }));
}
