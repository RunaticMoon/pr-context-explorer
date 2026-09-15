import { test } from "node:test";
import assert from "node:assert/strict";
import type { JiraReadAdapter } from "../src/server/jira/index.ts";

test("documented server integration produces a usable PR-only context without connections", async () => {
  const { buildJiraContext } =
    await import("../artifacts/jira-integration-example.ts");
  const context = await buildJiraContext(
    {
      title: "A PR with no Jira reference",
      commits: [{ sha: "abc", subject: "Change", body: "" }],
    },
    [],
    {},
  );
  assert.equal(context.capture.state, "no_data");
  assert.equal(context.capture.canAnalyzeWithoutJira, true);
  assert.equal(
    context.discovery.sources.find((s) => s.fieldPath === "/commits/0/body")!
      .text,
    "",
  );
});

test("no Jira and unavailable Jira are explicit data states and never block PR-only continuation", async () => {
  const jira = await import("../src/server/jira/index.ts");
  assert.equal(typeof jira.captureJiraCandidates, "function");
  const site = {
    id: "cloud",
    deployment: "cloud" as const,
    webBaseUrl: "https://team.atlassian.net",
    apiBaseUrl: "https://team.atlassian.net",
  };
  const config = { sites: [site], projectHosts: { APP: ["cloud"] } };
  const empty = jira.discoverJiraCandidates({}, config);
  const noData = await jira.captureJiraCandidates(empty.candidates, []);
  assert.equal(noData.state, "no_data");
  assert.equal(noData.canAnalyzeWithoutJira, true);
  const discovered = jira.discoverJiraCandidates(
    { title: "APP-1 UNKNOWN-9 APP-2" },
    config,
  );
  const unconnected = await jira.captureJiraCandidates(
    discovered.candidates,
    [],
  );
  assert.equal(unconnected.state, "unconnected");
  assert.equal(unconnected.items.length, 3);
  assert.equal(unconnected.canAnalyzeWithoutJira, true);
  let calls = 0;
  const adapter: JiraReadAdapter = {
    site,
    capture: async () => {
      calls++;
      return { state: "unknown_or_forbidden", reason: "unknown_or_forbidden" };
    },
  };
  const excluded = jira.setJiraCandidateExcluded(
    discovered,
    discovered.candidates[2].id,
    true,
  );
  const partial = await jira.captureJiraCandidates(excluded.candidates, [
    adapter,
  ]);
  assert.equal(partial.state, "partial");
  assert.equal(calls, 1);
  assert.equal(partial.items[0].result.state, "unknown_or_forbidden");
  assert.deepEqual(partial.excludedCandidateIds, [discovered.candidates[2].id]);
  assert.equal(partial.canAnalyzeWithoutJira, true);
  assert.deepEqual(
    partial.items[0].candidate.provenance,
    discovered.candidates[0].provenance,
  );
  assert.equal(typeof partial.captureHash, "string");
  const hashAgain = await jira.captureJiraCandidates(excluded.candidates, [
    adapter,
  ]);
  assert.equal(hashAgain.captureHash, partial.captureHash);
});

test("batch capture refuses forged host/key bindings, bounds candidate work and contains adapter failures", async () => {
  const jira = await import("../src/server/jira/index.ts");
  assert.equal(typeof jira.captureJiraCandidates, "function");
  const site = {
    id: "cloud",
    deployment: "cloud" as const,
    webBaseUrl: "https://team.atlassian.net",
    apiBaseUrl: "https://team.atlassian.net",
  };
  const candidates = jira.discoverJiraCandidates(
    { title: "APP-1 APP-2 APP-3" },
    { sites: [site], projectHosts: { APP: ["cloud"] } },
  ).candidates;
  let calls = 0;
  const adapter: JiraReadAdapter = {
    site,
    capture: async () => {
      calls++;
      throw new Error("SECRET");
    },
  };
  const result = await jira.captureJiraCandidates(candidates, [adapter], {
    maxCandidates: 1,
  });
  assert.equal(result.state, "partial");
  assert.equal(calls, 1);
  assert.deepEqual(
    result.omittedCandidateIds,
    candidates.slice(1).map((c) => c.id),
  );
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  const forged = { ...candidates[0], host: "https://evil.test" };
  const rejected = await jira.captureJiraCandidates([forged], [adapter]);
  assert.equal(rejected.items[0].result.state, "communication_error");
  assert.equal(calls, 1);
});
