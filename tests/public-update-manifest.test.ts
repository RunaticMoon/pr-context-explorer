import test from "node:test";
import assert from "node:assert/strict";
import {
  parseJSON,
  validateManifest,
  compareVersions,
  validateURL,
  REPOSITORY,
} from "../desktop/public-update/policy.ts";
const manifest = () => ({
  schemaVersion: 1,
  channel: "public-personal-unsigned",
  repository: REPOSITORY,
  version: "0.6.0",
  tag: "v0.6.0",
  sourceCommit: "a".repeat(40),
  platform: "darwin",
  arch: "arm64",
  asset: {
    name: "PR-Context-Explorer-0.6.0-arm64.zip",
    size: 123,
    sha256: "b".repeat(64),
  },
});
test("strict manifest accepts exact public contract only", () => {
  assert.equal(validateManifest(manifest(), "v0.6.0").version, "0.6.0");
  for (const bad of [
    { ...manifest(), token: "secret" },
    { ...manifest(), version: "01.6.0" },
    { ...manifest(), channel: "signed" },
    { ...manifest(), sourceCommit: "x" },
    { ...manifest(), asset: { ...manifest().asset, size: 0 } },
    { ...manifest(), asset: { ...manifest().asset, url: "https://evil.test" } },
  ])
    assert.throws(() => validateManifest(bad, "v0.6.0"));
  assert.throws(() => validateManifest(manifest(), "v0.7.0"));
});
test("stable numerical version comparison rejects invalid versions", () => {
  assert.equal(compareVersions("0.10.0", "0.6.0"), 1);
  assert.equal(compareVersions("0.5.1", "0.6.0"), -1);
  assert.equal(compareVersions("0.6.0", "0.6.0"), 0);
  for (const x of [
    "v1.0.0",
    "1.0.0-beta",
    "1.0.0+build",
    "999999999999999999.0.0",
  ])
    assert.throws(() => compareVersions(x, "0.6.0"));
});
test("fixed HTTPS authority and asset redirect allowlist", () => {
  assert.doesNotThrow(() =>
    validateURL(
      `https://github.com/${REPOSITORY}/releases/download/v0.6.0/public-mac.json`,
      "asset",
    ),
  );
  assert.doesNotThrow(() =>
    validateURL(
      "https://release-assets.githubusercontent.com/github-production-release-asset/a?sig=1",
      "redirect",
    ),
  );
  for (const x of [
    "http://github.com/a",
    "https://github.com.evil.test/a",
    "https://127.0.0.1/a",
    "https://user@github.com/a",
    "https://release-assets.githubusercontent.com:444/a",
    "https://evil.githubusercontent.com/a",
    "https://github.com/other/repo/releases/download/x/a",
  ])
    assert.throws(() => validateURL(x, "asset"));
});

test("remote JSON rejects duplicate keys, invalid UTF8 and excessive nesting", () => {
  assert.equal((parseJSON(Buffer.from('{"x":1}')) as { x: number }).x, 1);
  for (const text of [
    '{"x":1,"x":2}',
    '{"a":{"x":1,"\\u0078":2}}',
    "[".repeat(30) + "0" + "]".repeat(30),
    "{} trailing",
  ])
    assert.throws(() => parseJSON(Buffer.from(text)));
  assert.throws(() => parseJSON(Buffer.from([0x22, 0xff, 0x22])));
});
