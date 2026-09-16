import { test } from "node:test";
import assert from "node:assert/strict";
import {
  realpathSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LiveAPI } from "../src/server/live-api.ts";
import { GitHubClient } from "../src/server/github.ts";
const token = "FAKE-human-session-PAT";
test("simple PAT onboarding discovers identity and retains only session credentials", async (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "simple-gh-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls: string[] = [];
  const api = new LiveAPI({
    dataDir: dir,
    client: (c) =>
      new GitHubClient(c, {
        transport: async (url, headers) => {
          calls.push(url);
          assert.equal(headers.Authorization, "Bearer " + token);
          assert.equal(headers["X-GitHub-Api-Version"], "2022-11-28");
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({ login: "alice", id: 7 }),
          };
        },
      }),
  });
  try {
    const r = await api.handle(
      "POST",
      new URL("http://localhost/api/connections/connect"),
      { webUrl: "https://github.com", token },
    );
    assert.equal(r?.status, 201);
    const c = (r!.data as any).connection;
    assert.equal(c.account, "alice");
    assert.equal(c.apiUrl, "https://api.github.com");
    assert.equal(c.credentialState, "session");
    assert.ok(!JSON.stringify(r).includes(token));
    assert.deepEqual(calls, ["https://api.github.com/user"]);
    const reconnected = await api.handle(
      "POST",
      new URL("http://localhost/api/connections/connect"),
      { webUrl: "https://github.com", token },
    );
    assert.deepEqual(
      (reconnected!.data as any).connection,
      c,
      "re-entering a PAT must preserve host/account cache identity",
    );
    for (const f of readdirSync(dir, { recursive: true })) {
      if (String(f).endsWith(".json"))
        assert.ok(
          !readFileSync(path.join(dir, String(f)), "utf8").includes(token),
        );
    }
    api.close();
    const restarted = new LiveAPI({ dataDir: dir });
    const listed = await restarted.handle(
      "GET",
      new URL("http://localhost/api/connections"),
      {},
    );
    assert.equal(
      (listed!.data as any).connections[0].credentialState,
      "required",
    );
    restarted.close();
  } finally {
    api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
