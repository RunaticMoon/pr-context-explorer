import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LiveAPI } from "../src/server/live-api.ts";
import { createGitHubCredentialStore } from "../src/server/github-credential-store.ts";

const url = (p: string) => new URL("http://localhost" + p);

/** A LiveAPI whose credential backend never touches the host keychain/files. */
function makeApi(dataDir: string) {
  return new LiveAPI({
    dataDir,
    credentialStore: createGitHubCredentialStore({ dataDir, backend: "off" }),
  });
}

const custom = (id: string, name = "필터", query = "is:open") => ({
  id,
  name,
  query,
});

test("quick filter routes: initial view, save round trip, restart persistence and rejection", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "prce-live-quick-filters-"));
  const dataDir = path.join(root, "data");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const api = makeApi(dataDir);
  t.after(() => api.close());
  {
    const initial = await api.handle(
      "GET",
      url("/api/live/quick-filters"),
      undefined,
    );
    assert.equal(initial?.status, 200);
    const view = initial!.data as any;
    assert.equal(view.builtin.length, 4);
    assert.deepEqual(
      view.builtin.map((f: any) => f.id),
      [
        "builtin-authored",
        "builtin-review-requested",
        "builtin-reviewed-by",
        "builtin-involves",
      ],
    );
    assert.deepEqual(view.custom, []);
  }

  {
    const saved = await api.handle("POST", url("/api/live/quick-filters"), {
      custom: [custom("mine", "내 필터", "author:@me is:open")],
    });
    assert.equal(saved?.status, 200);
    const view = saved!.data as any;
    assert.equal(view.builtin.length, 4);
    assert.deepEqual(view.custom, [
      { id: "mine", name: "내 필터", query: "author:@me is:open" },
    ]);

    const reread = await api.handle(
      "GET",
      url("/api/live/quick-filters"),
      undefined,
    );
    assert.deepEqual((reread!.data as any).custom, view.custom);
  }

  {
    const restarted = makeApi(dataDir);
    t.after(() => restarted.close());
    const view = await restarted.handle(
      "GET",
      url("/api/live/quick-filters"),
      undefined,
    );
    assert.deepEqual((view!.data as any).custom, [
      { id: "mine", name: "내 필터", query: "author:@me is:open" },
    ]);
  }

  {
    // Unknown top-level key is rejected.
    await assert.rejects(
      api.handle("POST", url("/api/live/quick-filters"), {
        custom: [],
        builtin: [],
      }),
      /invalid quick filters/,
    );
    // A builtin- prefixed id is rejected by the module validator.
    await assert.rejects(
      api.handle("POST", url("/api/live/quick-filters"), {
        custom: [custom("builtin-authored")],
      }),
      /invalid quick filters/,
    );
    // More than 50 filters is rejected.
    await assert.rejects(
      api.handle("POST", url("/api/live/quick-filters"), {
        custom: Array.from({ length: 51 }, (_, i) => custom(`f-${i}`)),
      }),
      /invalid quick filters/,
    );
    // The rejected writes must not have replaced the stored filters.
    const view = await api.handle(
      "GET",
      url("/api/live/quick-filters"),
      undefined,
    );
    assert.deepEqual((view!.data as any).custom, [
      { id: "mine", name: "내 필터", query: "author:@me is:open" },
    ]);
  }

  {
    const listed = await api.handle("GET", url("/api/connections"), undefined);
    assert.equal(listed?.status, 200);
    assert.deepEqual((listed!.data as any).connections, []);
  }
});
