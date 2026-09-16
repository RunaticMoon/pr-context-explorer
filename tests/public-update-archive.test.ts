import "./public-update-test-support.ts";
import { realpath } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  symlink,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { extractVerifiedZip } from "../desktop/public-update/archive.ts";
import {
  privateDirectory,
  exclusiveFile,
} from "../desktop/public-update/files.ts";
import { APP_NAME, type Manifest } from "../desktop/public-update/policy.ts";
// Minimal stored ZIP encoder for synthetic adversarial fixtures, not production.
export function zip(
  entries: { name: string; data?: string; mode?: number; flags?: number }[],
): Buffer {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name),
      data = Buffer.from(e.data || "");
    let crc = 0xffffffff;
    for (const b of data) {
      crc ^= b;
      for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags || 0, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(3 * 256 + 20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(e.flags || 0, 8);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((e.mode ?? 0o100644) * 65536) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(c, name);
    offset += local.length + name.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(Buffer.concat(central).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}
async function fixture(
  entries: Parameters<typeof zip>[0],
  check: (root: string, file: string, m: Manifest) => Promise<void>,
) {
  const root = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "public-zip-"),
  );
  try {
    const bytes = zip(entries),
      file = path.join(root, "update.zip");
    await writeFile(file, bytes, { mode: 0o600 });
    const m = {
      asset: {
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    } as Manifest;
    await check(root, file, m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("safe extraction supports internal framework-style links without following them", async () => {
  await fixture(
    [
      { name: `${APP_NAME}/Contents/Versions/A/file`, data: "safe" },
      {
        name: `${APP_NAME}/Contents/Versions/Current`,
        data: "A",
        mode: 0o120777,
      },
    ],
    async (root, file, m) => {
      const dest = path.join(root, "stage");
      await extractVerifiedZip(file, dest, m, new AbortController().signal);
      assert.equal(
        await readFile(
          path.join(dest, APP_NAME, "Contents/Versions/Current/file"),
          "utf8",
        ),
        "safe",
      );
    },
  );
});
test("archive rejects traversal, case aliases, duplicates, foreign roots, links and encryption", async () => {
  for (const entries of [
    [{ name: `${APP_NAME}/../escape` }],
    [{ name: `${APP_NAME}/A` }, { name: `${APP_NAME}/a` }],
    [{ name: `${APP_NAME}/a` }, { name: `${APP_NAME}/a` }],
    [{ name: "other.app/a" }],
    [{ name: `${APP_NAME}/x`, data: "../../outside", mode: 0o120777 }],
    [
      { name: `${APP_NAME}/x`, data: "y", mode: 0o120777 },
      { name: `${APP_NAME}/x/child` },
    ],
    [{ name: `${APP_NAME}/x`, flags: 1 }],
    [{ name: `${APP_NAME}/._bad` }],
    [{ name: `${APP_NAME}/pipe`, mode: 0o010644 }],
  ])
    await fixture(entries, async (root, file, m) => {
      await assert.rejects(
        extractVerifiedZip(
          file,
          path.join(root, "stage"),
          m,
          new AbortController().signal,
        ),
      );
    });
});
test("hash mismatch is rejected before any extraction and private caches reject foreign links", async () => {
  await fixture([{ name: `${APP_NAME}/a` }], async (root, file, m) => {
    m.asset.sha256 = "0".repeat(64);
    await assert.rejects(
      extractVerifiedZip(
        file,
        path.join(root, "stage"),
        m,
        new AbortController().signal,
      ),
    );
    await symlink(root, path.join(root, "alias"));
    await assert.rejects(privateDirectory(path.join(root, "alias")));
    await writeFile(path.join(root, "sentinel"), "unchanged");
    await assert.rejects(exclusiveFile(path.join(root, "sentinel")));
    assert.equal(
      await readFile(path.join(root, "sentinel"), "utf8"),
      "unchanged",
    );
  });
});
