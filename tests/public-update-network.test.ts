import test from "node:test";
import assert from "node:assert/strict";
import {
  isPublicAddress,
  chooseRelease,
  validateAssetAgreement,
} from "../desktop/public-update/network.ts";
import { REPOSITORY } from "../desktop/public-update/policy.ts";
const release = (v: string) => ({
  tag_name: `v${v}`,
  draft: false as const,
  prerelease: false as const,
  assets: [
    {
      name: "public-mac.json",
      size: 500,
      state: "uploaded",
      browser_download_url: `https://github.com/${REPOSITORY}/releases/download/v${v}/public-mac.json`,
    },
  ],
});
test("bounded stable release selection chooses semantic maximum, not API order", () => {
  assert.equal(
    chooseRelease(
      [
        release("0.6.0"),
        release("0.10.0"),
        { ...release("9.0.0"), draft: true },
      ],
      "0.5.1",
    )?.tag_name,
    "v0.10.0",
  );
  assert.equal(
    chooseRelease([release("0.5.1"), release("0.4.0")], "0.5.1"),
    null,
  );
  assert.throws(() =>
    chooseRelease([release("0.6.0"), release("0.6.0")], "0.5.1"),
  );
  assert.throws(() =>
    validateAssetAgreement(release("0.6.0"), { name: "absent.zip", size: 123 }),
  );
});
test("DNS rejects reserved IPv4 and IPv6 addresses", () => {
  for (const a of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "192.168.0.1",
    "100.64.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
  ])
    assert.equal(isPublicAddress(a), false, a);
  for (const a of ["140.82.112.3", "185.199.108.133", "2606:50c0:8000::154"])
    assert.equal(isPublicAddress(a), true, a);
});
