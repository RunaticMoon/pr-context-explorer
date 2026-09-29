import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPullSearchQuery, GitHubClient } from "../src/server/github.ts";
const config = {
  id: "work",
  type: "github" as const,
  webUrl: "https://github.com",
  apiUrl: "https://api.github.com",
  apiVersion: "2022-11-28",
  account: "alice",
  auth: { kind: "env" as const, envName: "PRCE_GITHUB_TOKEN" },
};
const pullSearchResult = (items: unknown[]) => ({
  status: 200,
  headers: {} as Record<string, string>,
  body: JSON.stringify({
    total_count: items.length,
    incomplete_results: false,
    items,
  }),
});
const makeClient = (items: unknown[]) => {
  const calls: string[] = [];
  const client = new GitHubClient(config, {
    credential: async () => "fake-test-token",
    transport: async (url) => {
      calls.push(url);
      if (new URL(url).pathname === "/user")
        return {
          status: 200,
          headers: {} as Record<string, string>,
          body: JSON.stringify({ login: "alice", id: 7 }),
        };
      return pullSearchResult(items);
    },
  });
  return { client, calls };
};

test("buildPullSearchQuery normalizes qualifiers, @me and quoted values", () => {
  assert.equal(
    buildPullSearchQuery(
      'is:open review-requested:@me repo:acme/api label:"needs review"',
      "alice",
    ),
    'is:pr is:open review-requested:alice repo:acme/api label:"needs review"',
  );
  assert.equal(
    buildPullSearchQuery("-author:bot", "alice"),
    "is:pr -author:bot",
  );
  assert.equal(
    buildPullSearchQuery('label:"multi word"', "alice"),
    'is:pr label:"multi word"',
  );
  assert.equal(buildPullSearchQuery("repo:@me", "alice"), "is:pr repo:alice");
  assert.equal(buildPullSearchQuery("Repo:@ME", "alice"), "is:pr repo:alice");
  assert.equal(
    buildPullSearchQuery("plain words", "alice"),
    "is:pr plain words",
  );
});

test("buildPullSearchQuery rejects malformed, unsupported and oversized queries", () => {
  assert.throws(
    () => buildPullSearchQuery('label:"unterminated', "alice"),
    /unbalanced quote/,
  );
  assert.throws(
    () => buildPullSearchQuery("type:issue", "alice"),
    /unsupported search qualifier: type/,
  );
  assert.throws(
    () => buildPullSearchQuery("nope:value", "alice"),
    /unsupported search qualifier: nope/,
  );
  assert.throws(
    () => buildPullSearchQuery("label:", "alice"),
    /invalid search qualifier value/,
  );
  assert.throws(
    () => buildPullSearchQuery('label:"has "quote"', "alice"),
    /invalid search query/,
  );
  assert.throws(
    () => buildPullSearchQuery("label:\\backslash", "alice"),
    /invalid search qualifier value/,
  );
  assert.throws(
    () => buildPullSearchQuery("a".repeat(257), "alice"),
    /invalid search query/,
  );
  assert.throws(
    () => buildPullSearchQuery("bad\u0000query", "alice"),
    /invalid search query/,
  );
  assert.throws(
    () => (buildPullSearchQuery as any)(42, "alice"),
    /invalid search query/,
  );
  assert.throws(
    () => buildPullSearchQuery(Array(31).fill("word").join(" "), "alice"),
    /too many terms/,
  );
  assert.doesNotThrow(() =>
    buildPullSearchQuery(Array(30).fill("word").join(" "), "alice"),
  );
});

