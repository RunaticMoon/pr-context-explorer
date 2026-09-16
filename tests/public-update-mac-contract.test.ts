import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  chmod,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";

const script = path.resolve("tests/e2e/public-update-mac.mjs");
test(
  "explicit Mac gate fails closed on unsupported hosts",
  { skip: process.platform === "darwin" && process.arch === "arm64" },
  () => {
    const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /requires macOS arm64/);
  },
);
test("fixture versions are explicit stable upgrades, never silently inferred", async () => {
  const { validateGateInputs } = await import(pathToFileURL(script).href);
  assert.throws(() => validateGateInputs({}), /PRCE_PUBLIC_UPDATE_CI/);
  const env = {
    CI: "true",
    PRCE_PUBLIC_UPDATE_CI: "1",
    PRCE_PUBLIC_UPDATE_ZIP: "/tmp/final.zip",
    PRCE_PUBLIC_UPDATE_MANIFEST: "/tmp/public.json",
    PRCE_PUBLIC_UPDATE_OLD_VERSION: "0.5.99",
  };
  assert.equal(validateGateInputs(env).oldVersion, "0.5.99");
  assert.throws(() => validateGateInputs({ ...env, CI: "" }), /dedicated CI/);
  assert.throws(
    () =>
      validateGateInputs({ ...env, PRCE_PUBLIC_UPDATE_OLD_VERSION: "v0.5.99" }),
    /stable fixture version/,
  );
  assert.throws(
    () => validateGateInputs({ ...env, PRCE_PUBLIC_UPDATE_MANIFEST: "" }),
    /manifest/,
  );
});

test("bundle comparison detects resource, signature, executable and symlink mutations", async () => {
  const { treeDigest } = await import(pathToFileURL(script).href);
  const root = await mkdtemp(path.join(tmpdir(), "prce-gate-contract-"));
  try {
    await mkdir(path.join(root, "_CodeSignature"));
    const resource = path.join(root, "resource");
    await writeFile(resource, "original", { mode: 0o600 });
    await writeFile(
      path.join(root, "_CodeSignature/CodeResources"),
      "signature",
    );
    await symlink("resource", path.join(root, "link"));
    const original = await treeDigest(root);
    await chmod(resource, 0o644);
    assert.equal(
      await treeDigest(root),
      original,
      "restricted extraction modes are not byte mutations",
    );
    await writeFile(resource, "changed");
    assert.notEqual(await treeDigest(root), original);
    await writeFile(resource, "original");
    await chmod(resource, 0o700);
    assert.notEqual(await treeDigest(root), original);
    await chmod(resource, 0o600);
    await rm(path.join(root, "link"));
    await symlink("_CodeSignature/CodeResources", path.join(root, "link"));
    assert.notEqual(await treeDigest(root), original);
    await rm(path.join(root, "link"));
    await symlink("resource", path.join(root, "link"));
    await writeFile(
      path.join(root, "_CodeSignature/CodeResources"),
      "resigned",
    );
    assert.notEqual(await treeDigest(root), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
