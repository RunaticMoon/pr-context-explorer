import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommitTimeline } from "../src/commit-timeline.tsx";

const commits = [
  {
    sha: "aaaa0000111122223333",
    label: "Baseline (비교 기준)",
    subject: "merge base",
    baseline: true,
    stats: { changedFiles: 9, hunks: 9 },
  },
  {
    sha: "bbbb1111222233334444",
    label: "Phase 1",
    subject: "입력 규칙",
    stats: { changedFiles: 2, hunks: 3, partial: true },
  },
  {
    sha: "cccc2222333344445555",
    label: "Phase 2",
    subject: "처리 연결",
    stats: { changedFiles: 4, hunks: 7, steps: 4, read: 1 },
  },
  {
    sha: "dddd3333444455556666",
    label: "Phase 3",
    subject: "테스트 보강",
  },
];

function render(selectedSha: string) {
  return renderToStaticMarkup(
    React.createElement(CommitTimeline, {
      commits,
      selectedSha,
      onSelect: () => {},
    }),
  );
}

test("cards expose exact accessible names and pressed state", () => {
  const html = render("cccc2222333344445555");
  assert.match(html, /<nav[^>]*aria-label="커밋 흐름"/);
  assert.match(html, /aria-label="Baseline \(비교 기준\)"/);
  assert.match(html, /aria-label="Phase 1"/);
  assert.match(html, /aria-label="Phase 2"[^>]*aria-pressed="true"/);
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  assert.equal((html.match(/class="commit-link"/g) || []).length, 3);
  assert.match(html, /Git 위상 순서 · 변경 비교는 실제 첫 부모 기준/);
});

test("position text, stats, and baseline suppression", () => {
  const html = render("cccc2222333344445555");
  assert.match(html, /커밋 2 \/ 3/);
  assert.match(html, /파일 2 · hunk 3 · 부분 diff/);
  assert.match(html, /파일 4 · hunk 7 · 투어 1\/4/);
  assert.ok(!html.includes("파일 9"));
  assert.match(html, /aria-describedby="commit-timeline-stats-bbbb1111222233334444"/);
  assert.match(html, /id="commit-timeline-stats-bbbb1111222233334444"/);
});

test("baseline selection and boundary navigation", () => {
  const html = render("aaaa0000111122223333");
  assert.match(html, /Baseline · 비교 기준/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>이전 커밋<\/button>/);
  assert.match(html, /<button(?![^>]*disabled)[^>]*>다음 커밋<\/button>/);
  const last = render("dddd3333444455556666");
  assert.match(last, /<button[^>]*disabled=""[^>]*>다음 커밋<\/button>/);
  assert.match(last, /커밋 3 \/ 3/);
});
