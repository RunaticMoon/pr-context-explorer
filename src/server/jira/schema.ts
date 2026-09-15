import Ajv from "ajv";
import type { JsonValue } from "./normalize.ts";

const common = {
  type: "object",
  required: ["id", "key", "fields"],
  additionalProperties: true,
  properties: {
    id: { type: "string", pattern: "^[1-9][0-9]{0,19}$" },
    key: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,19}$" },
    fields: {
      type: "object",
      required: ["summary"],
      additionalProperties: true,
      properties: {
        summary: { type: "string" },
        description: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              required: ["type", "version", "content"],
              properties: {
                type: { const: "doc" },
                version: { const: 1 },
                content: { type: "array" },
              },
            },
          ],
        },
        status: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              required: ["name"],
              properties: { name: { type: "string" } },
            },
          ],
        },
        issuetype: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              required: ["name"],
              properties: { name: { type: "string" } },
            },
          ],
        },
        updated: { type: ["string", "null"] },
      },
    },
  },
};
export const JIRA_CLOUD_ISSUE_SCHEMA = {
  ...common,
  $id: "jira-cloud-issue-v3",
};
const ajv = new Ajv({ strict: false, allErrors: false });
export const JIRA_DATA_CENTER_ISSUE_SCHEMA = {
  ...common,
  $id: "jira-data-center-issue-v2",
  properties: {
    ...common.properties,
    fields: {
      ...common.properties.fields,
      properties: {
        ...common.properties.fields.properties,
        description: { type: ["string", "null"] },
      },
    },
  },
};
const cloud = ajv.compile(JIRA_CLOUD_ISSUE_SCHEMA);
const dc = ajv.compile(JIRA_DATA_CENTER_ISSUE_SCHEMA);
export function validateIssue(
  raw: unknown,
  deployment: "cloud" | "data_center",
): raw is Record<string, JsonValue> {
  return Boolean((deployment === "cloud" ? cloud : dc)(raw));
}
/** Bound traversal before schema/normalizer recursion; preserve original JSON unchanged. */
export function validateJsonBounds(raw: unknown): void {
  const stack: { value: unknown; depth: number }[] = [{ value: raw, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++count > 100_000 || depth > 64) throw new Error("invalid_response");
    if (value && typeof value === "object") {
      for (const child of Object.values(value))
        stack.push({ value: child, depth: depth + 1 });
    }
  }
}
