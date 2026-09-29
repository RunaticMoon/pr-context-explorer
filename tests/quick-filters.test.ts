import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalStore, cacheKey } from "../src/server/store.ts";
import {
  BUILTIN_QUICK_FILTERS,
  loadQuickFilters,
  quickFiltersView,
  saveQuickFilters,
  validateQuickFilters,
} from "../src/server/quick-filters.ts";

const configKey = () => cacheKey({ quickFilters: "v1" });
const custom = (id: string, name = "필터", query = "is:open") => ({
  id,
  name,
  query,
});

function withStore(run: (store: LocalStore) => void) {
  const root = mkdtempSync(path.join(tmpdir(), "prce-quick-filters-"));
  try {
    run(new LocalStore(path.join(root, "data")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("builtin quick filters expose the four defaults in order", () => {
  assert.deepEqual(
    BUILTIN_QUICK_FILTERS.map((f) => [f.id, f.name, f.query, f.builtin]),
    [
      ["builtin-authored", "내가 작성", "is:open author:@me", true],
      ["builtin-review-requested", "내 리뷰 요청", "is:open review-requested:@me", true],
      ["builtin-reviewed-by", "내가 리뷰함", "reviewed-by:@me", true],
      ["builtin-involves", "나와 관련", "is:open involves:@me", true],
    ],
  );
});

test("empty store loads no custom filters and view separates builtin/custom", () =>
  withStore((store) => {
    assert.deepEqual(loadQuickFilters(store), []);
    const view = quickFiltersView(store);
    assert.equal(view.custom.length, 0);
    assert.equal(view.builtin.length, 4);
    // View must hand out copies, not the shared builtin objects.
    assert.notEqual(view.builtin[0], BUILTIN_QUICK_FILTERS[0]);
    assert.deepEqual(view.builtin[0], BUILTIN_QUICK_FILTERS[0]);
  }));

test("save/load round trip trims fields and omits builtin", () =>
  withStore((store) => {
    const saved = saveQuickFilters(store, [
      { id: "mine", name: "  내 필터  ", query: "  author:@me is:open  " },
    ]);
    assert.deepEqual(saved, [
      { id: "mine", name: "내 필터", query: "author:@me is:open" },
    ]);
    assert.deepEqual(loadQuickFilters(store), saved);
    assert.deepEqual(quickFiltersView(store).custom, saved);
    const raw = store.get<any>("config", configKey());
    assert.equal(raw.kind, "quick-filters");
    assert.equal(raw.version, 1);
    assert.deepEqual(raw.filters, saved);
  }));

test("validate rejects more than 50 filters but accepts exactly 50", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => custom(`f-${i}`));
  assert.equal(validateQuickFilters(many(50)).length, 50);
  assert.throws(() => validateQuickFilters(many(51)), /invalid quick filters/);
});

test("rejects a builtin- prefixed id, invalid ids and duplicates", () =>
  withStore((store) => {
    for (const bad of [
      custom("builtin-authored"),
      custom("UPPER"),
      custom("has_underscore"),
      custom(""),
      custom("a".repeat(65)),
      custom("dup"),
    ]) {
      const input =
        bad.id === "dup"
          ? [custom("dup"), custom("dup")]
          : [bad];
      assert.throws(
        () => validateQuickFilters(input),
        /invalid quick filters/,
        bad.id,
      );
    }
    assert.throws(() => saveQuickFilters(store, [custom("builtin-x")]));
    assert.deepEqual(loadQuickFilters(store), []);
  }));

test("rejects unknown keys on a filter object", () =>
  withStore((store) => {
    assert.throws(() =>
      validateQuickFilters([{ ...custom("ok"), extra: 1 }]),
    );
    // builtin is an allowed but ignored key.
    assert.deepEqual(
      validateQuickFilters([{ ...custom("ok"), builtin: true }]),
      [custom("ok")],
    );
  }));

test("rejects blank, overlong and control-character name/query", () => {
  for (const bad of [
    custom("a", "   "),
    custom("a", "n".repeat(61)),
    custom("a", "ok", "   "),
    custom("a", "ok", "q".repeat(257)),
    custom("a", "bad\x01name"),
    custom("a", "ok", "bad\x7fquery"),
    custom("a", "\t"),
  ])
    assert.throws(
      () => validateQuickFilters([bad]),
      /invalid quick filters/,
      JSON.stringify(bad),
    );
});

test("load returns [] for missing, corrupt or invalid stored values", () =>
  withStore((store) => {
    assert.deepEqual(loadQuickFilters(store), []);
    store.put("config", configKey(), { kind: "quick-filters", version: 2, filters: [] });
    assert.deepEqual(loadQuickFilters(store), []);
    store.put("config", configKey(), { kind: "other", version: 1, filters: [] });
    assert.deepEqual(loadQuickFilters(store), []);
    store.put("config", configKey(), "not an object");
    assert.deepEqual(loadQuickFilters(store), []);
    store.put("config", configKey(), {
      kind: "quick-filters",
      version: 1,
      filters: [{ ...custom("bad"), extra: true }],
    });
    assert.deepEqual(loadQuickFilters(store), []);
  }));

test("saved quick filters are ignored by the config connection listing", () =>
  withStore((store) => {
    const connection = {
      id: "c1",
      webUrl: "https://github.com/acme/repo",
    };
    store.put("config", cacheKey({ connection: connection.id }), connection);
    saveQuickFilters(store, [custom("mine", "내 필터", "author:@me")]);
    const connections = store
      .list<any>("config")
      .map((entry) => entry.value)
      .filter((c) => typeof c.webUrl === "string");
    assert.deepEqual(connections, [connection]);
  }));
