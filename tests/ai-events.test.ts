import test from "node:test";
import assert from "node:assert/strict";
import { createEventParser } from "../src/server/ai/events.ts";

test("accidentally async progress consumers are rejected without an unhandled rejection", () => {
  const parser = createEventParser("codex", {}, async () => {
    throw new Error("FAKE CALLBACK ERROR");
  });
  assert.throws(() => parser.push(Buffer.from('{"type":"thread.started"}\n')), {
    code: "callback_failed",
  });
});

test("format-only StructuredOutput events are allowed, not executable tools or MCP lookalikes", () => {
  assert.deepEqual(
    feed("claude", [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "StructuredOutput",
              input: { summary: "ok" },
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        structured_output: { summary: "ok" },
      },
    ]).output,
    { summary: "ok" },
  );
  assert.throws(
    () =>
      feed("claude", [
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "mcp__evil__StructuredOutput" },
            ],
          },
        },
      ]),
    { code: "tool_use_forbidden" },
  );
});
test("invalid UTF8 is rejected rather than silently changing model output", () => {
  const parser = createEventParser("claude", {});
  assert.throws(
    () =>
      parser.push(
        Buffer.from([
          0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a,
        ]),
      ),
    { code: "invalid_json" },
  );
});

test("malformed lines fail without exposing raw source in errors", () => {
  const parser = createEventParser("codex", { type: "object" });
  assert.throws(
    () => parser.push(Buffer.from("SECRET SOURCE invalid json\n")),
    { code: "invalid_json" },
  );
});
for (const row of [
  {
    name: "missing terminal",
    provider: "codex",
    events: [
      { type: "item.completed", item: { type: "agent_message", text: "{}" } },
    ],
    code: "invalid_envelope",
  },
  {
    name: "terminal before output",
    provider: "codex",
    events: [
      { type: "turn.completed" },
      { type: "item.completed", item: { type: "agent_message", text: "{}" } },
    ],
    code: "invalid_envelope",
  },
  {
    name: "duplicate result",
    provider: "claude",
    events: [
      { type: "result", subtype: "success", structured_output: {} },
      { type: "result", subtype: "success", structured_output: {} },
    ],
    code: "invalid_envelope",
  },
  {
    name: "quota result",
    provider: "claude",
    events: [
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["insufficient_quota SECRET"],
      },
    ],
    code: "quota_exceeded",
  },
  {
    name: "auth event",
    provider: "codex",
    events: [
      {
        type: "turn.failed",
        error: { message: "401 authentication failed SECRET" },
      },
    ],
    code: "auth_invalid",
  },
  {
    name: "rate event",
    provider: "codex",
    events: [{ type: "error", message: "429 rate limit" }],
    code: "rate_limited",
  },
  {
    name: "model event",
    provider: "claude",
    events: [
      {
        type: "result",
        subtype: "error",
        is_error: true,
        errors: ["model_not_found"],
      },
    ],
    code: "model_unavailable",
  },
  {
    name: "tool execution",
    provider: "codex",
    events: [
      {
        type: "item.started",
        item: { type: "command_execution", command: "forbidden" },
      },
    ],
    code: "tool_use_forbidden",
  },
  {
    name: "Claude tool execution",
    provider: "claude",
    events: [
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash" }] },
      },
    ],
    code: "tool_use_forbidden",
  },
  {
    name: "schema mismatch",
    provider: "claude",
    events: [
      { type: "result", subtype: "success", structured_output: { summary: 4 } },
    ],
    code: "schema_mismatch",
  },
])
  test(row.name, () =>
    assert.throws(() => feed(row.provider as "codex" | "claude", row.events), {
      code: row.code,
    }),
  );
test("bounded line and event counts", () => {
  const a = createEventParser("claude", {}, undefined, { maxLineBytes: 32 });
  assert.throws(() => a.push(Buffer.from("x".repeat(33))), {
    code: "output_limit",
  });
  const b = createEventParser("claude", {}, undefined, { maxEvents: 1 });
  assert.throws(
    () =>
      b.push(
        Buffer.from(
          '{"type":"system","subtype":"init"}\n{"type":"system","subtype":"init"}\n',
        ),
      ),
    { code: "output_limit" },
  );
});
test("progress never exposes internal reasoning, tool arguments or error text", () => {
  const events: unknown[] = [];
  const parser = createEventParser("codex", {}, (e) => events.push(e));
  parser.push(
    Buffer.from(
      JSON.stringify({
        type: "item.completed",
        item: { type: "reasoning", text: "SECRET THOUGHT" },
      }) + "\n",
    ),
  );
  assert.equal(JSON.stringify(events).includes("SECRET"), false);
});

const schema = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
};
const codex = [
  { type: "thread.started", thread_id: "t" },
  { type: "turn.started" },
  {
    type: "item.completed",
    item: { id: "i", type: "agent_message", text: '{"summary":"설명"}' },
  },
  { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } },
];
function feed(provider: "codex" | "claude", events: unknown[]) {
  const parser = createEventParser(provider, schema);
  for (const event of events)
    parser.push(Buffer.from(JSON.stringify(event) + "\n"));
  return parser.finish();
}
test("Codex NDJSON envelope is distinct from validated output, including split UTF8", () => {
  const parser = createEventParser("codex", schema);
  const bytes = Buffer.from(codex.map((e) => JSON.stringify(e)).join("\n"));
  for (const byte of bytes) parser.push(Buffer.from([byte]));
  assert.deepEqual(parser.finish(), {
    output: { summary: "설명" },
    usage: { input_tokens: 10, output_tokens: 4 },
    observedModel: null,
  });
});
test("Claude result structured_output is distinct from text and usage metadata", () => {
  assert.deepEqual(
    feed("claude", [
      { type: "system", subtype: "init", model: "explicit-observed-model" },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        structured_output: { summary: "ok" },
        result: "not the output",
        usage: { input_tokens: 2, output_tokens: 3 },
        total_cost_usd: 0.1,
      },
    ]),
    {
      output: { summary: "ok" },
      usage: { input_tokens: 2, output_tokens: 3 },
      observedModel: "explicit-observed-model",
    },
  );
});
