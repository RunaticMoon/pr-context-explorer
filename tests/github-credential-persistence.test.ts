import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LiveAPI } from "../src/server/live-api.ts";
import { GitHubClient } from "../src/server/github.ts";
import {
  createGitHubCredentialStore,
  type GitHubCredentialStore,
} from "../src/server/github-credential-store.ts";
import { githubSessionToken } from "../src/server/github-session-secrets.ts";

const token = "FAKE-persisted-only-PAT";
const url = (p: string) => new URL("http://localhost" + p);

function tempRoot(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "prce-persist-")));
}

/** Deterministic file-backed store regardless of the host platform. */
function fileStore(root: string): {
  store: GitHubCredentialStore;
  dataDir: string;
} {
  const dataDir = path.join(root, "creds");
  return {
    dataDir,
    store: createGitHubCredentialStore({
      dataDir,
      backend: "file",
      platform: "linux",
    }),
  };
}

/** A LiveAPI whose GitHub transport never reaches the network. */
function makeApi(dataDir: string, credentialStore: GitHubCredentialStore) {
  const calls: Array<string | undefined> = [];
  const api = new LiveAPI({
    dataDir,
    credentialStore,
    client: (c) =>
      new GitHubClient(c, {
        transport: async (_u, headers) => {
          calls.push(headers.Authorization);
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({ login: "alice", id: 7 }),
          };
        },
      }),
  });
  return { api, calls };
}

const connect = (api: LiveAPI, body: Record<string, unknown> = {}) =>
  api.handle("POST", url("/api/connections/connect"), {
    webUrl: "https://github.com",
    token,
    ...body,
  });

/** Wraps a healthy file store with a delete() that always rejects. */
function failingDeleteStore(
  base: GitHubCredentialStore,
): GitHubCredentialStore {
  return {
    backend: base.backend,
    load: (id) => base.load(id),
    save: (id, value) => base.save(id, value),
    delete: async () => {
      throw Error("FAKE-credential-delete-failure");
    },
  };
}

test("a remembered PAT is restored as a session across a restart", async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { store, dataDir } = fileStore(root);
  const credentialFile = path.join(dataDir, "github-credentials.json");
  const first = makeApi(dataDir, store);
  try {
    const reply = await connect(first.api);
    assert.equal(reply?.status, 201);
    const conn = (reply!.data as any).connection;
    assert.equal(conn.credentialState, "session");
    assert.equal(conn.remembered, true);
    assert.ok(!JSON.stringify(reply).includes(token), "token never echoed");
    first.api.close();
    assert.ok(existsSync(credentialFile), "PAT persisted to disk");
    assert.equal(statSync(credentialFile).mode & 0o777, 0o600);

    const second = makeApi(dataDir, store);
    try {
      const listed = await second.api.handle(
        "GET",
        url("/api/connections"),
        {},
      );
      const restored = (listed!.data as any).connections.find(
        (c: any) => c.id === conn.id,
      );
      assert.equal(restored.credentialState, "session");
      assert.equal(restored.remembered, true);
      assert.equal(githubSessionToken(restored.auth.sessionId), token);
      // The restored session actually resolves the credential on a request.
      second.calls.length = 0;
      const verified = await second.api.handle(
        "POST",
        url("/api/live/verify"),
        { connectionId: conn.id },
      );
      assert.equal(verified?.status, 200);
      assert.equal(second.calls.at(-1), "Bearer " + token);
    } finally {
      second.api.close();
    }
  } finally {
    first.api.close();
  }
});

test("a corrupt config record does not cancel restoring a healthy remembered connection", async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { store, dataDir } = fileStore(root);
  const first = makeApi(dataDir, store);
  let conn: any;
  try {
    const reply = await connect(first.api);
    conn = (reply!.data as any).connection;
    assert.equal(conn.remembered, true);
  } finally {
    first.api.close();
  }
  // A single unparseable config record sits alongside the healthy one.
  writeFileSync(
    path.join(dataDir, "config", "a".repeat(64) + ".json"),
    "{not valid json",
    { mode: 0o600 },
  );

  const second = makeApi(dataDir, store);
  try {
    // GET /api/connections uses LocalStore.list(), which is out of scope here;
    // verify restore through the per-record read path it must use.
    second.calls.length = 0;
    const verified = await second.api.handle("POST", url("/api/live/verify"), {
      connectionId: conn.id,
    });
    assert.equal(verified?.status, 200);
    assert.equal(second.calls.at(-1), "Bearer " + token);
    assert.equal(githubSessionToken(conn.auth.sessionId), token);
  } finally {
    second.api.close();
  }
});

