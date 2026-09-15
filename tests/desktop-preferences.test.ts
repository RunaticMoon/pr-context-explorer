import test from "node:test";
import assert from "node:assert/strict";
import {
  realpathSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  rmSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import * as prefs from "../desktop/preferences.ts";
test("preferences accept only bounded booleans and ignore no unknown keys", () => {
  assert.equal(typeof prefs.validatePreferences, "function");
  assert.deepEqual(
    prefs.validatePreferences({ autoCheck: true, autoDownload: false }),
    { autoCheck: true, autoDownload: false },
  );
  for (const input of [
    { token: "secret" },
    { autoCheck: "yes" },
    { autoCheck: true, autoDownload: false, url: "https://evil" },
    null,
    [],
  ])
    assert.throws(() => prefs.validatePreferences(input));
});
test("credential selection requires owned private nonsymlink bounded file; encryption fails closed", () => {
  assert.equal(typeof prefs.CredentialVault, "function");
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "prce-vault-")));
  const file = path.join(dir, "token"),
    target = path.join(dir, "vault");
  const token = "github_pat_" + "a".repeat(70);
  const crypto = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s.split("").reverse().join("")),
    decryptString: (b: Buffer) => b.toString().split("").reverse().join(""),
  };
  try {
    writeFileSync(file, token, { mode: 0o600 });
    const vault = new prefs.CredentialVault(target, crypto);
    assert.equal(prefs.readSelectedCredential(file), token);
    vault.save(token);
    assert.equal(vault.load(), token);
    assert.ok(!readFileSync(target, "utf8").includes(token));
    chmodSync(file, 0o644);
    assert.throws(() => prefs.readSelectedCredential(file));
    chmodSync(file, 0o600);
    symlinkSync(file, path.join(dir, "link"));
    assert.throws(() => prefs.readSelectedCredential(path.join(dir, "link")));
    const unavailable = new prefs.CredentialVault(target, {
      ...crypto,
      isEncryptionAvailable: () => false,
    });
    assert.throws(() => unavailable.save(token));
    assert.throws(() => unavailable.load());
    vault.clear();
    assert.equal(vault.load(), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
