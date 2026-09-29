import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PrSearchPanel,
  canSearch,
  formatUpdated,
  isLatestRequest,
  newQuickFilterId,
  planSaveQuickFilter,
  removeQuickFilter,
  upsertQuickFilter,
  withTimeout,
  type QuickFilter,
} from "../src/pr-search-panel.tsx";

const qf = (id: string, name = "필터", query = "is:open"): QuickFilter => ({
  id,
  name,
  query,
});

test("newQuickFilterId uses a base36 timestamp and adds -2, -3 on collisions", () => {
  const now = 1700000000000;
  const base = "qf-" + now.toString(36);
  assert.equal(newQuickFilterId([], now), base);
  assert.equal(newQuickFilterId([base], now), `${base}-2`);
  assert.equal(newQuickFilterId([base, `${base}-2`], now), `${base}-3`);
});

test("newQuickFilterId ignores unrelated ids", () => {
  const now = 1700000000000;
  const base = "qf-" + now.toString(36);
  assert.equal(newQuickFilterId(["other", "qf-zzz"], now), base);
});

test("upsertQuickFilter appends a trimmed filter with a fresh id", () => {
  const next = upsertQuickFilter([], "  내 필터  ", "  author:@me is:open  ");
  assert.equal(next.length, 1);
  assert.equal(next[0].name, "내 필터");
  assert.equal(next[0].query, "author:@me is:open");
  assert.match(next[0].id, /^qf-[a-z0-9]+$/);
});

test("upsertQuickFilter replaces the entry with the given id in place", () => {
  const list = [qf("a", "A", "is:open"), qf("b", "B", "is:closed")];
  const next = upsertQuickFilter(list, "  B2  ", "  is:merged  ", "b");
  assert.equal(next.length, 2);
  assert.deepEqual(
    next.map((f) => f.id),
    ["a", "b"],
  );
  assert.equal(next[1].name, "B2");
  assert.equal(next[1].query, "is:merged");
  // The original list is not mutated.
  assert.equal(list[1].name, "B");
});

test("upsertQuickFilter with an unknown id still inserts (id preserved)", () => {
  const next = upsertQuickFilter([], "새 필터", "is:open", "manual-id");
  assert.deepEqual(next, [qf("manual-id", "새 필터", "is:open")]);
});

test("upsertQuickFilter rejects blank name or query", () => {
  assert.throws(
    () => upsertQuickFilter([], "   ", "is:open"),
    /이름과 쿼리를 입력하세요/,
  );
  assert.throws(
    () => upsertQuickFilter([], "이름", "   "),
    /이름과 쿼리를 입력하세요/,
  );
});

test("upsertQuickFilter rejects adding past 50 filters but allows replacing", () => {
  const full = Array.from({ length: 50 }, (_, i) => qf(`f-${i}`));
  assert.throws(
    () => upsertQuickFilter(full, "하나 더", "is:open"),
    /최대 50개/,
  );
  const replaced = upsertQuickFilter(full, "수정", "is:closed", "f-0");
  assert.equal(replaced.length, 50);
  assert.equal(replaced[0].query, "is:closed");
  // 49 -> 50 is allowed.
  const at49 = full.slice(0, 49);
  assert.equal(upsertQuickFilter(at49, "마지막", "is:open").length, 50);
});

test("removeQuickFilter drops only the matching id", () => {
  const list = [qf("a"), qf("b"), qf("c")];
  const next = removeQuickFilter(list, "b");
  assert.deepEqual(
    next.map((f) => f.id),
    ["a", "c"],
  );
  assert.equal(list.length, 3);
  assert.deepEqual(removeQuickFilter(list, "missing"), list);
});

test("planSaveQuickFilter replaces a same-named entry instead of duplicating it", () => {
  const list = [qf("a", "기존", "is:open")];
  const next = planSaveQuickFilter(list, "  기존  ", "is:closed");
  assert.equal(next.length, 1);
  assert.equal(next[0].id, "a");
  assert.equal(next[0].query, "is:closed");
});

test("planSaveQuickFilter appends a new entry when the name is unknown", () => {
  const next = planSaveQuickFilter([], "새 필터", "is:open");
  assert.equal(next.length, 1);
  assert.equal(next[0].name, "새 필터");
});

