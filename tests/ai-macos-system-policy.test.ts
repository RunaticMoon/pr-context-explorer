import test from "node:test";
import assert from "node:assert/strict";
import * as mac from "../src/server/ai/macos.ts";

// Model only lstat/readlink: production must never open configuration content.
// Real system directories cannot be created safely in portable unit tests.
function fixture(overrides: Record<string, Partial<Entry> | string> = {}) {
  const seen: string[] = [];
  const entries: Record<string, Partial<Entry> | string> = {
    "/": {},
    "/System": {},
    "/System/Library": {},
    "/System/Library/OpenSSL": {},
    "/private": {},
    "/private/etc": {},
    "/etc": { link: "private/etc" },
    ...overrides,
  };
  return {
    seen,
    readAcl: async (_path: string) => '{"version":1,"status":"empty"}\n',
    lstat: async (path: string) => {
      seen.push(path);
      const entry = entries[path];
      if (!entry || typeof entry === "string")
        throw Object.assign(new Error("metadata failure"), {
          code: entry ?? "ENOENT",
        });
      const e = { uid: 0, mode: 0o755, directory: true, ...entry };
      return {
        uid: e.uid,
        mode: e.mode,
        isDirectory: () => e.directory && !e.link,
        isSymbolicLink: () => !!e.link,
      };
    },
    readlink: async (path: string) => (entries[path] as Entry).link!,
  };
}
test("root-owned 0755 ancestor with ACL create grant fails before absence checks", async () => {
  const fs = fixture();
  fs.readAcl = async () => '{"version":1,"status":"unsafe"}\n';
  await assert.rejects(
    mac.validateMacSystemPolicyReads(fs),
    (e: any) => e.code === "sandbox_unavailable",
  );
  assert.deepEqual(fs.seen, ["/"]);
});

test("preflight inspects ACLs of every existing fixed ancestor, including etc alias target", async () => {
  const fs = fixture({ "/private/etc/codex": {} });
  const aclPaths: string[] = [];
  fs.readAcl = async (path) => {
    aclPaths.push(path);
    return '{"version":1,"status":"deny-only"}\n';
  };
  await mac.validateMacSystemPolicyReads(fs);
  assert.deepEqual(aclPaths, [
    "/",
    "/System",
    "/System/Library",
    "/private",
    "/private/etc",
    "/System/Library/OpenSSL",
    "/private/etc/codex",
  ]);
  assert.ok(!aclPaths.includes("/etc")); // Symlink itself has no ACL; exact target does.
});

for (const ancestor of [
  "/",
  "/System",
  "/System/Library",
  "/private",
  "/private/etc",
  "/System/Library/OpenSSL",
  "/private/etc/codex",
]) {
  for (const outcome of [
    "grant",
    "ENOENT",
    "EACCES",
    "EPERM",
    "ETIMEDOUT",
    "unknown-format",
  ]) {
    test(`ACL preflight fails closed at ${ancestor}: ${outcome}`, async () => {
      const fs = fixture({ "/private/etc/codex": {} });
      const safe = fs.readAcl;
      fs.readAcl = async (path) => {
        if (path !== ancestor) return safe(path);
        if (outcome === "grant") return '{"version":1,"status":"unsafe"}\n';
        if (outcome === "unknown-format") return "unrecognized native output\n";
        throw Object.assign(new Error("inspection failed"), { code: outcome });
      };
      await assert.rejects(mac.validateMacSystemPolicyReads(fs), {
        code: "sandbox_unavailable",
      });
      assert.ok(!fs.seen.includes(`${ancestor}/config.toml`));
    });
  }
}

interface Entry {
  uid: number;
  mode: number;
  directory: boolean;
  link?: string;
}

test("system-read preflight accepts genuine absence behind trusted macOS ancestors", async () => {
  assert.equal(typeof mac.validateMacSystemPolicyReads, "function");
  const fs = fixture();
  await mac.validateMacSystemPolicyReads(fs);
  assert.ok(fs.seen.includes("/private/etc/codex"));
  assert.ok(fs.seen.includes("/System/Library/OpenSSL/openssl.cnf"));
});

for (const leaf of [
  "/System/Library/OpenSSL/openssl.cnf",
  ...["requirements.toml", "managed_config.toml", "config.toml"].map(
    (name) => `/private/etc/codex/${name}`,
  ),
]) {
  for (const state of [
    { directory: false }, // Includes empty files: never parse or exempt them.
    { directory: false, mode: 0 },
    { link: "/Users/owner/secret-or-plugin" },
    { link: "/nonexistent/dangling" },
    {}, // Directories cannot masquerade as absence.
    "EPERM",
    "EACCES",
    "EIO",
    "ENOTDIR",
    "ELOOP",
  ])
    test(`system config refuses present/unknown ${leaf}: ${JSON.stringify(state)}`, async () => {
      await assert.rejects(
        mac.validateMacSystemPolicyReads(
          fixture({
            "/private/etc/codex": {},
            [leaf]: state,
          }),
        ),
        (e: any) => e.code === "managed_policy_unsupported",
      );
    });
}

for (const path of [
  "/",
  "/System",
  "/System/Library",
  "/System/Library/OpenSSL",
  "/private",
  "/private/etc",
  "/private/etc/codex",
])
  for (const state of [
    { uid: 501 },
    { mode: 0o777 },
    { link: "/Users/owner/config" },
    { directory: false },
    "EPERM",
    "EACCES",
    "EIO",
    "ENOTDIR",
  ])
    test(`untrusted/unknown system ancestor fails closed ${path}: ${JSON.stringify(state)}`, async () => {
      await assert.rejects(
        mac.validateMacSystemPolicyReads(fixture({ [path]: state })),
        (e: any) => e.code === "sandbox_unavailable",
      );
    });

for (const state of [
  {},
  { link: "/tmp/etc" },
  { link: "private/etc", uid: 501 },
])
  test(`only the root-owned macOS etc alias is accepted: ${JSON.stringify(state)}`, async () => {
    await assert.rejects(
      mac.validateMacSystemPolicyReads(fixture({ "/etc": state })),
    );
  });

test("trusted empty Codex directory and missing OpenSSL directory are genuine absence", async () => {
  await mac.validateMacSystemPolicyReads(
    fixture({
      "/System/Library/OpenSSL": "ENOENT",
      "/private/etc/codex": {},
      "/etc": { link: "/private/etc" },
    }),
  );
});
