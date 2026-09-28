import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CommitReviewPanel,
  type CommitReviewPanelProps,
  type ReviewStep,
} from "../src/commit-review-panel.tsx";
import type { CommitReview } from "../src/commit-review.ts";
import type { GroundedStatement } from "../src/server/analysis-v3/types.ts";

function gs(text: string, kind: GroundedStatement["kind"] = "observed") {
  return {
    text,
    kind,
    evidenceIds: [`ev-${text}`],
    confidence: "medium" as const,
    rationale: "",
    limitation: "",
  };
}

function review(
  overrides: Partial<CommitReview<ReviewStep>> = {},
): CommitReview<ReviewStep> {
  return {
    sha: "abcdef1234567890abcd",
    subject: "기능 추가",
    comparisonFromSha: "999888777666555444",
    files: [],
    hunkCount: 0,
    comparisonPartial: false,
    summary: undefined,
    steps: [],
    readCount: 0,
    groups: [],
    ...overrides,
  };
}

let fileCalls = 0;
let stepCalls = 0;
function props(
  overrides: Partial<CommitReviewPanelProps> = {},
): CommitReviewPanelProps {
  return {
    review: review(),
    position: { index: 2, total: 5 },
    analysis: "v3",
    buttons: (ids) => ids.join(","),
    onChooseFile: () => {
      fileCalls++;
    },
    onChooseStep: () => {
      stepCalls++;
    },
    headTour: null,
    alternateComparison: false,
    comparisonSha: "999888777666555444",
    ...overrides,
  };
}

function render(p: CommitReviewPanelProps) {
  fileCalls = 0;
  stepCalls = 0;
  const html = renderToStaticMarkup(React.createElement(CommitReviewPanel, p));
  assert.equal(fileCalls, 0);
  assert.equal(stepCalls, 0);
  return html;
}

test("renders header and AI summary when review.summary exists", () => {
  const html = render(
    props({
      review: review({
        summary: {
          commitSha: "abcdef1234567890abcd",
          comparisonFromSha: "999888777666555444",
          title: gs("로그인 흐름 개선"),
          before: gs("이전 동작"),
          changes: gs("바뀐 내용"),
          why: gs("바꾼 이유"),
          limitationsOfPhase: gs("이 단계의 한계"),
          focusFileIds: [],
          focusGraphEdgeIds: [],
          focusHunkIds: [],
        },
      }),
    }),
  );
  assert.match(html, /data-testid="commit-review"/);
  assert.match(html, /커밋 2 \/ 5/);
  assert.match(html, /기능 추가/);
  assert.match(html, /<code>abcdef123456<\/code>/);
  assert.match(html, /<code>999888777666<\/code>/);
  assert.match(html, /로그인 흐름 개선/);
  assert.match(html, /변경 전/);
  assert.match(html, /이전 동작/);
  assert.match(html, /변경 내용/);
  assert.match(html, /바뀐 내용/);
  assert.match(html, /이유/);
  assert.match(html, /바꾼 이유/);
  assert.match(html, /한계/);
  assert.match(html, /이 단계의 한계/);
});

test("shows the header change count and tour progress on one compact line", () => {
  const html = render(
    props({
      review: review({
        hunkCount: 3,
        files: [
          {
            id: "f1",
            status: "added",
            side: "new" as const,
            pathLabel: "src/new.ts",
            notes: [],
          },
          {
            id: "f2",
            status: "renamed",
            side: "new" as const,
            pathLabel: "src/old.ts → src/moved.ts",
            notes: ["원문 미확보"],
          },
        ],
        readCount: 1,
        steps: [
          { id: "s1", revisionSha: "abcdef1234567890abcd", title: "진입점" },
          { id: "s2", revisionSha: "abcdef1234567890abcd", title: "후속 단계" },
        ],
      }),
    }),
  );
  assert.match(html, /파일 2 · hunk 3/);
  assert.match(html, /투어 1\/2/);
});

test("shows missing-summary notice for a commit without a phase summary", () => {
  const html = render(props({ review: review({ comparisonFromSha: null }) }));
  assert.match(html, /이 커밋의 AI 요약 없음 · Git 원문만 표시/);
  assert.match(html, /비교 기준 root/);
  assert.match(html, /투어 단계/);
});

test("analysis none shows git-only notice and omits the tour section", () => {
  const html = render(props({ analysis: "none" }));
  assert.match(html, /분석 미실행 · Git 원문만 표시/);
  assert.doesNotMatch(html, /투어 단계/);
});

test("baseline position hides change stats", () => {
  const html = render(props({ position: null }));
  assert.match(html, /Baseline · 비교 기준/);
  assert.doesNotMatch(html, /파일 \d+ · hunk \d+/);
});

