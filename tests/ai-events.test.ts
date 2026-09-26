import test from "node:test";
import assert from "node:assert/strict";
import {
  createEventParser,
  type ProviderId,
} from "../src/server/ai/events.ts";
import { AIError } from "../src/server/ai/errors.ts";

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
    name: "schema rejection event",
    provider: "codex",
    events: [
      {
        type: "turn.failed",
        error: {
          message:
            "Invalid schema for response_format 'output': SECRET DETAIL",
        },
      },
    ],
    code: "schema_invalid",
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
function feed(
  provider: "codex" | "claude",
  events: unknown[],
  feedSchema: object = schema,
) {
  const parser = createEventParser(provider, feedSchema);
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
test("Codex warning items and reconnect notices are non-fatal and leak no text", () => {
  const emitted: unknown[] = [];
  const parser = createEventParser("codex", schema, (e) => emitted.push(e));
  const stream = [
    { type: "thread.started", thread_id: "t" },
    {
      type: "item.completed",
      item: {
        id: "item_0",
        type: "error",
        message:
          "Under-development features enabled: skip_host_skill_discovery. SECRET WARNING",
      },
    },
    { type: "turn.started" },
    {
      type: "error",
      message:
        "Reconnecting... 2/5 (stream disconnected before completion) SECRET",
    },
    {
      type: "item.completed",
      item: {
        id: "item_1",
        type: "error",
        message: "Falling back from WebSockets to HTTPS transport. SECRET",
      },
    },
    {
      type: "item.completed",
      item: { id: "i", type: "agent_message", text: '{"summary":"ok"}' },
    },
    { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } },
  ];
  for (const event of stream)
    parser.push(Buffer.from(JSON.stringify(event) + "\n"));
  assert.deepEqual(parser.finish(), {
    output: { summary: "ok" },
    usage: { input_tokens: 5, output_tokens: 2 },
    observedModel: null,
  });
  assert.equal(JSON.stringify(emitted).includes("SECRET"), false);
});
test("Codex tool item types remain forbidden alongside tolerated warnings", () => {
  for (const toolType of [
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "web_search",
  ])
    for (const eventType of ["item.started", "item.completed"])
      assert.throws(
        () =>
          feed("codex", [
            { type: "thread.started", thread_id: "t" },
            { type: eventType, item: { type: toolType } },
          ]),
        { code: "tool_use_forbidden" },
      );
});
test("Codex top-level errors other than reconnect notices stay fatal", () => {
  assert.throws(
    () =>
      feed("codex", [
        { type: "thread.started", thread_id: "t" },
        { type: "error", message: "stream disconnected before completion" },
      ]),
    { code: "provider_failed" },
  );
  // Claude keeps its existing fatal handling even for the reconnect shape.
  assert.throws(
    () => feed("claude", [{ type: "error", message: "Reconnecting... 2/5" }]),
    { code: "provider_failed" },
  );
});
test("Codex output under the strict schema restores canonically-optional keys sent as null", () => {
  const optionalSchema = {
    type: "object",
    properties: {
      summary: { type: "string" },
      note: { type: "string" },
    },
    required: ["summary"],
    additionalProperties: false,
  };
  const parser = createEventParser("codex", optionalSchema);
  for (const event of [
    { type: "turn.started" },
    {
      type: "item.completed",
      item: {
        type: "agent_message",
        text: '{"summary":"s","note":null}',
      },
    },
    { type: "turn.completed" },
  ])
    parser.push(Buffer.from(JSON.stringify(event) + "\n"));
  assert.deepEqual(parser.finish().output, { summary: "s" });
});
test("nulls on canonically-required keys are still rejected, and Claude gets no stripping", () => {
  const optionalSchema = {
    type: "object",
    properties: {
      summary: { type: "string" },
      note: { type: "string" },
    },
    required: ["summary"],
    additionalProperties: false,
  };
  const codexParser = createEventParser("codex", optionalSchema);
  assert.throws(
    () => {
      for (const event of [
        { type: "turn.started" },
        {
          type: "item.completed",
          item: {
            type: "agent_message",
            text: '{"summary":null,"note":"x"}',
          },
        },
        { type: "turn.completed" },
      ])
        codexParser.push(Buffer.from(JSON.stringify(event) + "\n"));
      codexParser.finish();
    },
    { code: "schema_mismatch" },
  );
  assert.throws(
    () =>
      feed("claude", [
        {
          type: "result",
          subtype: "success",
          structured_output: { summary: "s", note: null },
        },
      ], optionalSchema),
    { code: "schema_mismatch" },
  );
});
test("schema_mismatch carries sanitized diagnostics and no values or source text", () => {
  let thrown: unknown;
  try {
    feed("claude", [
      {
        type: "result",
        subtype: "success",
        structured_output: {
          summary: ["CANARY VALUE"],
          stealth: "CANARY PROP",
        },
      },
    ]);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof AIError);
  assert.equal(thrown.code, "schema_mismatch");
  assert.equal(thrown.detail?.code, "schema_mismatch");
  assert.equal(thrown.detail?.reasonCode, "output_schema_mismatch");
  assert.ok(
    Array.isArray(thrown.detail?.schemaErrors) &&
      thrown.detail.schemaErrors.length > 0 &&
      thrown.detail.schemaErrors.every(
        (entry) =>
          typeof entry.keyword === "string" &&
          typeof entry.instancePath === "string",
      ),
  );
  const serialized = JSON.stringify(thrown.detail);
  assert.equal(serialized.includes("CANARY"), false);
  assert.equal(serialized.includes("stealth"), false);
  assert.equal(thrown.message.includes("CANARY"), false);
});
test("transient failures that merely mention format words are not schema_invalid", () => {
  for (const message of [
    "network connection reset while sending json_schema request SECRET",
    "timed out waiting for response_format endpoint, retrying SECRET",
    "server_error 502 on json_schema route SECRET",
  ])
    assert.throws(
      () => feed("codex", [{ type: "turn.failed", error: { message } }]),
      { code: "provider_unavailable" },
    );
});
test("explicit schema rejection phrases classify as schema_invalid without echoing provider text", () => {
  for (const message of [
    "error code invalid_json_schema: CANARY DETAIL",
    "Invalid schema for response_format 'out': CANARY DETAIL",
    "response schema rejected: CANARY DETAIL",
  ]) {
    let thrown: unknown;
    try {
      feed("claude", [
        {
          type: "result",
          subtype: "error",
          is_error: true,
          errors: [message],
        },
      ]);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof AIError);
    assert.equal(thrown.code, "schema_invalid", message);
    assert.equal(JSON.stringify(thrown).includes("CANARY"), false);
    assert.equal(thrown.message.includes("CANARY"), false);
  }
});
test("HTTP provider ids are rejected by the CLI event parser", () => {
  for (const id of ["openai-compatible", "bogus", undefined])
    assert.throws(
      () => createEventParser(id as unknown as ProviderId, {}),
      { code: "invalid_request" },
    );
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
