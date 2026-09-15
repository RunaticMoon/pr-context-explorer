import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";

test("registered path validation cannot catastrophically backtrack", () => {
  const script = `
    import { JiraCloudAdapter } from './src/server/jira/index.ts';
    try {
      new JiraCloudAdapter({ id: 'test', deployment: 'cloud', accountContextId: 'test',
        webBaseUrl: 'https://jira.test', apiBaseUrl: 'https://jira.test/' + 'a'.repeat(100) + '!' });
      process.exit(2);
    } catch { process.exit(0); }
  `;
  assert.doesNotThrow(() =>
    execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { timeout: 2000, stdio: "pipe" },
    ),
  );
});
import { JiraCloudAdapter } from "../src/server/jira/index.ts";
import type {
  JiraConnection,
  JiraTransport,
  JiraTransportResponse,
} from "../src/server/jira/index.ts";

const connection: JiraConnection = {
  id: "cloud",
  deployment: "cloud",
  accountContextId: "test-only",
  webBaseUrl: "https://team.atlassian.net",
  apiBaseUrl: "https://team.atlassian.net",
  credential: {
    kind: "callback",
    resolve: () => ({ Authorization: "Bearer MOCK-SECRET" }),
  },
};
const raw = {
  id: "1",
  key: "APP-1",
  fields: {
    summary: "Title",
    description: null,
    status: { name: "Open" },
    issuetype: { name: "Story" },
  },
};
const reply = (
  status: number,
  body = JSON.stringify(raw),
  headers: Record<string, string> = {},
): JiraTransportResponse => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: (async function* () {
    yield Buffer.from(body);
  })(),
});

test("deadline is enforced even when a synchronous transport starves timer callbacks", async () => {
  const result = await new JiraCloudAdapter(
    { ...connection, limits: { timeoutMs: 10 } },
    {
      transport: async () => {
        const until = performance.now() + 25;
        while (performance.now() < until) {
          /* Simulate synchronous body/parse work, not real network. */
        }
        return reply(200);
      },
    },
  ).capture("APP-1");
  assert.deepEqual(result, { state: "communication_error", reason: "timeout" });
});

test("reflected credential material is rejected rather than emitted as a source snapshot", async () => {
  const result = await new JiraCloudAdapter(connection, {
    transport: async () =>
      reply(
        200,
        JSON.stringify({
          ...raw,
          fields: { ...raw.fields, summary: "MOCK-SECRET" },
        }),
      ),
  }).capture("APP-1");
  assert.equal(result.state, "communication_error");
  assert.equal(JSON.stringify(result).includes("MOCK-SECRET"), false);
});

test("401/403/404 are indistinguishable without issue-existence leaks; failures never expose response bodies", async () => {
  const results = [];
  for (const status of [401, 403, 404]) {
    const result = await new JiraCloudAdapter(connection, {
      transport: async () =>
        reply(status, '{"error":"MOCK-SECRET internal issue existence"}'),
    }).capture("APP-1");
    assert.equal(result.state, "unknown_or_forbidden");
    results.push(result);
  }
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
  for (const status of [204, 301, 302, 307, 308, 400, 429, 500, 503]) {
    let count = 0;
    const result = await new JiraCloudAdapter(connection, {
      transport: async () => {
        count++;
        return reply(status, "MOCK-SECRET", {
          location: "https://evil.test/steal",
        });
      },
    }).capture("APP-1");
    assert.equal(result.state, "communication_error");
    assert.equal(count, 1);
    assert.equal(JSON.stringify(result).includes("MOCK-SECRET"), false);
  }
  const result = await new JiraCloudAdapter(connection, {
    transport: async () => {
      throw new Error("MOCK-SECRET https://private.example");
    },
  }).capture("APP-1");
  assert.equal(result.state, "communication_error");
  assert.equal(JSON.stringify(result).includes("MOCK-SECRET"), false);
});

test("unconnected credentials do not contact the server and server env credentials are not serialized", async () => {
  let calls = 0;
  const transport: JiraTransport = async () => {
    calls++;
    return reply(200);
  };
  for (const credential of [
    undefined,
    { kind: "callback", resolve: () => null },
    { kind: "callback", resolve: () => ({}) },
    {
      kind: "callback",
      resolve: () => {
        throw new Error("MOCK-SECRET");
      },
    },
    { kind: "env", variable: "JIRA_TEST_MISSING_CREDENTIAL", scheme: "Bearer" },
  ] as const) {
    const result = await new JiraCloudAdapter(
      { ...connection, credential },
      { transport },
    ).capture("APP-1");
    assert.equal(result.state, "unconnected");
    assert.equal(JSON.stringify(result).includes("MOCK-SECRET"), false);
  }
  assert.equal(calls, 0);
  process.env.JIRA_TEST_LOCAL_CREDENTIAL = "MOCK-ENV-ONLY";
  try {
    const result = await new JiraCloudAdapter(
      {
        ...connection,
        credential: {
          kind: "env",
          variable: "JIRA_TEST_LOCAL_CREDENTIAL",
          scheme: "Bearer",
        },
      },
      {
        transport: async (request) => {
          assert.equal(request.headers.authorization, "Bearer MOCK-ENV-ONLY");
          return reply(200);
        },
      },
    ).capture("APP-1");
    assert.equal(result.state, "captured");
    assert.equal(JSON.stringify(result).includes("MOCK-ENV-ONLY"), false);
  } finally {
    delete process.env.JIRA_TEST_LOCAL_CREDENTIAL;
  }
});

