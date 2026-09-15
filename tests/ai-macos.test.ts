import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const icuRule =
  '(allow file-read-data file-read-metadata (literal "/usr/share/icu/icudt76l.dat"))';
const systemPolicyRules = [
  '(allow file-read-data file-read-metadata (literal "/System/Library/OpenSSL/openssl.cnf"))',
  '(allow file-read-metadata (literal "/System") (literal "/System/Library") (literal "/System/Library/OpenSSL"))',
  '(allow file-read-metadata (literal "/etc") (literal "/private/etc") (literal "/etc/codex") (literal "/private/etc/codex"))',
  ...["requirements.toml", "managed_config.toml", "config.toml"].map(
    (name) =>
      `(allow file-read-data file-read-metadata (literal "/etc/codex/${name}") (literal "/private/etc/codex/${name}"))`,
  ),
];

test("system config reads are literal leaves with metadata-only parents", () => {
  const profile = buildSeatbeltProfile({
    executable: "/opt/trusted/codex",
    writable: [],
    readOnly: [],
  });
  for (const rule of systemPolicyRules)
    assert.equal(
      profile.split("\n").filter((line) => line === rule).length,
      1,
      rule,
    );
});

test("loader and system-config deltas are exact; all other permissions stay frozen", () => {
  const profile = buildSeatbeltProfile({
    executable: "/opt/trusted/codex",
    writable: ["/private/tmp/run/work"],
    readOnly: ["/private/tmp/run/auth.json"],
    proxyPort: 34567,
  });
  const rootRule = '(allow file-read-data (literal "/"))';
  const lines = profile.split("\n");
  assert.deepEqual(
    lines.filter((line) => line.includes("/usr/share")),
    [icuRule],
  );
  const withoutIcu = lines.filter((line) => line !== icuRule);
  assert.equal(
    createHash("sha256").update(withoutIcu.join("\n")).digest("hex"),
    "665326db0be538eb6f1fde765c675c60546814c5f5cfffb3d283d1edf5b09e05",
  );
  assert.equal(lines.filter((line) => line === rootRule).length, 1);
  // No recursive root/prefix/glob, wildcard root read, or root write grant.
  assert.doesNotMatch(
    profile,
    /\((?:subpath|prefix|literal-prefix|regex) "\/"\)|\(literal "\/\*"\)/,
  );
  assert.deepEqual(
    lines.filter((line) => line.includes('(literal "/")')),
    [
      rootRule,
      '(allow file-read-metadata (literal "/") (literal "/private") (literal "/private/tmp"))',
    ],
  );
  // Deliberate additive delta: remove ONLY the literal root rule and the six
  // exact rules asserted above. Keep HEAD 294bcda's SHA unchanged, freezing all
  // other permissions. See docs/MACOS-SYSTEM-POLICY-READS.md.
  assert.equal(
    createHash("sha256")
      .update(
        withoutIcu
          .filter(
            (line) => line !== rootRule && !systemPolicyRules.includes(line),
          )
          .join("\n"),
      )
      .digest("hex"),
    "6d018c27a3d192de5e65a5c6a3d0701245e781100c7180ad677f08b7534e4d1a",
  );
  // Also freeze the complete new policy, including additive rule order.
  assert.equal(
    createHash("sha256").update(profile).digest("hex"),
    "8bd691932ca445b665e6e82df65e490ec6f19657f708f215894931cd6188a947",
  );
});
import {
  buildSeatbeltProfile,
  isArm64MachO,
  validateMacNative,
  macInvocationArgs,
} from "../src/server/ai/macos.ts";

test("Darwin relocates only the Codex schema flag value, not trusted text", () => {
  const args = [
    "--output-schema",
    "/runtime/schema.json",
    "--system-prompt",
    "/runtime/schema.json",
  ];
  assert.deepEqual(macInvocationArgs(args, "/private/tmp/run/schema.json"), [
    "--output-schema",
    "/private/tmp/run/schema.json",
    "--system-prompt",
    "/runtime/schema.json",
  ]);
});
import {
  mkdtemp,
  mkdir,
  chmod,
  writeFile,
  symlink,
  rm,
} from "node:fs/promises";

