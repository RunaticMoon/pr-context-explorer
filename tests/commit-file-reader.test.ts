import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CommitFileReader,
  hunksForFile,
  type CommitFileReaderProps,
  type ReaderFile,
} from "../src/commit-file-reader.tsx";
import type { Hunk } from "../src/server/git.ts";

function makeHunk(overrides: Partial<Hunk> = {}): Hunk {
  return {
    id: "h1",
    header: "@@ -10,3 +20,4 @@",
    oldPath: "src/a.ts",
    newPath: "src/a.ts",
    oldSha: "oldsha",
    newSha: "newsha",
    oldStart: 10,
    oldCount: 3,
    newStart: 20,
    newCount: 4,
    text: [
      "@@ -10,3 +20,4 @@",
      " context",
      "-removed",
      "+added1",
      "+added2",
      " tail",
    ].join("\n"),
    ...overrides,
  };
}

function baseFile(overrides: Partial<ReaderFile> = {}): ReaderFile {
  return {
    id: "f1",
    path: "src/a.ts",
    status: "modified",
    oldPath: "src/a.ts",
    content: "one\ntwo\nthree\n",
    oldContent: "one\nTWO\nthree\n",
    retrieved: true,
    ...overrides,
  };
}

function props(
  overrides: Partial<CommitFileReaderProps> = {},
): CommitFileReaderProps {
  return {
    file: baseFile(),
    commitSha: "abcdef1234567890abcd",
    comparisonSha: "999888777666555444",
    hunks: [makeHunk()],
    partial: false,
    view: "diff",
    onViewChange: () => {},
    selection: { side: "new", start: null, end: null },
    onSelectLine: () => {},
    position: { index: 2, total: 5 },
    ...overrides,
  };
}

function render(p: CommitFileReaderProps) {
  return renderToStaticMarkup(React.createElement(CommitFileReader, p));
}

type El = React.ReactElement<Record<string, any>>;

/** Collect the React element tree of a directly-called (hook-free) component. */
function elements(node: React.ReactNode, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
    return out;
  }
  if (React.isValidElement(node)) {
    out.push(node as El);
    elements((node.props as { children?: React.ReactNode }).children, out);
  }
  return out;
}

function buttonByText(tree: React.ReactElement, text: string) {
  return elements(tree).find(
    (e) => e.type === "button" && e.props.children === text,
  );
}

// ---------------------------------------------------------------------------
// hunksForFile
// ---------------------------------------------------------------------------

test("hunksForFile matches modified, added, deleted, and renamed paths", () => {
  const hunks = [
    makeHunk({ id: "m", oldPath: "src/a.ts", newPath: "src/a.ts" }),
    makeHunk({ id: "a", oldPath: null, newPath: "src/new.ts" }),
    makeHunk({ id: "d", oldPath: "src/gone.ts", newPath: null }),
    makeHunk({ id: "r", oldPath: "src/old.ts", newPath: "src/moved.ts" }),
    makeHunk({ id: "o", oldPath: "src/other.ts", newPath: "src/other.ts" }),
  ];
  const ids = (file: Parameters<typeof hunksForFile>[1]): string[] =>
    hunksForFile(hunks, file).map((h) => h.id);
  assert.deepEqual(
    ids({ path: "src/a.ts", oldPath: "src/a.ts", status: "modified" }),
    ["m"],
  );
  assert.deepEqual(
    ids({ path: "src/new.ts", oldPath: null, status: "added" }),
    ["a"],
  );
  assert.deepEqual(
    ids({ path: "src/gone.ts", oldPath: "src/gone.ts", status: "deleted" }),
    ["d"],
  );
  assert.deepEqual(
    ids({ path: "src/moved.ts", oldPath: "src/old.ts", status: "renamed" }),
    ["r"],
  );
  assert.deepEqual(
    ids({ path: "src/none.ts", oldPath: null, status: "added" }),
    [],
  );
});

test("hunksForFile normalizes a/ and b/ prefixes", () => {
  const prefixed = makeHunk({
    id: "p",
    oldPath: "a/src/a.ts",
    newPath: "b/src/a.ts",
  });
  const plain = makeHunk({ id: "q", oldPath: "src/a.ts", newPath: "src/a.ts" });
  assert.deepEqual(
    hunksForFile([prefixed, plain], {
      path: "src/a.ts",
      oldPath: "src/a.ts",
      status: "modified",
    }).map((h) => h.id),
    ["p", "q"],
  );
});

