import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type {
  JiraTransport,
  JiraConnection,
} from "../src/server/jira/index.ts";

export const cloudConfig: JiraConnection = {
  id: "cloud",
  deployment: "cloud",
  webBaseUrl: "https://team.atlassian.net",
  apiBaseUrl: "https://api.atlassian.com/ex/jira/site-id",
  accountContextId: "test-account",
  credential: {
    kind: "callback",
    resolve: () => ({ Authorization: "Bearer MOCK-ONLY" }),
  },
  acceptanceCriteriaFields: [
    { id: "customfield_12345", label: "Acceptance criteria" },
  ],
};
export const issue = {
  id: "1234",
  key: "APP-1",
  self: "https://evil.test/never-follow",
  fields: {
    summary: "Original title",
    description: {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Description, not acceptance criteria" },
          ],
        },
      ],
    },
    status: { id: "1", name: "In Progress" },
    issuetype: { id: "2", name: "Story" },
    updated: "2026-09-13T01:02:03.000+0000",
    customfield_12345: {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "User explicitly wrote this" }],
        },
      ],
    },
  },
};
export function response(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
) {
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    body: (async function* () {
      yield Buffer.from(body);
    })(),
  };
}

test("bounded optional comments, parent and related reads preserve coverage and never follow self URLs", async () => {
  const jira = await import("../src/server/jira/index.ts");
  const calls: URL[] = [];
  const base = {
    ...issue,
    fields: {
      ...issue.fields,
      parent: { id: "200", key: "APP-2", self: "https://evil.test/parent" },
      issuelinks: [
        {
          type: { name: "Blocks" },
          outwardIssue: {
            id: "300",
            key: "APP-3",
            self: "https://evil.test/related",
          },
        },
        { type: { name: "Relates" }, inwardIssue: { id: "400", key: "APP-4" } },
      ],
    },
  };
  const transport: JiraTransport = async (request) => {
    const u = new URL(request.url);
    calls.push(u);
    assert.equal(u.origin, "https://api.atlassian.com");
    if (u.pathname.endsWith("/comment")) {
      assert.equal(u.searchParams.get("maxResults"), "2");
      return response(
        JSON.stringify({
          startAt: 0,
          maxResults: 2,
          total: 3,
          comments: [
            { id: "10", body: "Comment one", updated: "original-time" },
            { id: "11", body: "Comment two" },
          ],
        }),
      );
    }
    if (u.pathname.endsWith("/200"))
      return response(JSON.stringify({ ...issue, id: "200", key: "APP-2" }));
    if (u.pathname.endsWith("/300"))
      return response(JSON.stringify({ ...issue, id: "300", key: "APP-3" }));
    return response(JSON.stringify(base));
  };
  const adapter = new jira.JiraCloudAdapter(cloudConfig, { transport });
  const r = await adapter.capture("APP-1", {
    comments: { maxComments: 2, maxPages: 1 },
    parent: true,
    related: { maxIssues: 1 },
  });
  assert.equal(r.state, "captured");
  if (r.state !== "captured") return;
  assert.equal(calls.length, 4);
  assert.equal(r.snapshot.comments.length, 2);
  assert.equal(r.snapshot.comments[0].body.text, "Comment one");
  assert.equal(
    r.snapshot.comments[0].body.segments[0].pointer,
    "/comments/0/body",
  );
  assert.equal(
    r.snapshot.comments[0].sourceHash,
    r.snapshot.commentPages[0].sourceHash,
  );
  assert.equal(r.snapshot.coverage.comments.state, "partial");
  assert.equal(r.snapshot.coverage.comments.total, 3);
  assert.equal(r.snapshot.coverage.comments.retrieved, 2);
  assert.equal(r.snapshot.coverage.related.state, "partial");
  assert.equal(r.snapshot.coverage.related.total, 2);
  assert.equal(r.snapshot.related[0].result.state, "captured");
  assert.equal(
    r.snapshot.related[0].references[0].pointer,
    "/fields/issuelinks/0/outwardIssue",
  );
  assert.equal(r.snapshot.parent!.result.state, "captured");
  assert.equal(r.snapshot.coverage.parent.state, "complete");
  assert.equal(typeof r.snapshot.captureHash, "string");
  const minimal = await adapter.capture("APP-1");
  assert.notEqual(
    minimal.state === "captured" && minimal.snapshot.captureHash,
    r.snapshot.captureHash,
  );
});