test("planSaveQuickFilter computed from the latest list keeps consecutive edits", () => {
  // Simulates two queued quick-filter changes: the second is planned from the
  // result of the first, so neither add is lost.
  const first = planSaveQuickFilter([], "A", "is:open");
  const second = planSaveQuickFilter(first, "B", "is:closed");
  assert.deepEqual(
    second.map((f) => f.name),
    ["A", "B"],
  );
  // Deleting then adding against the newest list drops only the target.
  const afterDelete = removeQuickFilter(second, first[0].id);
  const afterAdd = planSaveQuickFilter(afterDelete, "C", "is:merged");
  assert.deepEqual(
    afterAdd.map((f) => f.name),
    ["B", "C"],
  );
});

test("planSaveQuickFilter still rejects blank input", () => {
  assert.throws(
    () => planSaveQuickFilter([], "   ", "is:open"),
    /이름과 쿼리를 입력하세요/,
  );
});

test("isLatestRequest accepts only the newest sequence", () => {
  assert.equal(isLatestRequest(3, 3), true);
  assert.equal(isLatestRequest(2, 3), false);
  assert.equal(isLatestRequest(1, 1), true);
});

test("formatUpdated returns '' for null/empty/invalid and a local timestamp otherwise", () => {
  assert.equal(formatUpdated(null), "");
  assert.equal(formatUpdated(""), "");
  assert.equal(formatUpdated("not a date"), "");
  assert.match(
    formatUpdated("2026-09-29T05:30:00.000Z"),
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
  );
  // The rendered value uses the local clock, not the raw UTC string.
  const iso = "2026-09-29T05:30:00.000Z";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  assert.equal(
    formatUpdated(iso),
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  );
});

test("PrSearchPanel renders the query input and default query", () => {
  const html = renderToStaticMarkup(
    React.createElement(PrSearchPanel, {
      api: async () => ({ builtin: [], custom: [] }),
      connectionId: "c1",
      disabled: false,
      ready: true,
      run: (fn: () => Promise<void>) => fn(),
      onCapture: () => {},
    }),
  );
  assert.match(html, /data-testid="pr-search-panel"/);
  assert.match(html, /data-testid="pr-search-query"/);
  assert.match(html, /aria-label="PR 검색 쿼리"/);
  assert.match(html, /is:open author:@me/);
  assert.match(html, /인증 사용자 PR 검색/);
  assert.match(html, /검색 문법/);
});

test("PrSearchPanel disables search without a connection", () => {
  const html = renderToStaticMarkup(
    React.createElement(PrSearchPanel, {
      api: async () => ({}),
      connectionId: "",
      disabled: false,
      ready: true,
      run: (fn: () => Promise<void>) => fn(),
      onCapture: () => {},
    }),
  );
  assert.match(html, /disabled=""[^>]*>검색<\/button>/);
});

test("PrSearchPanel disables search until the session is ready", () => {
  const html = renderToStaticMarkup(
    React.createElement(PrSearchPanel, {
      api: async () => ({}),
      connectionId: "c1",
      disabled: false,
      ready: false,
      run: (fn: () => Promise<void>) => fn(),
      onCapture: () => {},
    }),
  );
  assert.match(html, /disabled=""[^>]*>검색<\/button>/);
});

test("canSearch requires a ready session with a connection", () => {
  assert.equal(
    canSearch({
      ready: true,
      connectionId: "c1",
      disabled: false,
      searching: false,
    }),
    true,
  );
  assert.equal(
    canSearch({
      ready: false,
      connectionId: "c1",
      disabled: false,
      searching: false,
    }),
    false,
  );
  assert.equal(
    canSearch({
      ready: true,
      connectionId: "",
      disabled: false,
      searching: false,
    }),
    false,
  );
});

test("canSearch blocks while disabled or already searching", () => {
  assert.equal(
    canSearch({
      ready: true,
      connectionId: "c1",
      disabled: true,
      searching: false,
    }),
    false,
  );
  assert.equal(
    canSearch({
      ready: true,
      connectionId: "c1",
      disabled: false,
      searching: true,
    }),
    false,
  );
});

test("withTimeout resolves when the promise settles in time", async () => {
  const value = await withTimeout(Promise.resolve("ok"), 1000, "timeout");
  assert.equal(value, "ok");
});
test("withTimeout propagates the original rejection", async () => {
  await assert.rejects(
    withTimeout(Promise.reject(Error("boom")), 1000, "timeout"),
    /boom/,
  );
});

test("withTimeout rejects with the message when the promise is too slow", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 5, "검색 시간 초과 · 다시 시도하세요"),
    /검색 시간 초과/,
  );
});
