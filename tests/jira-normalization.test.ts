import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeJiraDocument,
  JIRA_NORMALIZER_VERSION,
} from "../src/server/jira/normalize.ts";

test("changed normalization coverage invalidates the old normalizer identity", () => {
  assert.equal(JIRA_NORMALIZER_VERSION, "jira-text-v2");
});
const adf = (node: any) => ({ type: "doc", version: 1, content: [node] });
const pointer = "/fields/description";
for (const type of [
  "doc",
  "paragraph",
  "heading",
  "codeBlock",
  "blockquote",
  "listItem",
  "tableRow",
  "bulletList",
  "orderedList",
  "table",
  "tableCell",
  "tableHeader",
  "panel",
]) {
  test(`ADF ${type} never silently discards malformed content as complete or empty`, () => {
    for (const content of ["malformed source", null, 1, {}]) {
      const raw = adf({ type, content });
      const result = normalizeJiraDocument(raw, pointer);
      assert.equal(result.coverage, "partial");
      assert.ok(
        result.unsupportedPointers.includes(`${pointer}/content/0/content`),
      );
      assert.deepEqual(result.raw, raw);
    }
  });
}
for (const type of [
  "doc",
  "blockquote",
  "listItem",
  "tableRow",
  "bulletList",
  "orderedList",
  "table",
  "tableCell",
  "tableHeader",
  "panel",
]) {
  test(`ADF ${type} requires its child array`, () => {
    for (const node of [{ type }, { type, content: [] }]) {
      if (["doc", "tableRow"].includes(type) && "content" in node) continue; // ADF permits empty docs/rows.
      const result = normalizeJiraDocument(adf(node), pointer);
      assert.equal(result.coverage, "partial");
      assert.ok(
        result.unsupportedPointers.includes(`${pointer}/content/0/content`),
      );
    }
  });
}
for (const [node, property] of [
  [{ type: "text" }, "text"],
  [{ type: "text", text: 7 }, "text"],
  [{ type: "text", text: "" }, "text"],
  [{ type: "text", text: "literal", content: "discarded" }, "content"],
  [{ type: "hardBreak", content: "discarded" }, "content"],
  [{ type: "paragraph", attrs: "bad" }, "attrs"],
  [{ type: "heading", content: [] }, "attrs"],
  [{ type: "heading", attrs: { level: "bad" } }, "attrs/level"],
  [
    {
      type: "panel",
      attrs: { panelType: ["info"] },
      content: [{ type: "paragraph" }],
    },
    "attrs/panelType",
  ],
  [
    {
      type: "panel",
      attrs: { panelType: "bad" },
      content: [{ type: "paragraph" }],
    },
    "attrs/panelType",
  ],
  [{ type: "text", text: "literal", marks: "bad" }, "marks"],
  [{ type: "text", text: "literal", marks: ["bad"] }, "marks/0"],
  [
    { type: "text", text: "literal", marks: [{ type: "link", attrs: "bad" }] },
    "marks/0/attrs",
  ],
] as const) {
  test(`malformed ADF ${node.type} ${property} retains an exact unsupported pointer`, () => {
    const result = normalizeJiraDocument(adf(node), pointer);
    assert.equal(result.coverage, "partial");
    assert.ok(
      result.unsupportedPointers.includes(`${pointer}/content/0/${property}`),
    );
  });
}
test("ADF invalid child placement is partial rather than apparently valid text", () => {
  const result = normalizeJiraDocument(
    adf({ type: "paragraph", content: [{ type: "tableRow", content: [] }] }),
    pointer,
  );
  assert.equal(result.coverage, "partial");
  assert.ok(
    result.unsupportedPointers.includes(`${pointer}/content/0/content/0`),
  );
});
test("unknown ADF node names cannot resolve inherited child rules", () => {
  const result = normalizeJiraDocument(
    adf({ type: "__proto__", content: [{ type: "paragraph" }] }),
    pointer,
  );
  assert.equal(result.coverage, "partial");
  assert.deepEqual(result.unsupportedPointers, [`${pointer}/content/0`]);
});
test("valid empty inline containers remain empty and legitimate supported nesting remains complete", () => {
  for (const node of [
    { type: "paragraph" },
    { type: "heading", attrs: { level: 2 } },
    { type: "codeBlock" },
  ]) {
    const result = normalizeJiraDocument(adf(node), pointer);
    assert.equal(result.coverage, "empty");
    assert.deepEqual(result.unsupportedPointers, []);
  }
  for (const type of [
    "blockquote",
    "panel",
    "bulletList",
    "orderedList",
    "table",
  ]) {
    const paragraph = {
      type: "paragraph",
      content: [{ type: "text", text: "literal" }],
    };
    const child =
      type === "table"
        ? {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [paragraph] },
              { type: "tableCell", content: [paragraph] },
            ],
          }
        : type.endsWith("List")
          ? { type: "listItem", content: [paragraph] }
          : paragraph;
    const result = normalizeJiraDocument(
      adf({
        type,
        ...(type === "panel" ? { attrs: { panelType: "info" } } : {}),
        content: [child],
      }),
      pointer,
    );
    assert.equal(result.coverage, "complete");
    assert.deepEqual(result.unsupportedPointers, []);
    assert.ok(result.text.includes("literal"));
  }
});