test("optional failures retain the primary issue and pagination does not claim uncollected data", async () => {
  const jira = await import("../src/server/jira/index.ts");
  let calls = 0;
  const adapter = new jira.JiraCloudAdapter(cloudConfig, {
    transport: async (request) => {
      calls++;
      const u = new URL(request.url);
      if (u.pathname.endsWith("/comment")) {
        const startAt = Number(u.searchParams.get("startAt"));
        if (startAt === 0)
          return response(
            JSON.stringify({
              startAt: 0,
              maxResults: 1,
              total: 2,
              comments: [{ id: "10", body: "One" }],
            }),
          );
        return response("private existence details", 403);
      }
      return response(
        JSON.stringify({
          ...issue,
          fields: {
            ...issue.fields,
            parent: { id: "../bad", key: "APP-2" },
            issuelinks: [],
          },
        }),
      );
    },
  });
  const r = await adapter.capture("APP-1", {
    comments: { maxComments: 5, maxPages: 3 },
    parent: true,
    related: { maxIssues: 2 },
  });
  assert.equal(r.state, "captured");
  if (r.state !== "captured") return;
  assert.equal(calls, 3);
  assert.equal(r.snapshot.comments.length, 1);
  assert.equal(r.snapshot.coverage.comments.state, "partial");
  assert.equal(r.snapshot.coverage.comments.reason, "unknown_or_forbidden");
  assert.equal(r.snapshot.coverage.parent.state, "unavailable");
  assert.equal(r.snapshot.coverage.related.state, "complete");
  assert.equal(JSON.stringify(r).includes("private existence"), false);
});

test("capture hashes include comments and field mapping, but exclude local fetchedAt", async () => {
  const jira = await import("../src/server/jira/index.ts");
  let time = "2026-09-14T00:00:00Z",
    commentText = "First comment";
  const transport: JiraTransport = async (request) =>
    response(
      JSON.stringify(
        new URL(request.url).pathname.endsWith("/comment")
          ? {
              startAt: 0,
              maxResults: 1,
              total: 1,
              comments: [{ id: "10", body: commentText }],
            }
          : issue,
      ),
    );
  const adapter = new jira.JiraCloudAdapter(cloudConfig, {
    transport,
    now: () => new Date(time),
  });
  const scope = { comments: { maxComments: 1 } };
  const a = await adapter.capture("APP-1", scope);
  time = "2026-09-15T00:00:00Z";
  const b = await adapter.capture("APP-1", scope);
  assert.ok(a.state === "captured" && b.state === "captured");
  assert.notEqual(a.snapshot.fetchedAt, b.snapshot.fetchedAt);
  assert.equal(a.snapshot.sourceHash, b.snapshot.sourceHash);
  assert.equal(a.snapshot.captureHash, b.snapshot.captureHash);
  commentText = "Updated source";
  const c = await adapter.capture("APP-1", scope);
  assert.ok(c.state === "captured");
  assert.equal(c.snapshot.sourceHash, a.snapshot.sourceHash);
  assert.notEqual(c.snapshot.captureHash, a.snapshot.captureHash);
  const unmapped = await new jira.JiraCloudAdapter(
    { ...cloudConfig, acceptanceCriteriaFields: [] },
    { transport },
  ).capture("APP-1", scope);
  assert.ok(unmapped.state === "captured");
  assert.notEqual(unmapped.snapshot.captureHash, c.snapshot.captureHash);
});

test("optional limits prevent additional transport calls and changing/duplicate comment pages stay partial", async () => {
  const jira = await import("../src/server/jira/index.ts");
  let calls = 0;
  const adapter = new jira.JiraCloudAdapter(cloudConfig, {
    transport: async (request) => {
      calls++;
      if (!new URL(request.url).pathname.endsWith("/comment"))
        return response(JSON.stringify(issue));
      const start = Number(new URL(request.url).searchParams.get("startAt"));
      return response(
        JSON.stringify({
          startAt: start,
          maxResults: 1,
          total: 2,
          comments: [{ id: "10", body: "duplicate across pages" }],
        }),
      );
    },
  });
  for (const scope of [
    { comments: { maxComments: 101 } },
    { comments: { maxComments: 1, maxPages: 999 } },
    { related: { maxIssues: 11 } },
  ]) {
    assert.deepEqual(await adapter.capture("APP-1", scope), {
      state: "communication_error",
      reason: "invalid_capture_options",
    });
  }
  assert.equal(calls, 0);
  const r = await adapter.capture("APP-1", {
    comments: { maxComments: 3, maxPages: 3 },
  });
  assert.ok(r.state === "captured");
  assert.equal(calls, 3);
  assert.equal(r.snapshot.coverage.comments.state, "partial");
  assert.equal(r.snapshot.comments.length, 1);
  assert.equal(r.snapshot.commentPages.length, 1);
  const rawSize = Buffer.byteLength(JSON.stringify(issue));
  const budget = await new jira.JiraCloudAdapter(
    { ...cloudConfig, limits: { maxTotalBytes: rawSize } },
    {
      transport: async (request) =>
        response(
          JSON.stringify(
            new URL(request.url).pathname.endsWith("/comment")
              ? { startAt: 0, total: 0, comments: [] }
              : issue,
          ),
        ),
    },
  ).capture("APP-1", { comments: { maxComments: 1 } });
  assert.ok(budget.state === "captured");
  assert.equal(budget.snapshot.coverage.comments.state, "unavailable");
  assert.equal(budget.snapshot.coverage.comments.reason, "response_too_large");
});