test("default view omits the file list and keeps the tour links in the details", () => {
  const html = render(
    props({
      review: review({
        files: [
          {
            id: "f1",
            status: "added",
            side: "new" as const,
            pathLabel: "src/new.ts",
            notes: [],
          },
        ],
        steps: [
          { id: "s1", revisionSha: "abcdef1234567890abcd", title: "진입점" },
        ],
      }),
    }),
  );
  assert.match(html, /파일 1 · hunk 0/);
  // The file list moved to the left rail; the panel no longer renders it.
  assert.doesNotMatch(html, /src\/new\.ts/);
  assert.doesNotMatch(html, /commit-review-panel-file/);
  // The full step list lives inside the commit-details disclosure.
  assert.match(
    html,
    /<details class="commit-review-panel-details">.*?투어 단계.*?진입점/s,
  );
});

test("tour steps link from inside the commit-details disclosure", () => {
  const html = render(
    props({
      analysis: "v3",
      review: review({
        readCount: 1,
        steps: [
          { id: "s1", revisionSha: "abcdef1234567890abcd", title: "진입점" },
          { id: "s2", revisionSha: "abcdef1234567890abcd", title: "후속 단계" },
        ],
      }),
    }),
  );
  assert.match(html, /투어 1\/2/);
  assert.match(
    html,
    /<details class="commit-review-panel-details">.*?진입점.*?후속 단계/s,
  );
});

test("missing steps offer the fixed head tour entry", () => {
  const html = render(
    props({ headTour: { sha: "aaaabbbbccccddddeeee", stepId: "head-1" } }),
  );
  assert.match(html, /이 revision의 투어 단계 없음/);
  assert.match(html, /고정 head 투어 열기 · aaaabbbb/);
});

test("alternate and partial comparisons keep their warnings visible", () => {
  const html = render(
    props({
      alternateComparison: true,
      comparisonSha: "111222333444555666",
      review: review({ comparisonPartial: true }),
    }),
  );
  assert.match(
    html,
    /추가 부모 비교 중 · 아래 파일 상태는 첫 부모 기준입니다/,
  );
  assert.match(html, /부분 diff/);
  // Warnings stay outside any disclosure and keep role="status".
  const warningIndex = html.indexOf("commit-review-panel-warning");
  const detailsIndex = html.indexOf("<details");
  assert.ok(warningIndex >= 0 && warningIndex < detailsIndex);
  assert.match(html, /class="commit-review-panel-warning" role="status"/);
});

function summaryFor(
  commitSha: string,
  comparisonFromSha: string | null,
  title: string,
  focus: {
    focusFileIds?: string[];
    focusGraphEdgeIds?: string[];
    focusHunkIds?: string[];
  } = {},
) {
  return {
    commitSha,
    comparisonFromSha,
    title: gs(title),
    before: gs(`${title}-before`),
    changes: gs(`${title}-changes`),
    why: gs(`${title}-why`),
    limitationsOfPhase: gs(`${title}-limitations`),
    focusFileIds: focus.focusFileIds || [],
    focusGraphEdgeIds: focus.focusGraphEdgeIds || [],
    focusHunkIds: focus.focusHunkIds || [],
  };
}

test("alternate comparison shows that comparison's AI summary with its base SHA", () => {
  const html = render(
    props({
      alternateComparison: true,
      comparisonSha: "111222333444555666",
      comparisonSummary: summaryFor(
        "abcdef1234567890abcd",
        "111222333444555666",
        "두 번째 부모 기준 요약",
      ),
      review: review({
        summary: summaryFor(
          "abcdef1234567890abcd",
          "999888777666555444",
          "첫 부모 기준 본문",
        ),
      }),
    }),
  );
  assert.match(html, /비교 기준 <code>111222333444<\/code>/);
  assert.match(html, /두 번째 부모 기준 요약/);
  // The first-parent summary is not presented as the selected comparison.
  assert.doesNotMatch(html, /첫 부모 기준 본문/);
  assert.doesNotMatch(html, /이 비교 기준의 AI 요약 없음/);
});

test("one-line summary uses only the active comparison's title", () => {
  const html = render(
    props({
      alternateComparison: true,
      comparisonSha: "111222333444555666",
      comparisonSummary: summaryFor(
        "abcdef1234567890abcd",
        "111222333444555666",
        "두 번째 부모 한 줄",
      ),
      review: review({
        summary: summaryFor(
          "abcdef1234567890abcd",
          "999888777666555444",
          "첫 부모 한 줄",
        ),
      }),
    }),
  );
  assert.match(
    html,
    /<div class="commit-review-panel-summary-line"[^>]*>.*?두 번째 부모 한 줄/s,
  );
  assert.doesNotMatch(html, /첫 부모 한 줄/);
});

