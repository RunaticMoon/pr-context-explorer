import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

const sites = [
  {
    id: "cloud",
    deployment: "cloud" as const,
    webBaseUrl: "https://team.atlassian.net",
    apiBaseUrl: "https://team.atlassian.net",
  },
  {
    id: "dc",
    deployment: "data_center" as const,
    webBaseUrl: "https://jira.example.test/jira",
    apiBaseUrl: "https://jira-api.example.test/jira",
  },
];
test("discovery rejects unsafe patterns, hostile URLs, ambiguous registrations and oversized sources", async () => {
  const jira = await import("../src/server/jira/index.ts");
  for (const pattern of [
    "(A+)+",
    "[A-Z]+",
    ".*",
    "[A-Z][A-Z0-9_]{0,99999}",
    "[A-Z][A-Z0-9_]{2,1}",
  ]) {
    assert.throws(
      () =>
        jira.discoverJiraCandidates(
          { title: "APP-1" },
          { ...config, projectKeyPattern: pattern },
        ),
      /pattern/i,
    );
  }
  const valid = jira.discoverJiraCandidates(
    { title: "A-1 APP-2 XAPP-3 APP-4suffix APP-00" },
    { ...config, projectKeyPattern: "[A-Z][A-Z0-9_]{2,3}" },
  );
  assert.deepEqual(
    valid.candidates.map((c) => c.key),
    ["APP-2", "XAPP-3"],
  );
  const hostile = [
    "https://team.atlassian.net.evil.test/browse/APP-1",
    "https://team.atlassian.net@evil.test/browse/APP-2",
    "https://evil.test/APP-3",
    "http://team.atlassian.net/browse/APP-4",
    "https://team.atlassian.net/browse/../../browse/APP-5",
    "https://team.atlassian.net/browse/%2e%2e/browse/APP-6",
    "https://team.atlassian.net/browse/APP-7/extra",
    "https://team.atlassian.net\\@evil.test/browse/APP-8",
    "https://team.atlassian.net/browse/APP-9%2fsecret",
    "javascript://team.atlassian.net/browse/APP-10",
    "https://[invalid/browse/APP-11",
  ];
  const r = jira.discoverJiraCandidates(
    { body: hostile.join("\n"), explicitLinks: hostile },
    config,
  );
  assert.equal(r.candidates.length, 0);
  assert.equal(r.rejectedLinks.length, hostile.length * 2);
  assert.throws(
    () =>
      jira.discoverJiraCandidates(
        {},
        { ...config, sites: [...sites, { ...sites[0], id: "duplicate" }] },
      ),
    /duplicate/i,
  );
  assert.throws(
    () =>
      jira.discoverJiraCandidates(
        {},
        { ...config, projectHosts: { APP: ["missing"] } },
      ),
    /registered/i,
  );
  assert.throws(
    () => jira.discoverJiraCandidates({ title: "a".repeat(1_000_001) }, config),
    /limit/i,
  );
});

test("manual association and exclusion keep original candidates and provenance intact", async () => {
  const jira = await import("../src/server/jira/index.ts");
  assert.equal(typeof jira.addManualJiraCandidate, "function");
  const result = jira.discoverJiraCandidates(
    { title: "UNKNOWN-1 APP-1" },
    config,
  );
  assert.equal(result.candidates[0].connectionId, null);
  const updated = jira.addManualJiraCandidate(
    result,
    { connectionId: "cloud", key: "APP-1", note: "User selected issue" },
    config,
  );
  assert.equal(updated.candidates.length, 2);
  assert.equal(updated.candidates[1].provenance.length, 2);
  assert.equal(result.candidates[1].provenance.length, 1);
  const excluded = jira.setJiraCandidateExcluded(
    updated,
    updated.candidates[1].id,
    true,
  );
  assert.equal(excluded.candidates[1].excluded, true);
  assert.deepEqual(
    excluded.candidates[1].provenance,
    updated.candidates[1].provenance,
  );
  assert.equal(
    jira.setJiraCandidateExcluded(excluded, excluded.candidates[1].id, false)
      .candidates[1].excluded,
    false,
  );
  assert.throws(
    () =>
      jira.addManualJiraCandidate(
        result,
        { connectionId: "cloud", key: "../APP-1" },
        config,
      ),
    /key/i,
  );
  assert.throws(
    () =>
      jira.addManualJiraCandidate(
        result,
        { connectionId: "missing", key: "APP-1" },
        config,
      ),
    /registered/i,
  );
});

const config = { sites, projectHosts: { APP: ["cloud"] } };

test("URL scanning stays bounded for long non-URL tokens", async () => {
  const { discoverJiraCandidates } =
    await import("../src/server/jira/index.ts");
  const start = performance.now();
  const result = discoverJiraCandidates(
    { title: "a".repeat(60_000) + " APP-1" },
    config,
  );
  assert.equal(result.candidates.length, 1);
  assert.ok(
    performance.now() - start < 500,
    "URL scheme matching must not backtrack across entire source",
  );
});

test("discovery preserves every field occurrence and never merges equal keys on different hosts", async () => {
  assert.ok(
    existsSync("src/server/jira/index.ts"),
    "Jira public module is implemented",
  );
  const { discoverJiraCandidates } =
    await import("../src/server/jira/index.ts");
  const result = discoverJiraCandidates(
    {
      title: "APP-1 then APP-1",
      body: "See https://jira.example.test/jira/browse/APP-1",
      branch: "work/APP-1",
      commits: [
        { sha: "abc123", subject: "APP-1 subject", body: "\nAPP-1 body\n" },
      ],
      explicitLinks: ["https://team.atlassian.net/browse/APP-1"],
    },
    config,
  );
  assert.equal(result.candidates.length, 2);
  const cloud = result.candidates.find((c) => c.connectionId === "cloud")!;
  const dc = result.candidates.find((c) => c.connectionId === "dc")!;
  assert.equal(cloud.key, "APP-1");
  assert.equal(cloud.host, "https://team.atlassian.net");
  assert.equal(cloud.provenance.length, 6);
  assert.notEqual(cloud.id, dc.id);
  assert.equal(dc.provenance[0].method, "explicit_link");
  assert.equal(dc.host, "https://jira.example.test/jira");
  for (const c of result.candidates)
    for (const p of c.provenance) {
      const source = result.sources.find((s) => s.id === p.sourceId)!;
      assert.equal(source.text.slice(p.start, p.end), p.matchedText);
    }
  assert.equal(
    result.sources.find((s) => s.fieldPath === "/commits/0/body")!.text,
    "\nAPP-1 body\n",
  );
});
