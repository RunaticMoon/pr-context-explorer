import { test } from "node:test";
import assert from "node:assert/strict";
export const config = {
  id: "work",
  type: "github" as const,
  webUrl: "https://github.com",
  apiUrl: "https://api.github.com",
  apiVersion: "2022-11-28",
  account: "alice",
  auth: { kind: "env" as const, envName: "PRCE_GITHUB_TOKEN" },
};
test("GitHub explicit endpoint configuration and exact PR URL allowlist", async () => {
  const m = await import("../src/server/github.ts");
  assert.deepEqual(m.validateConnection(config), config);
  assert.deepEqual(
    m.parsePullURL("https://github.com/acme/repo/pull/12", config),
    { owner: "acme", repo: "repo", number: 12 },
  );
  for (const url of [
    "https://evil.invalid/acme/repo/pull/12",
    "https://github.com.evil.invalid/acme/repo/pull/12",
    "http://github.com/acme/repo/pull/12",
    "https://x@github.com/acme/repo/pull/12",
    "https://github.com/acme/repo/pull/12?token=x",
    "https://github.com/acme/repo/pull/01",
  ])
    assert.throws(() => m.parsePullURL(url, config));
  for (const bad of [
    { ...config, apiUrl: "http://api.github.com" },
    { ...config, apiUrl: "https://evil.invalid" },
    { ...config, token: "secret" },
    { ...config, auth: { kind: "env", envName: "PATH" } },
    { ...config, webUrl: "https://127.0.0.1" },
    { ...config, apiVersion: "bad\nheader" },
  ])
    assert.throws(() => m.validateConnection(bad));
  for (const key of [
    "id",
    "account",
    "apiVersion",
    "webUrl",
    "apiUrl",
    "type",
    "auth",
  ]) {
    const incomplete: any = { ...config };
    delete incomplete[key];
    assert.throws(() => m.validateConnection(incomplete), key);
  }
  assert.throws(() =>
    m.parsePullURL(" https://github.com/acme/repo/pull/12", config),
  );
  const ghe = {
    ...config,
    type: "ghes",
    webUrl: "https://git.corp.example",
    apiUrl: "https://git.corp.example/api/v3",
    serverVersion: "3.15",
  };
  assert.equal(m.validateConnection(ghe).type, "ghes");
  assert.throws(() =>
    m.validateConnection({
      ...ghe,
      apiUrl: "https://other.corp.example/api/v3",
    }),
  );
});

test("API PR identity must match requested repository and number", async () => {
  const { GitHubClient } = await import("../src/server/github.ts");
  const metadata = {
    number: 12,
    title: "fixture",
    html_url: "https://github.com/acme/repo/pull/99",
    base: { sha: "a".repeat(40), repo: { full_name: "acme/repo" } },
    head: { sha: "b".repeat(40) },
  };
  const client = new GitHubClient(config, {
    credential: async () => "fake-test-token",
    transport: async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify(metadata),
    }),
  });
  await assert.rejects(
    () => client.pull({ owner: "acme", repo: "repo", number: 12 }),
    /identity/,
  );
  metadata.html_url = "https://github.com/acme/repo/pull/12";
  assert.equal(
    (await client.pull({ owner: "acme", repo: "repo", number: 12 })).number,
    12,
  );
});

test("authenticated identity, bounded search pagination and redirected credentials rejection", async () => {
  const { GitHubClient } = await import("../src/server/github.ts");
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const client = new GitHubClient(config, {
    credential: async () => "fake-test-token",
    transport: async (url, headers) => {
      calls.push({ url, headers });
      const u = new URL(url);
      if (u.pathname === "/user")
        return {
          status: 200,
          headers: {} as Record<string, string>,
          body: JSON.stringify({ login: "alice", id: 7 }),
        };
      return {
        status: 200,
        headers: {
          link: '<https://api.github.com/search/issues?page=2>; rel="next"',
          "x-ratelimit-remaining": "2",
        },
        body: JSON.stringify({
          total_count: 1200,
          incomplete_results: false,
          items: [
            {
              number: 12,
              title: "Actual fixture API title",
              html_url: "https://github.com/acme/repo/pull/12",
              state: "open",
              draft: false,
            },
          ],
        }),
      };
    },
  });
  assert.equal((await client.verify()).login, "alice");
  const result = await client.list({
    tab: "authored",
    repository: "acme/repo",
    state: "open",
    draft: "false",
    page: 1,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.total, 1200);
  assert.equal(result.complete, false);
  assert.equal(result.hasMore, true);
  assert.match(result.limitReason!, /1000/);
  assert.equal(
    new URL(
      calls.find((c) => c.url.includes("/search/issues"))!.url,
    ).searchParams.get("q"),
    "is:pr author:alice repo:acme/repo is:open draft:false",
  );
  assert.equal(calls[0].headers.Authorization, "Bearer fake-test-token");
  const reflected = new GitHubClient(config, {
    credential: async () => "fake-test-token",
    transport: async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ login: "alice", id: 7, echo: "fake-test-token" }),
    }),
  });
  await assert.rejects(() => reflected.verify(), /credential_reflection/);
  const redirect = new GitHubClient(config, {
    credential: async () => "fake-test-token",
    transport: async () => ({
      status: 302,
      headers: { location: "https://evil.invalid" },
      body: "",
    }),
  });
  await assert.rejects(() => redirect.verify(), /redirect/);
  const mismatch = new GitHubClient(config, {
    credential: async () => "fake-test-token",
    transport: async () => ({
      status: 200,
      headers: {},
      body: '{"login":"mallory","id":8}',
    }),
  });
  await assert.rejects(() => mismatch.verify(), /account/);
  const limited = new GitHubClient(config, {
    credential: async () => "fake-test-token",
    transport: async () => ({
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "123" },
      body: "sensitive upstream response",
    }),
  });
  await assert.rejects(() => limited.verify(), /rate_limit/);
});
