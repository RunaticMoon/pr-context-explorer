import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommitTimeline } from "../src/commit-timeline.tsx";
import type { CommitTimelineProps } from "../src/commit-timeline.tsx";
import type { CommitFileChange } from "../src/commit-review.ts";

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

const files: CommitFileChange[] = [
  {
    id: "src/deep/a.ts",
    status: "modified",
    side: "new",
    pathLabel: "src/deep/a.ts",
    notes: ["원문 미확보"],
  },
  {
    id: "src/b.ts",
    status: "added",
    side: "new",
    pathLabel: "b.ts",
    notes: [],
  },
  {
    id: "src/c.ts",
    status: "deleted",
    side: "old",
    pathLabel: "old/c.ts",
    notes: [],
  },
  {
    id: "src/d.ts",
    status: "renamed",
    side: "new",
    pathLabel: "old/d.ts → src/d.ts",
    notes: [],
  },
];

type ExtraProps = Partial<
  Omit<CommitTimelineProps, "commits" | "selectedSha" | "onSelect">
>;

function render(selectedSha: string, extra: ExtraProps = {}) {
  return renderToStaticMarkup(
    React.createElement(CommitTimeline, {
      commits,
      selectedSha,
      onSelect: () => {},
      selectedFiles: [],
      selectedFileId: null,
      onChooseFile: () => {},
      ...extra,
    }),
  );
}

test("commits expose exact accessible names and one pressed state", () => {
  const html = render("cccc2222333344445555");
  assert.match(html, /<nav[^>]*aria-label="커밋 흐름"/);
  assert.match(html, /aria-label="Baseline \(비교 기준\)"/);
  assert.match(html, /aria-label="Phase 1"/);
  assert.match(html, /aria-label="Phase 2"[^>]*aria-pressed="true"/);
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  assert.match(html, /<ol class="commit-timeline-list">/);
  assert.match(html, /class="commit-timeline-title">커밋 흐름</);
  // the old horizontal rail artifacts are gone
  assert.ok(!/커밋 \d+ \/ \d+/.test(html));
  assert.ok(!html.includes("commit-link"));
  assert.match(html, /Git 위상 순서 · 변경 비교는 실제 첫 부모 기준/);
  // baseline badge is B, real commits keep their 1-based numbers
  assert.match(html, /commit-timeline-badge" aria-hidden="true">B</);
  assert.match(html, /commit-timeline-badge" aria-hidden="true">3</);
});

test("stats, subject titles, and baseline suppression", () => {
  const html = render("cccc2222333344445555");
  assert.match(html, /파일 2 · hunk 3 · 부분 diff/);
  assert.match(html, /파일 4 · hunk 7 · 투어 1\/4/);
  assert.ok(!html.includes("파일 9"));
  assert.match(
    html,
    /aria-describedby="commit-timeline-stats-bbbb1111222233334444"/,
  );
  assert.match(html, /id="commit-timeline-stats-bbbb1111222233334444"/);
  assert.match(html, /title="처리 연결"/);
});

test("baseline selection and boundary navigation", () => {
  const html = render("aaaa0000111122223333");
  assert.match(html, /<button[^>]*disabled=""[^>]*>이전 커밋<\/button>/);
  assert.match(html, /<button(?![^>]*disabled)[^>]*>다음 커밋<\/button>/);
  assert.ok(!html.includes("변경 파일 없음"));
  const last = render("dddd3333444455556666");
  assert.match(last, /<button[^>]*disabled=""[^>]*>다음 커밋<\/button>/);
});

test("steps=0 omits the tour text like steps=undefined", () => {
  const html = renderToStaticMarkup(
    React.createElement(CommitTimeline, {
      commits: [
        {
          sha: "eeee4444555566667777",
          label: "Phase 1",
          stats: { changedFiles: 1, hunks: 2, steps: 0, read: 0 },
        },
        {
          sha: "ffff5555666677778888",
          label: "Phase 2",
          stats: { changedFiles: 3, hunks: 5 },
        },
      ],
      selectedSha: "eeee4444555566667777",
      onSelect: () => {},
      selectedFiles: [],
      selectedFileId: null,
      onChooseFile: () => {},
    }),
  );
  assert.match(html, /파일 1 · hunk 2/);
  assert.match(html, /파일 3 · hunk 5/);
  assert.ok(!html.includes("투어"));
});

test("only the selected commit expands its changed files", () => {
  const html = render("cccc2222333344445555", {
    selectedFiles: files,
    selectedFileId: "src/b.ts",
  });
  assert.equal((html.match(/class="commit-timeline-files"/g) || []).length, 1);
  assert.equal(
    (html.match(/class="commit-timeline-file"/g) || []).length,
    files.length,
  );
  // exactly one file is current, and only the selected commit is pressed
  assert.equal((html.match(/aria-current="true"/g) || []).length, 1);
  assert.match(html, /class="commit-timeline-file"[^>]*aria-current="true"/);
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  // status colours are classed per status
  assert.match(html, /commit-timeline-file-status-modified/);
  assert.match(html, /commit-timeline-file-status-added/);
  assert.match(html, /commit-timeline-file-status-deleted/);
  assert.match(html, /commit-timeline-file-status-renamed/);
  // long paths dim the directory and bold the file name
  assert.match(
    html,
    /<span class="commit-timeline-file-dir">src\/deep\/<\/span><b>a\.ts<\/b>/,
  );
  assert.match(
    html,
    /<span class="commit-timeline-file-path"><b>b\.ts<\/b><\/span>/,
  );
  assert.match(html, /class="commit-timeline-file-notes">원문 미확보</);
});

test("non-baseline commit with no changed files shows the empty notice", () => {
  const html = render("dddd3333444455556666", { selectedFiles: [] });
  assert.match(html, /변경 파일 없음/);
  const baseline = render("aaaa0000111122223333", { selectedFiles: [] });
  assert.ok(!baseline.includes("변경 파일 없음"));
});

test("file tools render under the selected commit, not inside its button", () => {
  const html = render("cccc2222333344445555", {
    selectedFiles: files,
    selectedFileId: "src/a.ts",
    fileTools: React.createElement("div", { className: "my-tools" }, "도구"),
  });
  assert.match(
    html,
    /class="commit-timeline-file-tools"><div class="my-tools">/,
  );
  // the changed-file list opens only after the commit button has closed
  assert.match(html, /<\/button><ul class="commit-timeline-files">/);
  const listStart = html.indexOf('<ul class="commit-timeline-files">');
  const commitOpen = html.lastIndexOf("<button", listStart);
  const commitClose = html.indexOf("</button>", commitOpen);
  assert.ok(commitClose >= 0 && commitClose < listStart);
});

test("selection adjusts the rail scrollTop and never uses scrollIntoView", async () => {
  const source = await readFile(
    new URL("../src/commit-timeline.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(!source.includes("scrollIntoView"));
  assert.match(source, /scrollTop/);
  // the file button is wired to onChooseFile
  assert.match(source, /onChooseFile\(file\.id\)/);
  const html = render("cccc2222333344445555");
  assert.match(html, /class="commit-timeline-rail"/);
});
