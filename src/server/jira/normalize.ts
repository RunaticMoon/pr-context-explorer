import { validateJsonBounds } from "./schema.ts";
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface JiraTextSegment {
  pointer: string;
  start: number;
  end: number;
}
export interface JiraDocument {
  pointer: string;
  present: boolean;
  raw: JsonValue | null;
  /** Untrusted literal plain text. Never HTML, Markdown, or execution instructions. */
  text: string;
  segments: JiraTextSegment[];
  coverage: "complete" | "partial" | "empty" | "unavailable";
  unsupportedPointers: string[];
}
export const JIRA_NORMALIZER_VERSION = "jira-text-v2";
export function jsonObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function normalizeJiraDocument(
  value: JsonValue | undefined,
  pointer: string,
): JiraDocument {
  validateJsonBounds(value);
  const result: JiraDocument = {
    pointer,
    present: value !== undefined,
    raw: value === undefined ? null : structuredClone(value),
    text: "",
    segments: [],
    coverage: "complete",
    unsupportedPointers: [],
  };
  const text = (value: string, pointer: string) => {
    const start = result.text.length;
    result.text += value;
    result.segments.push({ pointer, start, end: result.text.length });
  };
  if (value === undefined) result.coverage = "unavailable";
  else if (value === null || value === "") result.coverage = "empty";
  else if (typeof value === "string") text(value, pointer);
  else if (jsonObject(value) && value.type === "doc") {
    const blocks = new Set([
      "paragraph",
      "heading",
      "codeBlock",
      "blockquote",
      "listItem",
      "tableRow",
    ]);
    const containers = new Set([
      "doc",
      "bulletList",
      "orderedList",
      "table",
      "tableCell",
      "tableHeader",
      "panel",
      ...blocks,
    ]);
    // Structural rules for the text-normalized subset of Atlassian ADF.
    // https://go.atlassian.com/adf-json-schema — optional inline content can
    // represent a genuine empty paragraph/heading/code block; other containers
    // require arrays. Unknown nodes remain partial, not fabricated empty text.
    const optionalContent = new Set(["paragraph", "heading", "codeBlock"]);
    const childTypes: Record<string, readonly string[]> = {
      doc: [
        "paragraph",
        "heading",
        "codeBlock",
        "blockquote",
        "bulletList",
        "orderedList",
        "panel",
        "table",
      ],
      paragraph: ["text", "hardBreak"],
      heading: ["text", "hardBreak"],
      codeBlock: ["text"],
      bulletList: ["listItem"],
      orderedList: ["listItem"],
      listItem: ["paragraph", "bulletList", "orderedList", "codeBlock"],
      blockquote: ["paragraph", "bulletList", "orderedList", "codeBlock"],
      panel: ["paragraph", "heading", "bulletList", "orderedList", "codeBlock"],
      table: ["tableRow"],
      tableRow: ["tableCell", "tableHeader"],
      tableCell: [
        "paragraph",
        "heading",
        "codeBlock",
        "blockquote",
        "bulletList",
        "orderedList",
        "panel",
      ],
      tableHeader: [
        "paragraph",
        "heading",
        "codeBlock",
        "blockquote",
        "bulletList",
        "orderedList",
        "panel",
      ],
    };
    const unsupported = (path: string) => result.unsupportedPointers.push(path);
    const visit = (node: JsonValue, path: string, parent?: string) => {
      if (!jsonObject(node) || typeof node.type !== "string") {
        unsupported(path);
        return;
      }
      const recognized =
        containers.has(node.type) ||
        node.type === "text" ||
        node.type === "hardBreak";
      if (
        !recognized ||
        (parent &&
          Object.hasOwn(childTypes, parent) &&
          !childTypes[parent].includes(node.type))
      )
        unsupported(path);
      if (recognized) {
        if (node.type === "doc" && node.version !== 1)
          unsupported(path + "/version");
        if (
          node.attrs !== undefined ||
          node.type === "heading" ||
          node.type === "panel"
        ) {
          if (!jsonObject(node.attrs)) unsupported(path + "/attrs");
          else if (
            node.type === "heading" &&
            (typeof node.attrs.level !== "number" ||
              node.attrs.level < 1 ||
              node.attrs.level > 6)
          )
            unsupported(path + "/attrs/level");
          else if (
            node.type === "panel" &&
            (typeof node.attrs.panelType !== "string" ||
              ![
                "info",
                "note",
                "tip",
                "warning",
                "error",
                "success",
                "custom",
              ].includes(node.attrs.panelType))
          )
            unsupported(path + "/attrs/panelType");
        }
        if (node.marks !== undefined) {
          if (!Array.isArray(node.marks)) unsupported(path + "/marks");
          else
            node.marks.forEach((mark, i) => {
              const markPath = `${path}/marks/${i}`;
              if (!jsonObject(mark) || typeof mark.type !== "string")
                unsupported(markPath);
              else if (mark.attrs !== undefined && !jsonObject(mark.attrs))
                unsupported(markPath + "/attrs");
            });
        }
      }
      if (node.type === "text") {
        if (node.content !== undefined) unsupported(path + "/content");
        if (typeof node.text !== "string" || !node.text.length)
          unsupported(path + "/text");
        else text(node.text, path + "/text");
        return;
      }
      if (node.type === "hardBreak") {
        if (node.content !== undefined) unsupported(path + "/content");
        result.text += "\n";
        return;
      }
      if (containers.has(node.type)) {
        if (node.content === undefined && optionalContent.has(node.type))
          return;
        if (!Array.isArray(node.content)) {
          unsupported(path + "/content");
          return;
        }
        if (
          !node.content.length &&
          !optionalContent.has(node.type) &&
          node.type !== "doc" &&
          node.type !== "tableRow"
        )
          unsupported(path + "/content");
      }
      if (Array.isArray(node.content))
        node.content.forEach((child, i) =>
          visit(child, `${path}/content/${i}`, node.type as string),
        );
      if (blocks.has(node.type) && !result.text.endsWith("\n"))
        result.text += "\n";
    };
    visit(value, pointer);
    // Remove only synthetic trailing separators, never characters from a source text segment.
    const lastEvidenceEnd = result.segments.at(-1)?.end ?? 0;
    result.text = result.text.slice(
      0,
      Math.max(lastEvidenceEnd, result.text.replace(/\n+$/, "").length),
    );
    if (!result.text) result.coverage = "empty";
  } else result.unsupportedPointers.push(pointer);
  if (result.unsupportedPointers.length) result.coverage = "partial";
  return result;
}