test("remember:false keeps the PAT in memory and requires re-entry after restart", async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { store, dataDir } = fileStore(root);
  const credentialFile = path.join(dataDir, "github-credentials.json");
  const first = makeApi(dataDir, store);
  try {
    const reply = await connect(first.api, { remember: false });
    assert.equal(reply?.status, 201);
    const conn = (reply!.data as any).connection;
    assert.equal(conn.credentialState, "session");
    assert.equal(conn.remembered, false);
    first.api.close();
    assert.equal(existsSync(credentialFile), false, "nothing persisted");

    const second = makeApi(dataDir, store);
    try {
      const listed = await second.api.handle(
        "GET",
        url("/api/connections"),
        {},
      );
      const restored = (listed!.data as any).connections.find(
        (c: any) => c.id === conn.id,
      );
      assert.equal(restored.credentialState, "required");
      assert.equal(restored.remembered, false);
    } finally {
      second.api.close();
    }
  } finally {
    first.api.close();
  }
});

test("deleting a connection removes the persisted PAT", async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { store, dataDir } = fileStore(root);
  const credentialFile = path.join(dataDir, "github-credentials.json");
  const first = makeApi(dataDir, store);
  try {
    const reply = await connect(first.api);
    const conn = (reply!.data as any).connection;
    assert.ok(existsSync(credentialFile));
    const deleted = await first.api.handle("DELETE", url("/api/connections"), {
      id: conn.id,
    });
    assert.equal(deleted?.status, 200);
    assert.equal(existsSync(credentialFile), false, "credential file removed");
    first.api.close();

    const second = makeApi(dataDir, store);
    try {
      const listed = await second.api.handle(
        "GET",
        url("/api/connections"),
        {},
      );
      assert.equal(
        (listed!.data as any).connections.length,
        0,
        "deleted connection is not restored",
      );
    } finally {
      second.api.close();
    }
  } finally {
    first.api.close();
  }
});

test("remember:false with a failed credential delete still reports remembered:true", async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { store, dataDir } = fileStore(root);
  const first = makeApi(dataDir, failingDeleteStore(store));
  try {
    const reply = await connect(first.api, { remember: false });
    assert.equal(reply?.status, 201);
    const conn = (reply!.data as any).connection;
    // The connection succeeds, but the PAT may still be on disk, so the view
    // must not claim it was forgotten.
    assert.equal(conn.credentialState, "session");
    assert.equal(conn.remembered, true);
    assert.ok(!JSON.stringify(reply).includes(token), "token never echoed");
  } finally {
    first.api.close();
  }
});

test("DELETE reports credentialRemoved:false when the store delete fails", async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { store, dataDir } = fileStore(root);
  const first = makeApi(dataDir, failingDeleteStore(store));
  try {
    const reply = await connect(first.api);
    const conn = (reply!.data as any).connection;
    const deleted = await first.api.handle("DELETE", url("/api/connections"), {
      id: conn.id,
    });
    assert.equal(deleted?.status, 200);
    assert.equal((deleted!.data as any).deleted, true);
    assert.equal((deleted!.data as any).credentialRemoved, false);
    assert.ok(!JSON.stringify(deleted).includes(token), "token never echoed");
  } finally {
    first.api.close();
  }
});

test("a non-boolean remember value fails the connection", async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { store, dataDir } = fileStore(root);
  const api = makeApi(dataDir, store);
  try {
    for (const remember of ["yes", 1, null, {}]) {
      await assert.rejects(
        connect(api.api, { remember: remember as unknown as boolean }),
        /GitHub connection failed/,
      );
    }
    assert.equal(api.calls.length, 0, "validation precedes any network use");
  } finally {
    api.api.close();
  }
});

test("an off credential store never reports a remembered PAT", async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const store = createGitHubCredentialStore({
    dataDir: path.join(root, "off"),
    backend: "off",
  });
  const first = makeApi(dataDir, store);
  try {
    const reply = await connect(first.api);
    assert.equal(reply?.status, 201);
    const conn = (reply!.data as any).connection;
    assert.equal(conn.credentialState, "session");
    assert.equal(conn.remembered, false);
    first.api.close();

    const second = makeApi(dataDir, store);
    try {
      const listed = await second.api.handle(
        "GET",
        url("/api/connections"),
        {},
      );
      const restored = (listed!.data as any).connections.find(
        (c: any) => c.id === conn.id,
      );
      assert.equal(restored.credentialState, "required");
      assert.equal(restored.remembered, false);
    } finally {
      second.api.close();
    }
  } finally {
    first.api.close();
  }
});

test("the persisted PAT is the only secret on disk and no plaintext leaks into metadata", async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { store, dataDir } = fileStore(root);
  const api = makeApi(dataDir, store);
  try {
    await connect(api.api);
    api.api.close();
    for (const name of readdirSync(dataDir, { recursive: true })) {
      const file = path.join(dataDir, String(name));
      if (!String(name).endsWith(".json")) continue;
      // Only the credential store may contain the secret.
      if (file.endsWith("github-credentials.json")) continue;
      assert.ok(
        !readFileSync(file, "utf8").includes(token),
        `secret leaked into ${file}`,
      );
    }
  } finally {
    api.api.close();
  }
});