test("request identifiers, field IDs, endpoint and credential header configuration fail closed", async () => {
  let called = 0;
  const adapter = new JiraCloudAdapter(connection, {
    transport: async () => {
      called++;
      return reply(200);
    },
  });
  for (const key of [
    "../APP-1",
    "APP-1/evil",
    "%2e%2e",
    "https://evil.test/APP-1",
    "APP-1?fields=*all",
    "APP-01",
    "app-1",
    " APP-1",
    "0",
    "1\n",
  ]) {
    const result = await adapter.capture(key);
    assert.deepEqual(result, {
      state: "communication_error",
      reason: "invalid_issue_identifier",
    });
  }
  assert.equal(called, 0);
  for (const endpoint of [
    "http://jira.test",
    "https://user:pass@jira.test",
    "https://jira.test/%2e%2e",
    "https://jira.test/a/../b",
    "https://jira.test?next=evil",
    "https://jira.test\\@evil.test",
    "https://jira.test#x",
  ]) {
    assert.throws(
      () => new JiraCloudAdapter({ ...connection, apiBaseUrl: endpoint }),
      /endpoint/i,
    );
  }
  assert.throws(
    () => new JiraCloudAdapter({ ...connection, deployment: "data_center" }),
    /deployment/i,
  );
  for (const id of [
    "description",
    "customfield_1&expand=*all",
    "__proto__",
    "customfield_-1",
  ]) {
    assert.throws(
      () =>
        new JiraCloudAdapter({
          ...connection,
          acceptanceCriteriaFields: [{ id }],
        }),
      /field/i,
    );
  }
  const unsafeHeaders: Record<string, string>[] = [
    { Host: "evil.test" },
    { Cookie: "secret" },
    { Authorization: "Bearer x\r\nHost: evil.test" },
    { "Proxy-Authorization": "secret" },
  ];
  for (const headers of unsafeHeaders) {
    const result = await new JiraCloudAdapter(
      {
        ...connection,
        credential: { kind: "callback", resolve: () => headers },
      },
      {
        transport: async () => {
          called++;
          return reply(200);
        },
      },
    ).capture("APP-1");
    assert.equal(result.state, "unconnected");
  }
  assert.equal(called, 0);
  assert.throws(
    () =>
      new JiraCloudAdapter({ ...connection, limits: { timeoutMs: Infinity } }),
    /limit/i,
  );
  assert.throws(
    () =>
      new JiraCloudAdapter({ ...connection, customCaPem: "not a certificate" }),
    /CA/i,
  );
});

test("total deadline covers credential resolution, response headers and slow bodies, with cancellation", async () => {
  const slow = async (): Promise<never> => new Promise(() => {});
  const bounded = { ...connection, limits: { timeoutMs: 35 } };
  const start = performance.now();
  for (const adapter of [
    new JiraCloudAdapter({
      ...bounded,
      credential: { kind: "callback", resolve: slow },
    }),
    new JiraCloudAdapter(bounded, { transport: slow }),
    new JiraCloudAdapter(bounded, {
      transport: async () => ({
        status: 200,
        headers: {},
        body: { [Symbol.asyncIterator]: () => ({ next: slow }) },
      }),
    }),
  ]) {
    const result = await adapter.capture("APP-1");
    assert.deepEqual(result, {
      state: "communication_error",
      reason: "timeout",
    });
  }
  assert.ok(performance.now() - start < 1500);
  const controller = new AbortController();
  const pending = new JiraCloudAdapter(
    { ...connection, limits: { timeoutMs: 5000 } },
    { transport: slow },
  ).capture("APP-1", { signal: controller.signal });
  await delay(5);
  controller.abort();
  assert.deepEqual(await pending, {
    state: "communication_error",
    reason: "cancelled",
  });
});

test("body/schema bounds reject oversized, non-JSON, wrong identity and excessively nested data", async () => {
  const cases: [string, Record<string, string>][] = [
    ["x".repeat(1025), {}],
    [JSON.stringify(raw), { "content-length": "999999" }],
    ["<html>private login</html>", { "content-type": "text/html" }],
    ['{"a":', {}],
    [JSON.stringify({ ...raw, key: "OTHER-1" }), {}],
    [JSON.stringify({ ...raw, id: "../../evil" }), {}],
    [JSON.stringify({ ...raw, fields: { summary: 1 } }), {}],
    [
      '{"id":"1","key":"APP-1","fields":{"summary":"x","description":' +
        "[".repeat(130) +
        "0" +
        "]".repeat(130) +
        "}}",
      {},
    ],
    [JSON.stringify(raw), { "content-encoding": "gzip" }],
  ];
  for (const [body, headers] of cases) {
    const result = await new JiraCloudAdapter(
      { ...connection, limits: { maxResponseBytes: 1024 } },
      { transport: async () => reply(200, body, headers) },
    ).capture("APP-1");
    assert.equal(result.state, "communication_error");
  }
  const byId = await new JiraCloudAdapter(connection, {
    transport: async () => reply(200),
  }).capture("1");
  assert.equal(byId.state, "captured");
});
