import { test } from "node:test";
import assert from "node:assert/strict";
import type { JiraTransportRequest } from "../src/server/jira/types.ts";

const response = (value: unknown, status = 200) => ({
  status,
  headers: { "content-type": "application/json" },
  body: (async function* () {
    yield Buffer.from(JSON.stringify(value));
  })(),
});

test("closing while identity request is pending cannot resurrect session credentials", async () => {
  const { JiraOnboardingSession } =
    await import("../src/server/jira-onboarding.ts");
  let release!: () => void;
  const pending = new Promise<void>((r) => {
    release = r;
  });
  const session = new JiraOnboardingSession({
    transport: async () => {
      await pending;
      return response({ accountId: "account" });
    },
  });
  const connection = session.connect({
    deployment: "cloud",
    webUrl: "https://jira.test",
    authentication: "token",
    email: "a@b.test",
    token: "FAKE-PENDING",
  });
  session.close();
  release();
  await assert.rejects(connection);
});

test("connect reads actual identity and server metadata, keeps Cloud Basic secret session-only", async () => {
  const { JiraOnboardingSession } =
    await import("../src/server/jira-onboarding.ts");
  const calls: JiraTransportRequest[] = [];
  const session = new JiraOnboardingSession({
    transport: async (request) => {
      calls.push(request);
      return response(
        request.url.endsWith("/myself")
          ? { accountId: "actual-account-42" }
          : { version: "1001.0", deploymentType: "Cloud" },
      );
    },
  });
  const result = await session.connect({
    deployment: "cloud",
    webUrl: "https://team.atlassian.net",
    authentication: "token",
    email: "dev@example.test",
    token: "FAKE-TOKEN-ONLY",
  });
  assert.equal(result.summary.status, "connected");
  assert.equal(result.connection.accountContextId, "actual-account-42");
  assert.equal(result.summary.serverVersion, "1001.0");
  assert.equal(result.summary.apiVersion, "3");
  assert.match(result.connection.id, /^jira_[a-f0-9]{32}$/);
  assert.deepEqual(
    calls.map((x) => x.url),
    [
      "https://team.atlassian.net/rest/api/3/myself",
      "https://team.atlassian.net/rest/api/3/serverInfo",
    ],
  );
  const header =
    "Basic " +
    Buffer.from("dev@example.test:FAKE-TOKEN-ONLY").toString("base64");
  assert.equal(calls[0].headers.authorization, header);
  assert.ok(!JSON.stringify(result).includes("FAKE-TOKEN-ONLY"));
  assert.ok(!JSON.stringify(result).includes(header));
  const credential = session.bind(result.connection).credential;
  assert.equal(credential?.kind, "callback");
  session.close();
  if (credential?.kind === "callback")
    assert.equal(
      await credential.resolve({
        connectionId: result.connection.id,
        apiOrigin: "https://team.atlassian.net",
        signal: new AbortController().signal,
      }),
      null,
    );
});

test("DC PAT, explicit anonymous reads and env migration never infer identity or follow another origin", async () => {
  const { JiraOnboardingSession } =
    await import("../src/server/jira-onboarding.ts");
  const calls: JiraTransportRequest[] = [];
  const session = new JiraOnboardingSession({
    transport: async (request) => {
      calls.push(request);
      return response(
        request.url.endsWith("/myself")
          ? { name: "actual-dc-user" }
          : { version: "9.12.1" },
      );
    },
  });
  const dc = await session.connect({
    deployment: "data_center",
    webUrl: "https://jira.test/jira",
    authentication: "token",
    token: "FAKE-PAT",
  });
  assert.equal(dc.connection.accountContextId, "actual-dc-user");
  assert.equal(calls[0].headers.authorization, "Bearer FAKE-PAT");
  assert.equal(calls[0].url, "https://jira.test/jira/rest/api/2/myself");
  const anon = await session.connect({
    deployment: "data_center",
    webUrl: "https://jira.test/jira",
    authentication: "anonymous",
  });
  assert.equal(anon.summary.authentication, "anonymous");
  assert.equal(anon.summary.accountId, null);
  assert.equal(calls.at(-1)?.headers.authorization, undefined);
  assert.equal(anon.connection.authentication, "anonymous");
  const count = calls.length;
  for (const webUrl of [
    "https://api.atlassian.com",
    "https://jira.test/browse/APP-1",
  ])
    await assert.rejects(
      session.connect({
        deployment: "cloud",
        webUrl,
        authentication: "token",
        email: "a@b.test",
        token: "FAKE",
      }),
    );
  await assert.rejects(
    session.connect({
      deployment: "cloud",
      webUrl: "https://jira.test",
      authentication: "token",
      email: "a@b.test",
      token: "FAKE",
      advanced: { apiBaseUrl: "https://other.test" },
    }),
  );
  assert.equal(calls.length, count);
  process.env.PRCE_JIRA_TEST_ONLY = "ENV-FAKE";
  try {
    await session.connect({
      deployment: "data_center",
      webUrl: "https://jira.test",
      authentication: "env",
      advanced: {
        credential: {
          kind: "env",
          variable: "PRCE_JIRA_TEST_ONLY",
          scheme: "Bearer",
        },
      },
    });
    assert.equal(calls.at(-1)?.headers.authorization, "Bearer ENV-FAKE");
  } finally {
    delete process.env.PRCE_JIRA_TEST_ONLY;
    session.close();
  }
});

test("Basic decoded token reflection is rejected before any onboarding metadata leaves session", async () => {
  const { JiraOnboardingSession } =
    await import("../src/server/jira-onboarding.ts");
  const session = new JiraOnboardingSession({
    transport: async () => response({ accountId: "FAKE-RAW-TOKEN" }),
  });
  await assert.rejects(
    session.connect({
      deployment: "cloud",
      webUrl: "https://jira.test",
      authentication: "token",
      email: "a@b.test",
      token: "FAKE-RAW-TOKEN",
    }),
    /credential_reflection/,
  );
});

test("simple Jira maps HTTPS instance to canonical same-host API and preserves Data Center context", async () => {
  const { simpleJiraEndpoint } =
    await import("../src/server/jira-onboarding.ts");
  assert.deepEqual(simpleJiraEndpoint("cloud", "https://TEAM.atlassian.net/"), {
    webBaseUrl: "https://team.atlassian.net",
    apiBaseUrl: "https://team.atlassian.net",
    apiVersion: "3",
  });
  assert.deepEqual(
    simpleJiraEndpoint("data_center", "https://jira.example.test/jira/"),
    {
      webBaseUrl: "https://jira.example.test/jira",
      apiBaseUrl: "https://jira.example.test/jira",
      apiVersion: "2",
    },
  );
  for (const url of [
    "http://jira.test",
    "https://user:secret@jira.test",
    " https://jira.test",
    "https://jira.test/browse/APP-1",
    "https://jira.test/?token=x",
    "https://jira.test/a/../jira",
    "https://jira.test/%2e",
  ]) {
    assert.throws(() => simpleJiraEndpoint("cloud", url));
  }
});
