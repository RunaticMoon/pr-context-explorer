import { test } from "node:test";
import assert from "node:assert/strict";
import { collect } from "../src/server/git.ts";
test("Jira bridge links real normalized sources into a new immutable snapshot, preserving provenance and exclusions", async () => {
  const { discoverForSnapshot, captureForSnapshot, validateJiraSettings } =
    await import("../src/server/source-bridge.ts");
  const d = collect();
  const s = {
    ...d,
    mode: "live",
    jira: null,
    jiraStatus: "unconnected",
    sourceEvidence: [],
    jiraSnapshotHashes: [],
    pr: { ...d.pr, title: "TEAM-12 actual request" },
    coverage: { ...d.coverage },
  } as any;
  const settings = {
    connections: [
      {
        id: "jira",
        deployment: "cloud",
        webBaseUrl: "https://tickets.example.invalid",
        apiBaseUrl: "https://tickets.example.invalid",
        accountContextId: "alice",
        credential: {
          kind: "env",
          variable: "PRCE_JIRA_TOKEN",
          scheme: "Bearer",
        },
        acceptanceCriteriaFields: [{ id: "customfield_10001" }],
      },
    ],
    projectHosts: { TEAM: ["jira"] },
  } as any;
  const discovery = await discoverForSnapshot(s, settings);
  for (const c of discovery.candidates)
    if (c.key !== "TEAM-12") c.excluded = true;
  assert.equal(discovery.candidates[0].key, "TEAM-12");
  assert.equal(discovery.candidates[0].provenance[0].fieldPath, "/title");
  assert.throws(
    () =>
      validateJiraSettings({
        ...settings,
        connections: [
          {
            ...settings.connections[0],
            credential: { kind: "env", variable: "PATH", scheme: "Bearer" },
          },
        ],
      }),
    /PRCE_/,
  );
  const payload = {
    id: "42",
    key: "TEAM-12",
    fields: {
      summary: "Actual issue fixture",
      description: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Literal source" }],
          },
        ],
      },
      status: { name: "Open" },
      issuetype: { name: "Story" },
      updated: "2026-01-01T00:00:00Z",
      customfield_10001: "Reject blank input",
    },
  };
  process.env.PRCE_JIRA_TOKEN = "fixture-only-token";
  try {
    const next = await captureForSnapshot(s, settings, discovery, {
      dependencies: {
        transport: async () => ({
          status: 200,
          headers: { "content-type": "application/json" },
          body: (async function* () {
            yield Buffer.from(JSON.stringify(payload));
          })(),
        }),
      },
    });
    assert.notEqual(next.snapshotId, s.snapshotId);
    assert.equal(
      next.jiraStatus,
      "captured",
      JSON.stringify(next.jiraData?.batch),
    );
    assert.equal(next.jiraSnapshotHashes.length, 1);
    assert.equal(
      next.sourceEvidence.filter((e) => e.sourceKind === "jira").length,
      3,
    );
    assert.ok(
      next.sourceEvidence.some(
        (e) =>
          e.text === "Reject blank input" &&
          e.fieldPath === "/fields/customfield_10001",
      ),
    );
    assert.ok(next.evidence.every((e) => e.snapshotId === next.snapshotId));
    assert.equal(s.jiraStatus, "unconnected");
    const { validateLiveOutput } =
      await import("../src/server/live-analysis.ts");
    const jiraRef = next.sourceEvidence.find((e) => e.sourceKind === "jira")!;
    const output = {
      schemaVersion: "2",
      snapshotId: next.snapshotId,
      analysisStatus: "partial",
      limitations: ["static"],
      missingContext: [],
      statements: [
        {
          text: "Issue source",
          kind: "observed",
          confidence: "medium",
          limitation: "",
          commitSha: next.headSha,
          evidenceIds: [jiraRef.id],
        },
      ],
      steps: [],
      codeExplanations: [],
      requirementMappings: [],
    };
    validateLiveOutput(output, next);
    const forged = structuredClone(next);
    const f = forged.sourceEvidence.find((e) => e.id === jiraRef.id)!;
    f.text = "forged normalized source";
    const { hash } = await import("../src/server/git.ts");
    f.contentHash = hash(f.text);
    assert.throws(() => validateLiveOutput(output, forged), /Jira source/);
  } finally {
    delete process.env.PRCE_JIRA_TOKEN;
  }
});
