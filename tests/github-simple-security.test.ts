import { test } from "node:test";
import assert from "node:assert/strict";
import { connectGitHub } from "../src/server/github-simple.ts";
import { GitHubClient, parsePullURL } from "../src/server/github.ts";
import { deleteGitHubSession } from "../src/server/github-session-secrets.ts";
const token = "FAKE-session-secret";
const client =
  (
    status = 200,
    body = '{"login":"alice","id":7}',
    headers = {},
  ): Parameters<typeof connectGitHub>[1] =>
  (c) =>
    new GitHubClient(c, {
      transport: async (url, h) => {
        assert.equal(h.Authorization, "Bearer " + token);
        return { status, body, headers };
      },
    });
test("GHES preserves registered path; unknown version is not invented", async () => {
  const c = await connectGitHub(
    { webUrl: "https://git.corp.example/github", token },
    client(),
  );
  assert.equal(c.apiUrl, "https://git.corp.example/github/api/v3");
  assert.equal(c.serverVersion, undefined);
  assert.deepEqual(
    parsePullURL("https://git.corp.example/github/org/repo/pull/1", c),
    { owner: "org", repo: "repo", number: 1 },
  );
  if (c.auth.kind === "session") deleteGitHubSession(c.auth.sessionId);
});
test("decoded credential reflection and reflected headers are rejected", async () => {
  const escaped = [...token]
    .map((x) => "\\u" + x.charCodeAt(0).toString(16).padStart(4, "0"))
    .join("");
  for (const [body, headers] of [
    [`{"login":"alice","id":7,"nested":{"value":"${escaped}"}}`, {}],
    ['{"login":"alice","id":7}', { "x-test": token }],
  ] as const) {
    await assert.rejects(
      connectGitHub(
        { webUrl: "https://github.com", token },
        client(200, body, headers),
      ),
      (e) => !String(e).includes(token),
    );
  }
});
test("authentication, SSO, proxy and redirect errors never echo remote content", async () => {
  for (const status of [301, 302, 307, 401, 403, 407, 500]) {
    await assert.rejects(
      connectGitHub(
        { webUrl: "https://github.com", token },
        client(status, token, { location: "https://evil.invalid/" + token }),
      ),
      (e) => !String(e).includes(token),
    );
  }
});
test("endpoint validation occurs before credential network use", async () => {
  let calls = 0;
  for (const webUrl of [
    "http://github.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://user:pass@github.com",
    "https://github.com/?token=x",
    "https://github.com:444",
  ]) {
    await assert.rejects(
      connectGitHub({ webUrl, token }, (c) => {
        calls++;
        return new GitHubClient(c);
      }),
    );
  }
  await assert.rejects(
    connectGitHub(
      {
        webUrl: "https://git.corp.example",
        apiUrl: "https://evil.invalid/api/v3",
        token,
      },
      (c) => {
        calls++;
        return new GitHubClient(c);
      },
    ),
  );
  assert.equal(calls, 0);
});
test("Enterprise Cloud tenancy is distinct from Server and uses documented host pairing", async () => {
  const c = await connectGitHub(
    { webUrl: "https://acme.ghe.com", token },
    client(),
  );
  assert.equal(c.type, "ghe-cloud");
  assert.equal(c.apiUrl, "https://api.acme.ghe.com");
  assert.equal(c.serverVersion, undefined);
  if (c.auth.kind === "session") deleteGitHubSession(c.auth.sessionId);
});
test("explicit same-host cloud override is verified rather than followed via redirect", async () => {
  const c = await connectGitHub(
    { webUrl: "https://acme.ghe.com", apiUrl: "https://acme.ghe.com", token },
    client(),
  );
  assert.equal(c.type, "ghe-cloud");
  assert.equal(c.apiUrl, "https://acme.ghe.com");
  if (c.auth.kind === "session") deleteGitHubSession(c.auth.sessionId);
});
test("recursive reflection checks inspect decoded strings rather than re-encoded JSON", async () => {
  const unusual = 'FAKE"\\\\secret';
  for (const value of [
    { nested: { value: unusual } },
    { [unusual]: "value" },
  ]) {
    await assert.rejects(
      connectGitHub(
        { webUrl: "https://github.com", token: unusual },
        (c) =>
          new GitHubClient(c, {
            transport: async () => ({
              status: 200,
              headers: {},
              body: JSON.stringify({ login: "alice", id: 7, ...value }),
            }),
          }),
      ),
      (e) => !String(e).includes(unusual),
    );
  }
});
test("credential reflection in rate-limit header cannot escape via errors", async () => {
  const c = new GitHubClient(
    {
      id: "test",
      type: "github",
      webUrl: "https://github.com",
      apiUrl: "https://api.github.com",
      apiVersion: "2022-11-28",
      account: "alice",
      auth: { kind: "public" },
    },
    {
      credential: async () => token,
      transport: async () => ({
        status: 403,
        body: "{}",
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": token },
      }),
    },
  );
  await assert.rejects(c.request("/user"), (e) => !String(e).includes(token));
});
