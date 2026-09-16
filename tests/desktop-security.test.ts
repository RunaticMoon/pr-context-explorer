import test from "node:test";
import assert from "node:assert/strict";
import * as security from "../desktop/security.ts";

test("desktop backend environment excludes publisher/source credentials and startup injection", () => {
  assert.equal(typeof security.backendEnvironment, "function");
  const env = security.backendEnvironment("/private/app", "/bundle/node", {
    HOME: "/real/home",
    PATH: "/evil",
    GH_TOKEN: "secret",
    NODE_OPTIONS: "--require evil",
    PRCE_AI_CONFIG: "/evil",
  });
  assert.equal(env.HOME, "/private/app/home");
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.PRCE_AI_CONFIG, undefined);
  assert.equal(
    env.PATH,
    "/bundle/node:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  );
});

test("read-only IPC rejects subframes, other windows, navigations and extra payload", () => {
  assert.equal(typeof security.validStatusSender, "function");
  const frame = { url: "http://127.0.0.1:4317/" },
    contents = { mainFrame: frame };
  assert.equal(
    security.validStatusSender(
      { sender: contents, senderFrame: frame },
      contents,
      "http://127.0.0.1:4317",
      [],
    ),
    true,
  );
  for (const [event, args] of [
    [{ sender: contents, senderFrame: { url: frame.url } }, []],
    [{ sender: {}, senderFrame: frame }, []],
    [{ sender: contents, senderFrame: frame }, ["arbitrary"]],
  ])
    assert.equal(
      security.validStatusSender(
        event as any,
        contents,
        "http://127.0.0.1:4317",
        args as any,
      ),
      false,
    );
  frame.url = "https://evil.example/";
  assert.equal(
    security.validStatusSender(
      { sender: contents, senderFrame: frame },
      contents,
      "http://127.0.0.1:4317",
      [],
    ),
    false,
  );
});
test("own app query navigation retains status capability, foreign documents never do", () => {
  const frame = {
    url: "http://127.0.0.1:4317/?page=live-connections&tab=updates",
  };
  const contents = { mainFrame: frame };
  const allowed = () =>
    security.validStatusSender(
      { sender: contents, senderFrame: frame },
      contents,
      "http://127.0.0.1:4317",
      [],
    );
  assert.equal(allowed(), true);
  for (const url of [
    "http://127.0.0.1:4317/evil",
    "http://127.0.0.1:4318/",
    "http://user@127.0.0.1:4317/",
    "file:///index.html",
  ]) {
    frame.url = url;
    assert.equal(allowed(), false);
  }
});
test("signature gate requires deliberate signed build and valid Developer ID same TeamID/identity hardened runtime", () => {
  assert.equal(typeof security.signatureAllowed, "function");
  const metadata =
    "Identifier=com.runaticmoon.pr-context-explorer\nAuthority=Developer ID Application: Example (ABCDE12345)\nTeamIdentifier=ABCDE12345\nCodeDirectory v=20500 size=123 flags=0x10000(runtime)";
  assert.equal(
    security.signatureAllowed(
      true,
      true,
      "darwin",
      "ABCDE12345",
      metadata,
      true,
    ),
    true,
  );
  assert.equal(
    security.signatureAllowed(
      false,
      true,
      "darwin",
      "ABCDE12345",
      metadata,
      true,
    ),
    false,
  );
  assert.equal(
    security.signatureAllowed(
      true,
      true,
      "darwin",
      "DIFFERENT1",
      metadata,
      true,
    ),
    false,
  );
  assert.equal(
    security.signatureAllowed(
      true,
      true,
      "darwin",
      "ABCDE12345",
      metadata,
      false,
    ),
    false,
  );
  assert.equal(
    security.signatureAllowed(
      true,
      true,
      "darwin",
      "ABCDE12345",
      "Signature=adhoc",
      true,
    ),
    false,
  );
});
test("updater permits only repository API and GitHub asset CDN and never forwards authorization cross-host", () => {
  assert.equal(typeof security.updateRequest, "function");
  const headers = {
    Authorization: "token secret",
    Accept: "application/octet-stream",
    Cookie: "secret",
  };
  const api = security.updateRequest(
    "https://api.github.com/repos/RunaticMoon/pr-context-explorer/releases/assets/42",
    headers,
  );
  assert.equal(api.authorization, "token secret");
  const cdn = security.updateRequest(
    "https://release-assets.githubusercontent.com/github-production-release-asset/a?sig=x",
    headers,
  );
  assert.equal(cdn.authorization, undefined);
  assert.equal(cdn.cookie, undefined);
  for (const url of [
    "http://api.github.com/repos/RunaticMoon/pr-context-explorer/releases/latest",
    "https://evil.example/file",
    "https://api.github.com/repos/evil/repo/releases/latest",
    "https://api.github.com:444/repos/RunaticMoon/pr-context-explorer/releases/latest",
    "https://token@api.github.com/repos/RunaticMoon/pr-context-explorer/releases/latest",
  ])
    assert.throws(() => security.updateRequest(url, headers));
});
