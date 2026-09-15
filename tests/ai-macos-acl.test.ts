import test from "node:test";
import assert from "node:assert/strict";
import * as acl from "../src/server/ai/macos-acl.ts";

test("reader uses only bundled executable, bounded argv and clean environment", async () => {
  const result = await acl.readMacDirectoryAcl(
    "/private/etc",
    async (file, args, options) => {
      assert.match(file, /\/desktop\/build\/runtime\/native\/prce-macos-acl$/);
      assert.deepEqual(args, ["/private/etc"]);
      assert.deepEqual(options, {
        cwd: "/",
        env: { LANG: "C", LC_ALL: "C" },
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 1024,
        killSignal: "SIGKILL",
        shell: false,
      });
      return { stdout: line("empty"), stderr: "" };
    },
  );
  assert.equal(result, line("empty"));
});

import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test(
  "native C shim: complete iteration and injected API failures never become empty",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "prce-acl-shim-")));
    try {
      const helper = join(root, "helper");
      execFileSync("cc", [
        "-std=c11",
        "-D_DEFAULT_SOURCE",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-Itests/fixtures/macos-acl-shim",
        "desktop/native/macos-acl.c",
        "tests/fixtures/macos-acl-shim/shim.c",
        "-o",
        helper,
      ]);
      for (const scenario of [
        "absent",
        "empty",
        "deny",
        "allow",
        "allow-last",
        "allow-zero",
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 20].map(
          (bit) => `allow-perm-${bit}`,
        ),
        "null",
        "first",
        "next",
        "end",
        "tag",
        "qualifier",
        "permset",
        "mask",
        "perm",
        "flagset",
        "flag",
        "size",
        "copy",
        "count",
        "unknown-tag",
        "unknown-perm",
        "unknown-flag",
        "statx",
        "unpopulated",
        "owner",
        "query",
        "property",
        "free",
        "acl-flags",
        "security-support",
        "security-support-error",
      ]) {
        await t.test(scenario, () => {
          const path = join(root, scenario);
          mkdirSync(path);
          const result = spawnSync(helper, [path], {
            encoding: "utf8",
            timeout: 3000,
            env: {},
          });
          const safe = ["absent", "empty", "deny"].includes(scenario);
          assert.equal(
            result.status,
            safe ? 0 : scenario.startsWith("allow") ? 2 : 1,
            scenario + result.stderr,
          );
          assert.equal(
            result.stdout,
            line(
              safe
                ? scenario === "deny"
                  ? "deny-only"
                  : "empty"
                : scenario.startsWith("allow")
                  ? "unsafe"
                  : "error",
            ),
            scenario,
          );
          assert.equal(result.stderr, "");
        });
      }
      await t.test("native argv and symlink rejection", () => {
        const link = join(root, "link");
        symlinkSync(join(root, "empty"), link);
        const regular = join(root, "file");
        writeFileSync(regular, "not a directory");
        for (const args of [
          [],
          [root, root],
          ["relative"],
          ["/./"],
          ["//"],
          [root + "/"],
          [root + "/../"],
          [link],
          [regular],
          [join(root, "missing")],
        ]) {
          const result = spawnSync(helper, args, {
            encoding: "utf8",
            timeout: 3000,
            env: {},
          });
          assert.equal(result.status, 1, JSON.stringify(args));
          assert.equal(result.stdout, line("error"));
          assert.equal(result.stderr, "");
        }
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("helper validation refuses missing, symlinked, writable or non-executable files", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prce-acl-helper-")));
  try {
    const file = join(root, "helper");
    await assert.rejects(acl.assertMacAclHelperFile(file));
    writeFileSync(file, "test-only; never executed", { mode: 0o700 });
    await acl.assertMacAclHelperFile(file);
    symlinkSync(file, join(root, "link"));
    await assert.rejects(acl.assertMacAclHelperFile(join(root, "link")));
    symlinkSync(root, join(root, "parent"));
    await assert.rejects(
      acl.assertMacAclHelperFile(join(root, "parent", "helper")),
    );
    for (const mode of [0o600, 0o777]) {
      chmodSync(file, mode);
      await assert.rejects(acl.assertMacAclHelperFile(file));
    }
    await assert.rejects(acl.assertMacAclHelperFile(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "native build refuses non-macOS rather than creating a fake helper",
  { skip: process.platform === "darwin" },
  () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/build-macos-acl.mjs"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /macOS build host required/);
  },
);

test("reader rejects unsafe paths, warnings, unknown output and native failures", async () => {
  for (const path of [
    "relative",
    "-R",
    "/private/../etc",
    "/etc\n/fake",
    "/etc/",
    "/etc\u0000",
    "//etc",
    "/private/./etc",
  ]) {
    let called = false;
    await assert.rejects(
      acl.readMacDirectoryAcl(path, async () => {
        called = true;
        return { stdout: line("empty"), stderr: "" };
      }),
      { code: "sandbox_unavailable" },
    );
    assert.equal(called, false);
  }
  for (const result of [
    { stdout: line("empty"), stderr: "warning" },
    { stdout: "x".repeat(1025), stderr: "" },
    { stdout: line("unsafe"), stderr: "" },
    { stdout: line("error"), stderr: "" },
    { stdout: "", stderr: "" },
  ])
    await assert.rejects(
      acl.readMacDirectoryAcl("/private/etc", async () => result),
      { code: "sandbox_unavailable" },
    );
  for (const code of [
    "ENOENT",
    "EACCES",
    "EPERM",
    "ETIMEDOUT",
    "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    "SIGKILL",
  ])
    await assert.rejects(
      acl.readMacDirectoryAcl("/private/etc", async () => {
        throw Object.assign(new Error("untrusted diagnostic"), { code });
      }),
      (e: any) =>
        e.code === "sandbox_unavailable" && !e.message.includes("untrusted"),
    );
  if (process.platform !== "darwin")
    await assert.rejects(acl.readMacDirectoryAcl("/"), {
      code: "sandbox_unavailable",
    });
});

test(
  "Darwin native fixtures: absent, deny, allow, inherited, hidden ACL and symlinks",
  { skip: process.platform !== "darwin" },
  async () => {
    // Real APIs, no sudo, no root/system ACL changes, no availability-based skip.
    execFileSync(process.execPath, ["scripts/build-macos-acl.mjs"], {
      timeout: 90000,
    });
    const root = realpathSync(mkdtempSync(join(tmpdir(), "prce-acl-native-")));
    const paths: string[] = [];
    const chmod = (args: string[]) =>
      execFileSync("/bin/chmod", args, {
        cwd: "/",
        env: { LANG: "C", LC_ALL: "C" },
        timeout: 2000,
        maxBuffer: 1024,
      });
    try {
      for (const [name, entries, safe] of [
        ["plain", [], true],
        ["deny", ["group:everyone deny delete"], true],
        ["create", ["group:everyone allow add_file,add_subdirectory"], false],
        ["read", ["group:everyone allow list"], false],
        [
          "hidden",
          ["group:everyone deny readsecurity", "group:everyone allow add_file"],
          false,
        ],
      ] as const) {
        const path = join(root, name);
        mkdirSync(path);
        paths.push(path);
        chmod(["-N", path]);
        for (const entry of entries) chmod(["+a", entry, path]);
        if (safe)
          acl.assertSafeMacDirectoryAcl(
            await acl.readMacDirectoryAcl(path),
            path,
          );
        else
          await assert.rejects(acl.readMacDirectoryAcl(path), {
            code: "sandbox_unavailable",
          });
      }
      for (const kind of ["allow", "deny"]) {
        const parent = join(root, "inherited-" + kind);
        mkdirSync(parent);
        paths.push(parent);
        chmod(["-N", parent]);
        chmod([
          "+a",
          `group:everyone ${kind} delete,file_inherit,directory_inherit`,
          parent,
        ]);
        const child = join(parent, "child");
        mkdirSync(child);
        paths.push(child);
        if (kind === "allow")
          await assert.rejects(acl.readMacDirectoryAcl(child), {
            code: "sandbox_unavailable",
          });
        else
          assert.equal(await acl.readMacDirectoryAcl(child), line("deny-only"));
      }
      const bad = spawnSync(
        "/bin/chmod",
        ["+a", "group:everyone deny not_a_permission", paths[0]],
        { encoding: "utf8", timeout: 2000 },
      );
      assert.notEqual(
        bad.status,
        0,
        "OS must reject malformed ACL installation",
      );
      symlinkSync(paths[0], join(root, "link"));
      for (const path of [join(root, "link"), join(root, "missing")])
        await assert.rejects(acl.readMacDirectoryAcl(path), {
          code: "sandbox_unavailable",
        });
    } finally {
      for (const path of paths.reverse()) chmod(["-N", path]);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

const line = (status: string) => `{"version":1,"status":"${status}"}\n`;
test("native protocol accepts only exact complete empty or deny-only results", () => {
  for (const status of ["empty", "deny-only"])
    assert.doesNotThrow(() =>
      acl.assertSafeMacDirectoryAcl(line(status), "/private/etc"),
    );
  for (const output of [
    "",
    "{}",
    line("unsafe"),
    line("error"),
    line("unknown"),
    line("empty").trimEnd(),
    line("empty") + line("empty"),
    " " + line("empty"),
    line("empty").replace("1", "2"),
    '{"version":1,"status":"unsafe","status":"empty"}\n',
    '{"version":1,"status":"empty","complete":false}\n',
    "x".repeat(1025),
    "drwxr-xr-x 2 0 0 64 Sep 15 12:00 /private/etc\n",
  ])
    assert.throws(() => acl.assertSafeMacDirectoryAcl(output, "/private/etc"), {
      code: "sandbox_unavailable",
    });
});