test("Data Center uses v2 schema with literal wiki text and no invented acceptance criteria", async () => {
  const jira = await import("../src/server/jira/index.ts");
  assert.equal(typeof jira.JiraDataCenterAdapter, "function");
  const dcIssue = {
    ...issue,
    fields: {
      ...issue.fields,
      description: "h2. DC source\r\n* original wiki\n",
      customfield_12345: null,
    },
  };
  const dcConfig = {
    ...cloudConfig,
    id: "dc",
    deployment: "data_center" as const,
    webBaseUrl: "https://jira.example.test/jira",
    apiBaseUrl: "https://jira-api.example.test/jira",
  };
  const adapter = new jira.JiraDataCenterAdapter(dcConfig, {
    transport: async (request) => {
      assert.equal(
        new URL(request.url).pathname,
        "/jira/rest/api/2/issue/APP-1",
      );
      return response(JSON.stringify(dcIssue));
    },
  });
  const result = await adapter.capture("APP-1");
  assert.equal(result.state, "captured");
  if (result.state !== "captured") return;
  assert.equal(result.snapshot.deployment, "data_center");
  assert.equal(result.snapshot.description.text, dcIssue.fields.description);
  assert.equal(result.snapshot.description.raw, dcIssue.fields.description);
  assert.equal(
    result.snapshot.acceptanceCriteria[0].document.coverage,
    "empty",
  );
  assert.equal(result.snapshot.acceptanceCriteria[0].document.text, "");
  assert.equal(result.snapshot.identity.host, "https://jira.example.test/jira");
  const noMapping = await new jira.JiraDataCenterAdapter(
    { ...dcConfig, acceptanceCriteriaFields: [] },
    { transport: async () => response(JSON.stringify(dcIssue)) },
  ).capture("APP-1");
  assert.deepEqual(
    noMapping.state === "captured" && noMapping.snapshot.acceptanceCriteria,
    [],
  );
  const wrongSchema = await new jira.JiraCloudAdapter(cloudConfig, {
    transport: async () => response(JSON.stringify(dcIssue)),
  }).capture("APP-1");
  assert.equal(wrongSchema.state, "communication_error");
  assert.throws(
    () => new jira.JiraDataCenterAdapter(cloudConfig),
    /deployment/i,
  );
});

test("Cloud adapter GETs registered v3 endpoint and captures exact sources, IDs and hashes", async () => {
  const jira = await import("../src/server/jira/index.ts");
  assert.equal(typeof jira.JiraCloudAdapter, "function");
  const calls: any[] = [];
  let raw = JSON.stringify(issue, null, 2);
  const transport: JiraTransport = async (request) => {
    calls.push(request);
    return response(raw);
  };
  const adapter = new jira.JiraCloudAdapter(cloudConfig, {
    transport,
    now: () => new Date("2026-09-14T00:00:00.000Z"),
  });
  const result = await adapter.capture("APP-1");
  assert.equal(result.state, "captured");
  if (result.state !== "captured") return;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  const url = new URL(calls[0].url);
  assert.equal(url.origin, "https://api.atlassian.com");
  assert.equal(url.pathname, "/ex/jira/site-id/rest/api/3/issue/APP-1");
  assert.deepEqual(
    url.searchParams.get("fields")!.split(",").sort(),
    [
      "summary",
      "description",
      "status",
      "issuetype",
      "updated",
      "customfield_12345",
    ].sort(),
  );
  assert.equal(calls[0].headers.authorization, "Bearer MOCK-ONLY");
  const s = result.snapshot;
  assert.equal(s.identity.host, "https://team.atlassian.net");
  assert.equal(s.identity.issueId, "1234");
  assert.equal(s.identity.issueKey, "APP-1");
  assert.equal(s.identity.connectionId, "cloud");
  assert.equal(s.identity.accountContextId, "test-account");
  assert.equal(s.webUrl, "https://team.atlassian.net/browse/APP-1");
  assert.equal(s.fetchedAt, "2026-09-14T00:00:00.000Z");
  assert.equal(s.updatedAt, issue.fields.updated);
  assert.equal(s.source.rawResponse, raw);
  assert.deepEqual(s.source.raw, issue);
  assert.equal(s.sourceHash, createHash("sha256").update(raw).digest("hex"));
  assert.equal(s.title.text, "Original title");
  assert.equal(s.description.text, "Description, not acceptance criteria");
  assert.equal(s.status.text, "In Progress");
  assert.equal(s.issueType.text, "Story");
  assert.equal(
    s.acceptanceCriteria[0].document.text,
    "User explicitly wrote this",
  );
  assert.equal(
    s.acceptanceCriteria[0].document.segments[0].pointer,
    "/fields/customfield_12345/content/0/content/0/text",
  );
  assert.equal(JSON.stringify(result).includes("MOCK-ONLY"), false);
  assert.equal(s.coverage.comments.state, "not_requested");
  assert.equal(s.coverage.related.state, "not_requested");
  assert.equal(s.coverage.parent.state, "not_requested");
  const same = await adapter.capture("APP-1");
  assert.equal(
    same.state === "captured" && same.snapshot.sourceHash,
    s.sourceHash,
  );
  raw = JSON.stringify({
    ...issue,
    fields: { ...issue.fields, summary: "Changed source" },
  });
  const changed = await adapter.capture("APP-1");
  assert.notEqual(
    changed.state === "captured" && changed.snapshot.sourceHash,
    s.sourceHash,
  );
});