test("non-alternate one-line summary uses the first-parent summary", () => {
  const html = render(
    props({
      review: review({
        summary: summaryFor(
          "abcdef1234567890abcd",
          "999888777666555444",
          "첫 부모 한 줄",
        ),
      }),
    }),
  );
  assert.match(
    html,
    /<div class="commit-review-panel-summary-line"[^>]*>.*?첫 부모 한 줄/s,
  );
});

test("alternate comparison without its own summary folds the first-parent summary", () => {
  const html = render(
    props({
      alternateComparison: true,
      comparisonSha: "111222333444555666",
      review: review({
        summary: summaryFor(
          "abcdef1234567890abcd",
          "999888777666555444",
          "첫 부모 기준 본문",
        ),
      }),
    }),
  );
  assert.match(html, /이 비교 기준의 AI 요약 없음/);
  assert.match(html, /class="commit-review-panel-first-parent"/);
  assert.match(html, /첫 부모 기준 요약/);
  assert.match(html, /<code>999888777666<\/code>/);
  assert.match(html, /첫 부모 기준 본문/);
});

test("alternate comparison without any summary shows only the missing notice", () => {
  const html = render(
    props({
      alternateComparison: true,
      comparisonSha: "111222333444555666",
    }),
  );
  assert.match(html, /이 비교 기준의 AI 요약 없음/);
  assert.doesNotMatch(html, /첫 부모 기준 요약/);
  assert.doesNotMatch(html, /commit-review-panel-first-parent/);
});

test("header labels the active comparison during alternate comparison", () => {
  const html = render(
    props({
      alternateComparison: true,
      comparisonSha: "111222333444555666",
      comparisonSummary: summaryFor(
        "abcdef1234567890abcd",
        "111222333444555666",
        "두 번째 부모 기준 요약",
      ),
    }),
  );
  assert.match(
    html,
    /비교 기준 <code>111222333444<\/code> · 파일 상태는 첫 부모 <code>999888777666<\/code> 기준/,
  );
});

test("alternate comparison with no analysis keeps the git-only notice", () => {
  const html = render(
    props({
      alternateComparison: true,
      comparisonSha: "111222333444555666",
      analysis: "none",
    }),
  );
  assert.match(html, /분석 미실행 · Git 원문만 표시/);
  assert.doesNotMatch(html, /이 비교 기준의 AI 요약 없음/);
});

test("summary focus ids render as a muted line with file path buttons", () => {
  const html = render(
    props({
      review: review({
        files: [
          {
            id: "f1",
            status: "modified",
            side: "new" as const,
            pathLabel: "src/a.ts",
            notes: [],
          },
        ],
        summary: summaryFor(
          "abcdef1234567890abcd",
          "999888777666555444",
          "요약",
          {
            focusFileIds: ["f1", "f-missing"],
            focusGraphEdgeIds: ["e1"],
            focusHunkIds: ["h1", "h2"],
          },
        ),
      }),
    }),
  );
  assert.match(html, /강조 파일/);
  // A focus file in review.files becomes a path button; others show raw ids.
  assert.match(html, /<button[^>]*>src\/a\.ts<\/button>/);
  assert.match(
    html,
    /<code title="첫 부모 기준 변경 파일 목록에 없음">f-missing<\/code>/,
  );
  assert.match(html, /edge e1/);
  assert.match(html, /hunk h1, h2/);
});

test("change groups render grounded text, shared badge, and file buttons", () => {
  const html = render(
    props({
      review: review({
        files: [
          {
            id: "f1",
            status: "modified",
            side: "new" as const,
            pathLabel: "src/a.ts",
            notes: [],
          },
        ],
        groups: [
          {
            group: {
              id: "g1",
              title: gs("묶음 제목"),
              purpose: gs("묶음 목적"),
              fileIds: ["f1", "f-other-commit"],
              commitShas: ["abcdef1234567890abcd", "other"],
              evidenceIds: ["ev-g1"],
            },
            fileIds: ["f1", "f-other-commit"],
            shared: true,
          },
        ],
      }),
    }),
  );
  assert.match(html, /여러 커밋에 걸친 묶음/);
  assert.match(html, /묶음 제목/);
  assert.match(html, /묶음 목적/);
  assert.match(html, /ev-g1/);
  // Only fileIds that exist in this commit's file list become path buttons.
  assert.match(html, /src\/a\.ts/);
  assert.doesNotMatch(html, /f-other-commit/);
});

test("provenance and gitMessage slots render inside their details", () => {
  const html = render(
    props({
      provenance: React.createElement(
        "span",
        { "data-testid": "prov" },
        "근거 위치",
      ),
      gitMessage: React.createElement("pre", null, "커밋 메시지 원문"),
    }),
  );
  assert.match(
    html,
    /<details class="commit-review-panel-details">.*?커밋 메시지 원문.*?<\/details>/s,
  );
  assert.match(
    html,
    /<details class="commit-review-panel-provenance">.*?근거 위치.*?<\/details>/s,
  );
});