// ---------------------------------------------------------------------------
// header
// ---------------------------------------------------------------------------

test("renders path, status badge, position, and rename evidence", () => {
  const html = render(
    props({
      file: baseFile({
        status: "renamed",
        path: "src/new.ts",
        oldPath: "src/old.ts",
        renameEvidence: "git diff -M R100",
        lineage: "L-7",
      }),
      position: { index: 2, total: 5 },
    }),
  );
  assert.match(html, /commit-file-reader-dir">src\//);
  assert.match(html, /commit-file-reader-name">new\.ts<\/b>/);
  assert.match(html, /commit-file-reader-status-renamed/);
  assert.match(html, /파일 2 \/ 5/);
  assert.match(html, /src\/old\.ts/);
  assert.match(html, /git diff -M R100/);
  assert.match(html, /lineage L-7/);
});

test("baseline position hides the position line", () => {
  const html = render(props({ position: null }));
  assert.doesNotMatch(html, /파일 \d+ \/ \d+/);
});

test("shows omission and partial warnings", () => {
  const html = render(
    props({
      file: baseFile({ omission: "README.md: 정적 관계 미지원" }),
      partial: true,
    }),
  );
  assert.match(
    html,
    /원문 정책 제외: README\.md: 정적 관계 미지원\. 빈 내용으로 분석하지 않았습니다\./,
  );
  assert.match(html, /부분 diff · 일부 변경만 캡처되었을 수 있습니다/);
});

// ---------------------------------------------------------------------------
// diff view
// ---------------------------------------------------------------------------

test("diff view renders hunk header, line classes, and counted line numbers", () => {
  const html = render(props());
  assert.match(html, /commit-file-reader-hunk-header">@@ -10,3 \+20,4 @@/);
  assert.match(html, /commit-file-reader-line-ctx/);
  assert.match(html, /commit-file-reader-line-del/);
  assert.match(html, /commit-file-reader-line-add/);
  // ctx old10/new20, del old11, add new21, add new22, ctx old12/new23
  for (const n of [10, 11, 12, 20, 21, 22, 23])
    assert.match(html, new RegExp(`>${n}</button>`));
});

test("no-newline marker gets no numbers and is not clickable", () => {
  const html = render(
    props({
      hunks: [
        makeHunk({
          text: [
            "@@ -1,1 +1,1 @@",
            "-old",
            "+new",
            "\\ No newline at end of file",
          ].join("\n"),
          oldStart: 1,
          newStart: 1,
          oldCount: 1,
          newCount: 1,
        }),
      ],
    }),
  );
  assert.match(html, /commit-file-reader-line-meta/);
  // Only the del/add rows carry a click target; the meta row has no number cell.
  assert.equal((html.match(/data-select-line=/g) || []).length, 2);
});

test("deleted line click selects the old side with the old number", () => {
  const calls: { side: string; line: number; extend: boolean }[] = [];
  const tree = CommitFileReader(
    props({
      onSelectLine: (side, line, extend) => calls.push({ side, line, extend }),
    }),
  );
  const delRow = elements(tree).find((e) =>
    String(e.props.className || "").includes("commit-file-reader-line-del"),
  )!;
  assert.equal(delRow.props["data-select-side"], "old");
  assert.equal(delRow.props["data-select-line"], 11);
  const enabled = elements(delRow).find(
    (e) => e.type === "button" && e.props.disabled === false,
  )!;
  enabled.props.onClick({ shiftKey: true });
  assert.deepEqual(calls, [{ side: "old", line: 11, extend: true }]);
});

test("added and context lines select the new side", () => {
  const calls: { side: string; line: number; extend: boolean }[] = [];
  const tree = CommitFileReader(
    props({
      onSelectLine: (side, line, extend) => calls.push({ side, line, extend }),
    }),
  );
  const addRow = elements(tree).find((e) =>
    String(e.props.className || "").includes("commit-file-reader-line-add"),
  )!;
  assert.equal(addRow.props["data-select-side"], "new");
  assert.equal(addRow.props["data-select-line"], 21);
  const ctxRow = elements(tree).find((e) =>
    String(e.props.className || "").includes("commit-file-reader-line-ctx"),
  )!;
  assert.equal(ctxRow.props["data-select-side"], "new");
  assert.equal(ctxRow.props["data-select-line"], 20);
  const addButton = elements(addRow).find(
    (e) => e.type === "button" && e.props.disabled === false,
  )!;
  addButton.props.onClick({ shiftKey: false });
  assert.deepEqual(calls, [{ side: "new", line: 21, extend: false }]);
});

test("selection range highlights matching rows in diff view", () => {
  const html = render(
    props({ selection: { side: "new", start: 21, end: 22 } }),
  );
  const highlighted = html.match(/commit-file-reader-line-highlight/g) || [];
  assert.equal(highlighted.length, 2);
  assert.match(html, /data-select-line="21"[^>]*>|data-select-line="21"/);
});

test("empty diff shows the not-conclusive notice and a full-view hint", () => {
  const calls: string[] = [];
  const tree = CommitFileReader(
    props({ hunks: [], onViewChange: (v) => calls.push(v) }),
  );
  const html = renderToStaticMarkup(tree);
  assert.match(
    html,
    /표시할 변경 구간 없음 · binary·mode 변경·rename만이거나 수집되지 않았을 수 있습니다/,
  );
  const hint = buttonByText(tree, "전체 원문 보기")!;
  assert.ok(hint);
  hint.props.onClick();
  assert.deepEqual(calls, ["full"]);
});

// ---------------------------------------------------------------------------
// view toggle
// ---------------------------------------------------------------------------

test("view toggle reflects the active view and reports changes", () => {
  const calls: string[] = [];
  const tree = CommitFileReader(
    props({ view: "diff", onViewChange: (v) => calls.push(v) }),
  );
  assert.equal(buttonByText(tree, "변경 구간")!.props["aria-pressed"], true);
  assert.equal(buttonByText(tree, "전체 원문")!.props["aria-pressed"], false);
  buttonByText(tree, "전체 원문")!.props.onClick();
  assert.deepEqual(calls, ["full"]);
});

// ---------------------------------------------------------------------------
// full view
// ---------------------------------------------------------------------------

test("full view renders both sides with shas, .line buttons, and hint", () => {
  const html = render(props({ view: "full" }));
  assert.match(html, /data-testid="live-code-old"/);
  assert.match(html, /data-testid="live-code-new"/);
  assert.match(html, /old · 999888777666/);
  assert.match(html, /new · abcdef123456/);
  assert.match(html, /class="line"/);
  assert.match(
    html,
    /라인 클릭 \/ Shift\+클릭으로 범위 선택\. 선택 SHA\/side\/라인 범위와 함께 PR·Jira 원문 및 해당 커밋 원문 문맥이 전송될 수 있습니다\./,
  );
});

test("full view shows the null-side notice for a deleted file", () => {
  const html = render(
    props({
      view: "full",
      file: baseFile({
        status: "deleted",
        path: "src/gone.ts",
        oldPath: "src/gone.ts",
        content: null,
        oldContent: "gone\n",
      }),
    }),
  );
  const newPane = html.slice(html.indexOf('data-testid="live-code-new"'));
  assert.match(newPane, /이 side에 내용 없음 \/ 확보 안 됨/);
});

test("full view shows the null-side notice when content was not retrieved", () => {
  const html = render(
    props({
      view: "full",
      file: baseFile({ retrieved: false, content: null }),
    }),
  );
  const newPane = html.slice(html.indexOf('data-testid="live-code-new"'));
  assert.match(newPane, /이 side에 내용 없음 \/ 확보 안 됨/);
});

test("full view line click reports side, number, and shift state", () => {
  const calls: { side: string; line: number; extend: boolean }[] = [];
  const tree = CommitFileReader(
    props({
      view: "full",
      onSelectLine: (side, line, extend) => calls.push({ side, line, extend }),
    }),
  );
  const lineButtons = elements(tree).filter(
    (e) => e.type === "button" && e.props.className === "line",
  );
  // old pane has 3 lines, new pane has 3 lines.
  assert.equal(lineButtons.length, 6);
  lineButtons[1].props.onClick({ shiftKey: true });
  lineButtons[3].props.onClick({ shiftKey: false });
  assert.deepEqual(calls, [
    { side: "old", line: 2, extend: true },
    { side: "new", line: 1, extend: false },
  ]);
});

test("full view highlights the selected line", () => {
  const html = render(
    props({ view: "full", selection: { side: "new", start: 2, end: 2 } }),
  );
  assert.match(html, /class="highlight"/);
});
