import test from "node:test";
import assert from "node:assert/strict";
import {
  isPublicAddress,
  chooseRelease,
  validateAssetAgreement,
  networkErrorCode,
  createSafeLookup,
} from "../desktop/public-update/network.ts";
import { REPOSITORY, UpdateError } from "../desktop/public-update/policy.ts";
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
test("networkErrorCode keeps update and errno codes, collapses TLS failures, hides messages", () => {
  assert.equal(networkErrorCode(new UpdateError("UNSAFE_DNS")), "UNSAFE_DNS");
  assert.equal(networkErrorCode(new UpdateError("TIMEOUT")), "TIMEOUT");
  assert.equal(
    networkErrorCode(Object.assign(new Error(), { code: "ENOTFOUND" })),
    "ENOTFOUND",
  );
  assert.equal(
    networkErrorCode(Object.assign(new Error(), { code: "EAI_AGAIN" })),
    "EAI_AGAIN",
  );
  assert.equal(
    networkErrorCode(Object.assign(new Error(), { code: "ECONNRESET" })),
    "ECONNRESET",
  );
  for (const code of [
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "ERR_SSL_WRONG_VERSION_NUMBER",
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "HOSTNAME_MISMATCH",
  ])
    assert.equal(
      networkErrorCode(Object.assign(new Error(), { code })),
      "TLS_FAILED",
      code,
    );
  assert.equal(
    networkErrorCode(new Error("socket hang up /Users/me/secret")),
    "NETWORK",
  );
  assert.equal(networkErrorCode({ code: "/Users/me/secret" }), "NETWORK");
});
test("safe lookup preserves DNS errno codes and rejects reserved or mixed addresses", async () => {
  const failing = createSafeLookup(
    fakeLookup([], Object.assign(new Error("lookup x failed"), { code: "ENOTFOUND" })),
  );
  assert.equal(await lookupCode(failing), "ENOTFOUND");
  assert.equal(
    await lookupCode(fakeLookup([{ address: "140.82.112.3", family: 4 }])),
    null,
  );
  for (const addrs of [
    [],
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "198.18.0.1", family: 4 }],
    [{ address: "198.19.255.255", family: 4 }],
    [
      { address: "140.82.112.3", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ],
    [{ address: "2001:db8::1", family: 6 }],
  ])
    assert.equal(await lookupCode(createSafeLookup(fakeLookup(addrs))), "UNSAFE_DNS");
});
type Address = { address: string; family: number };
function fakeLookup(
  addresses: Address[],
  error?: Error,
): typeof import("node:dns").lookup {
  return ((
    _hostname: string,
    _options: unknown,
    callback: (...args: unknown[]) => void,
  ) => {
    callback(error, error ? undefined : addresses);
  }) as unknown as typeof import("node:dns").lookup;
}
function lookupCode(lookup: typeof import("node:dns").lookup): Promise<string | null> {
  return new Promise((resolve) => {
    (lookup as (...args: unknown[]) => void)(
      "example.com",
      { all: false },
      (err: unknown) => {
        if (err == null) resolve(null);
        else if (err instanceof UpdateError) resolve(err.code);
        else resolve((err as { message?: string }).message ?? "ERROR");
      },
    );
  });
}
