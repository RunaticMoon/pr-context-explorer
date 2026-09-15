import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  writeFile,
  mkdir,
  chmod,
  symlink,
  rm,
} from "node:fs/promises";
import { validateMacNative, trustedMacPath } from "../src/server/ai/macos.ts";

function arm(subtype = 0, environment = false): Buffer {
  const b = Buffer.alloc(environment ? 96 : 32);
  b.writeUInt32LE(0xfeedfacf);
  b.writeUInt32LE(0x0100000c, 4);
  b.writeUInt32LE(subtype, 8);
  b.writeUInt32LE(2, 12);
  if (environment) {
    b.writeUInt32LE(1, 16);
    b.writeUInt32LE(64, 20);
    b.writeUInt32LE(0x27, 32);
    b.writeUInt32LE(64, 36);
    b.writeUInt32LE(12, 40);
    b.write("DYLD_INSERT_LIBRARIES=/tmp/never-loaded.dylib\0", 44);
  }
  return b;
}
function fat(slices: Buffer[], wide = false): Buffer {
  const b = Buffer.alloc((slices.length + 1) * 4096);
  b.writeUInt32BE(wide ? 0xcafebabf : 0xcafebabe);
  b.writeUInt32BE(slices.length, 4);
  slices.forEach((slice, i) => {
    const p = 8 + i * (wide ? 32 : 20),
      offset = (i + 1) * 4096;
    b.writeUInt32BE(slice.readUInt32LE(4), p);
    b.writeUInt32BE(slice.readUInt32LE(8), p + 4);
    if (wide) {
      b.writeBigUInt64BE(BigInt(offset), p + 8);
      b.writeBigUInt64BE(BigInt(slice.length), p + 16);
    } else {
      b.writeUInt32BE(offset, p + 8);
      b.writeUInt32BE(slice.length, p + 12);
    }
    b.writeUInt32BE(12, p + (wide ? 24 : 16));
    slice.copy(b, offset);
  });
  return b;
}
async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await realpath(await mkdtemp("/tmp/ai-macos-validation-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("symlink dotdot traversal checks discarded directories and retains trusted relative links", async () => {
  await fixture(async (dir) => {
    await writeFile(`${dir}/engine`, arm(), { mode: 0o700 });
    await mkdir(`${dir}/unsafe`);
    await chmod(`${dir}/unsafe`, 0o777);
    await mkdir(`${dir}/bin`, { mode: 0o700 });
    await mkdir(`${dir}/lib`, { mode: 0o700 });
    await symlink("../engine", `${dir}/bin/official`);
    assert.equal(await trustedMacPath(`${dir}/bin/official`), `${dir}/engine`);
    await symlink("unsafe/../engine", `${dir}/entry`);
    await assert.rejects(
      trustedMacPath(`${dir}/entry`),
      "literal writable traversal must be inspected",
    );
    await symlink("../unsafe/../engine", `${dir}/bin/entry`);
    await assert.rejects(validateMacNative(`${dir}/bin/entry`));
    await symlink(`${dir}/unsafe/../engine`, `${dir}/absolute`);
    await assert.rejects(trustedMacPath(`${dir}/absolute`));
    await symlink("../lib", `${dir}/bin/middle`);
    await symlink("bin/middle/../engine", `${dir}/nested`);
    assert.equal(await trustedMacPath(`${dir}/nested`), `${dir}/engine`);
  });
});
test("universal slice metadata is exact, bounded, aligned and non-overlapping", async () => {
  await fixture(async (dir) => {
    const x64 = arm();
    x64.writeUInt32LE(0x01000007, 4);
    for (const wide of [false, true]) {
      const valid = fat([x64, arm()], wide);
      await writeFile(`${dir}/valid`, valid, { mode: 0o700 });
      await validateMacNative(`${dir}/valid`);
      const p = 8 + (wide ? 32 : 20);
      const mutations: Array<(b: Buffer) => void> = [
        (b) => b.writeUInt32BE(2, p + 4), // table/header subtype mismatch
        (b) => {
          if (wide) b.writeBigUInt64BE(16n, p + 16);
          else b.writeUInt32BE(16, p + 12);
        },
        (b) => b.writeUInt32BE(31, p + (wide ? 24 : 16)), // alignment mismatch
        (b) => {
          if (wide) b.writeBigUInt64BE(8192n, 8 + 16);
          else b.writeUInt32BE(8192, 8 + 12);
        }, // overlaps
        (b) => {
          if (wide) b.writeBigUInt64BE(2n ** 60n, p + 8);
          else b.writeUInt32BE(0xfffffff0, p + 8);
        },
      ];
      for (const [i, mutate] of mutations.entries()) {
        const bad = Buffer.from(valid);
        mutate(bad);
        await writeFile(`${dir}/bad`, bad, { mode: 0o700 });
        await assert.rejects(
          validateMacNative(`${dir}/bad`),
          `wide=${wide}, mutation=${i}`,
        );
      }
    }
  });
});
test("universal binaries reject a second ARM64 slice hiding DYLD environment commands", async () => {
  await fixture(async (dir) => {
    const bad = arm(2, true);
    await writeFile(`${dir}/thin`, bad, { mode: 0o700 });
    await assert.rejects(validateMacNative(`${dir}/thin`));
    for (const wide of [false, true]) {
      await writeFile(`${dir}/fat`, fat([arm(), bad], wide), { mode: 0o700 });
      await assert.rejects(
        validateMacNative(`${dir}/fat`),
        "second ARM64 slice must not bypass validation",
      );
    }
  });
});