test("buildPullSearchQuery validates is/state/draft values", () => {
  assert.throws(
    () => buildPullSearchQuery("is:issue", "alice"),
    /unsupported search qualifier value: is:issue/,
  );
  assert.throws(
    () => buildPullSearchQuery("-is:pr", "alice"),
    /unsupported search qualifier value: is:pr/,
  );
  assert.throws(
    () => buildPullSearchQuery("state:all", "alice"),
    /unsupported search qualifier value: state:all/,
  );
  assert.throws(
    () => buildPullSearchQuery("draft:maybe", "alice"),
    /unsupported search qualifier value: draft:maybe/,
  );
  assert.equal(buildPullSearchQuery("is:merged", "alice"), "is:pr is:merged");
  assert.equal(buildPullSearchQuery("-is:draft", "alice"), "is:pr -is:draft");
  assert.equal(buildPullSearchQuery("is:pr", "alice"), "is:pr is:pr");
  assert.equal(
    buildPullSearchQuery("state:closed draft:true", "alice"),
    "is:pr state:closed draft:true",
  );
  assert.equal(
    buildPullSearchQuery('is:"open" state:OPEN', "alice"),
    'is:pr is:"open" state:OPEN',
  );
});

test("list query mode sends the built query and maps new pull fields", async () => {
  const { client, calls } = makeClient([
    {
      number: 12,
      title: "fixture",
      html_url: "https://github.com/acme/repo/pull/12",
      state: "open",
      draft: false,
      user: { login: "bob" },
      updated_at: "2024-01-02T03:04:05Z",
    },
    {
      number: 13,
      title: "no metadata",
      html_url: "https://github.com/acme/repo/pull/13",
      state: "open",
      draft: true,
    },
  ]);
  const expectedQ =
    'is:pr is:open review-requested:alice repo:acme/api label:"needs review"';
  const result = await client.list({
    tab: "not-a-real-tab" as any,
    query: 'is:open review-requested:@me repo:acme/api label:"needs review"',
    page: 2,
  });
  const search = new URL(calls.find((c) => c.includes("/search/issues"))!);
  assert.equal(search.searchParams.get("q"), expectedQ);
  assert.equal(search.searchParams.get("page"), "2");
  assert.equal(search.searchParams.get("per_page"), "100");
  assert.equal(search.searchParams.get("sort"), "updated");
  assert.equal(search.searchParams.get("order"), "desc");
  assert.equal(result.query, expectedQ);
  assert.equal(result.page, 2);
  assert.deepEqual(result.items, [
    {
      number: 12,
      title: "fixture",
      html_url: "https://github.com/acme/repo/pull/12",
      state: "open",
      draft: false,
      repository: "acme/repo",
      author: "bob",
      updated_at: "2024-01-02T03:04:05Z",
    },
    {
      number: 13,
      title: "no metadata",
      html_url: "https://github.com/acme/repo/pull/13",
      state: "open",
      draft: true,
      repository: "acme/repo",
      author: null,
      updated_at: null,
    },
  ]);
});

test("list query mode skips tab validation but rejects empty query and bad pages", async () => {
  const { client } = makeClient([]);
  assert.equal(
    (await client.list({ tab: "bogus" as any, query: "is:open" })).items.length,
    0,
  );
  await assert.rejects(
    () => client.list({ tab: "authored", query: "   " }),
    /invalid search query: empty/,
  );
  await assert.rejects(
    () => client.list({ tab: "authored", query: "is:open", page: 0 } as any),
    /invalid list page/,
  );
  await assert.rejects(
    () => client.list({ tab: "authored", query: "is:open", page: 11 } as any),
    /invalid list page/,
  );
  await assert.rejects(
    () => client.list({ tab: "authored", query: "type:issue" }),
    /unsupported search qualifier/,
  );
});

test("list legacy mode is unchanged and now reports the sent query", async () => {
  const { client } = makeClient([
    {
      number: 21,
      title: "legacy",
      html_url: "https://github.com/acme/repo/pull/21",
      state: "open",
      draft: false,
    },
  ]);
  const result = await client.list({
    tab: "authored",
    repository: "acme/repo",
    state: "open",
    draft: "false",
    page: 1,
  });
  assert.equal(
    result.query,
    "is:pr author:alice repo:acme/repo is:open draft:false",
  );
  assert.deepEqual(result.items, [
    {
      number: 21,
      title: "legacy",
      html_url: "https://github.com/acme/repo/pull/21",
      state: "open",
      draft: false,
      repository: "acme/repo",
      author: null,
      updated_at: null,
    },
  ]);
});