test("normalization bounds recursive work and marks malformed or unsupported ADF honestly", async () => {
  const jira = await import("../src/server/jira/index.ts");
  let deep: any = { type: "text", text: "deep" };
  for (let i = 0; i < 70; i++) deep = { type: "paragraph", content: [deep] };
  assert.throws(
    () =>
      jira.normalizeJiraDocument(
        { type: "doc", version: 1, content: [deep] },
        "/fields/description",
      ),
    /limit|invalid/i,
  );
  assert.equal(
    jira.normalizeJiraDocument({ type: "doc", version: 1 }, "/fields/x")
      .coverage,
    "partial",
  );
  assert.equal(
    jira.normalizeJiraDocument(
      { type: "doc", version: 99, content: [] },
      "/fields/x",
    ).coverage,
    "partial",
  );
});

test("ADF normalization preserves raw data and exact JSON Pointer evidence, never renders source HTML", async () => {
  const jira = await import("../src/server/jira/index.ts");
  assert.equal(typeof jira.normalizeJiraDocument, "function");
  const raw: any = {
    version: 1,
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "<script>alert(1)</script>",
            marks: [
              { type: "link", attrs: { href: "https://evil.test/exfil" } },
            ],
          },
          { type: "hardBreak" },
          { type: "text", text: "literal  spaces" },
        ],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Explicit criterion" }],
              },
            ],
          },
        ],
      },
      {
        type: "mysteryWidget",
        attrs: { secretInstruction: "invent criteria" },
      },
    ],
  };
  const original = structuredClone(raw);
  const result = jira.normalizeJiraDocument(raw, "/fields/description");
  assert.deepEqual(result.raw, original);
  assert.deepEqual(raw, original);
  assert.equal(
    result.text,
    "<script>alert(1)</script>\nliteral  spaces\nExplicit criterion",
  );
  assert.equal(result.coverage, "partial");
  assert.deepEqual(result.unsupportedPointers, [
    "/fields/description/content/2",
  ]);
  for (const span of result.segments) {
    const relative = span.pointer.slice("/fields/description".length);
    const value = relative
      .split("/")
      .slice(1)
      .reduce((o: any, key) => o[key], raw);
    assert.equal(result.text.slice(span.start, span.end), value);
  }
  assert.equal(
    result.segments[0].pointer,
    "/fields/description/content/0/content/0/text",
  );
  assert.equal("html" in result, false);
  (result.raw as any).content[0].content[0].text = "mutated";
  assert.deepEqual(raw, original);
});

test("plain strings, empty and missing fields remain distinguishable without inferred criteria", async () => {
  const jira = await import("../src/server/jira/index.ts");
  assert.equal(typeof jira.normalizeJiraDocument, "function");
  const raw = "h2. Original DC wiki\r\n* [unsafe|javascript:alert(1)]\n";
  const doc = jira.normalizeJiraDocument(raw, "/fields/customfield_123");
  assert.equal(doc.text, raw);
  assert.equal(doc.raw, raw);
  assert.equal(doc.coverage, "complete");
  assert.deepEqual(doc.segments, [
    { pointer: "/fields/customfield_123", start: 0, end: raw.length },
  ]);
  assert.equal(
    jira.normalizeJiraDocument(null, "/fields/description").coverage,
    "empty",
  );
  assert.equal(
    jira.normalizeJiraDocument(undefined, "/fields/description").present,
    false,
  );
  assert.equal(
    jira.normalizeJiraDocument("", "/fields/description").present,
    true,
  );
  assert.equal(
    jira.normalizeJiraDocument({ unexpected: "not prose" }, "/fields/x")
      .coverage,
    "partial",
  );
});