test("native validation rejects writable intermediate symlink-chain directories", async () => {
  const dir = await mkdtemp("/tmp/ai-macos-native-");
  try {
    const arm = Buffer.alloc(32);
    arm.writeUInt32LE(0xfeedfacf);
    arm.writeUInt32LE(0x0100000c, 4);
    arm.writeUInt32LE(2, 12);
    await writeFile(`${dir}/engine`, arm, { mode: 0o755 });
    await mkdir(`${dir}/unsafe`);
    await chmod(`${dir}/unsafe`, 0o777);
    await symlink(`${dir}/engine`, `${dir}/unsafe/middle`);
    await symlink(`${dir}/unsafe/middle`, `${dir}/entry`);
    await assert.rejects(validateMacNative(`${dir}/entry`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("native loader rejects embedded DYLD environment injection", async () => {
  const dir = await mkdtemp("/tmp/ai-macos-load-commands-");
  try {
    const value = Buffer.from(
      "DYLD_INSERT_LIBRARIES=/Users/example/plugin.dylib\0",
    );
    const length = Math.ceil((12 + value.length) / 8) * 8;
    const fixture = Buffer.alloc(32 + length);
    fixture.writeUInt32LE(0xfeedfacf);
    fixture.writeUInt32LE(0x0100000c, 4);
    fixture.writeUInt32LE(2, 12);
    fixture.writeUInt32LE(1, 16);
    fixture.writeUInt32LE(length, 20);
    fixture.writeUInt32LE(0x27, 32);
    fixture.writeUInt32LE(length, 36);
    fixture.writeUInt32LE(12, 40);
    value.copy(fixture, 44);
    await writeFile(`${dir}/header-only-never-executed`, fixture, {
      mode: 0o755,
    });
    await assert.rejects(
      validateMacNative(`${dir}/header-only-never-executed`),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import { macEngineCandidates } from "../src/server/ai/macos-discovery.ts";
import { macManagedPaths } from "../src/server/ai/policy.ts";

test("Darwin discovery names exact native packages, not inherited PATH or npm JS", () => {
  const codex = macEngineCandidates("codex", "/app", "/Users/owner");
  assert.ok(
    codex.includes(
      "/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex",
    ),
  );
  assert.ok(codex.includes("/Users/owner/.local/bin/codex"));
  assert.ok(
    macEngineCandidates("claude", "/app", "/Users/owner").includes(
      "/app/.tools/ai-clis/node_modules/@anthropic-ai/claude-code-darwin-arm64/claude",
    ),
  );
  assert.ok(codex.every((p) => !p.endsWith(".js") && !p.includes("linux")));
});

test("managed policy checks target exact global and per-user MDM domains", () => {
  assert.ok(
    macManagedPaths("codex", "owner").includes(
      "/Library/Managed Preferences/owner/com.openai.codex.plist",
    ),
  );
  assert.ok(
    macManagedPaths("claude", "owner").includes(
      "/Library/Application Support/ClaudeCode/managed-settings.json",
    ),
  );
  assert.ok(
    macManagedPaths("claude", "owner").includes(
      "/Library/Managed Preferences/com.anthropic.claudecode.plist",
    ),
  );
  assert.throws(() => macManagedPaths("codex", "../evil"));
});

test("Seatbelt is deny-default, exact executable/proxy, no home or source grants", () => {
  const profile = buildSeatbeltProfile({
    executable: "/opt/trusted/codex",
    writable: ["/private/tmp/run/work"],
    readOnly: ["/private/tmp/run/auth.json"],
    proxyPort: 34567,
  });
  assert.match(profile, /\(deny default\)/);
  assert.match(profile, /\(deny process-fork\)/);
  assert.match(
    profile,
    /\(allow process-exec \(literal "\/opt\/trusted\/codex"\)\)/,
  );
  assert.match(profile, /remote tcp "localhost:34567"/);
  assert.doesNotMatch(profile, /remote tcp "(?:127|\*|localhost:\*)/);
  assert.doesNotMatch(
    profile,
    /allow network-inbound|allow network\*|allow process-fork|subpath "\/Users|subpath "\/private\/tmp"|subpath "\/Library"/,
  );
  assert.throws(() =>
    buildSeatbeltProfile({
      executable: "relative",
      writable: [],
      readOnly: [],
    }),
  );
  assert.throws(() =>
    buildSeatbeltProfile({
      executable: "/bin/node",
      writable: ["/"],
      readOnly: [],
    }),
  );
  assert.throws(() =>
    buildSeatbeltProfile({
      executable: "/bin/node",
      writable: [],
      readOnly: [],
      proxyPort: 0,
    }),
  );
});

test("Mach-O discovery accepts ARM64 executable headers, not ELF/scripts/x64", () => {
  const arm = Buffer.alloc(32);
  arm.writeUInt32LE(0xfeedfacf);
  arm.writeUInt32LE(0x0100000c, 4);
  arm.writeUInt32LE(2, 12);
  assert.equal(isArm64MachO(arm), true);
  const x64 = Buffer.from(arm);
  x64.writeUInt32LE(0x01000007, 4);
  assert.equal(isArm64MachO(x64), false);
  assert.equal(isArm64MachO(Buffer.from("#!/bin/sh\n")), false);
  assert.equal(isArm64MachO(Buffer.from([127, 69, 76, 70])), false);
});
