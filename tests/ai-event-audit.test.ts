import test from "node:test";
import assert from "node:assert/strict";
import { createEventParser, type ProviderId } from "../src/server/ai/events.ts";

const final = (provider: ProviderId) =>
  provider === "claude"
    ? [
        {
          type: "result",
          subtype: "success",
          is_error: false,
          structured_output: { ok: true },
        },
      ]
    : [
        {
          type: "item.completed",
          item: { type: "agent_message", text: '{"ok":true}' },
        },
        { type: "turn.completed" },
      ];
function feed(provider: ProviderId, events: unknown[]) {
  const parser = createEventParser(provider, {
    type: "object",
    required: ["ok"],
    properties: { ok: { const: true } },
    additionalProperties: false,
  });
  parser.push(
    Buffer.from(
      [...events, ...final(provider)]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    ),
  );
  return parser.finish();
}
for (const provider of ["codex", "claude"] as const) {
  test(`${provider}: unknown event cannot precede a successful answer`, () => {
    assert.throws(
      () => feed(provider, [{ type: "unsupported_review_event" }]),
      { code: "invalid_envelope" },
    );
  });
  test(`${provider}: Bash progress cannot precede a successful answer`, () => {
    assert.throws(
      () =>
        feed(provider, [
          {
            type: "tool_progress",
            tool_name: "Bash",
            tool_use_id: "exec-1",
            elapsed_time_seconds: 1,
          },
        ]),
      { code: "tool_use_forbidden" },
    );
  });
}
for (const [name, event, code] of [
  [
    "non-string delta discriminator",
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: ["text_delta"], text: "not a valid envelope" },
      },
    },
    "invalid_envelope",
  ],
  [
    "unknown system subtype",
    { type: "system", subtype: "unreviewed" },
    "invalid_envelope",
  ],
  ["missing system subtype", { type: "system" }, "invalid_envelope"],
  [
    "unknown stream subtype",
    { type: "stream_event", event: { type: "unreviewed" } },
    "invalid_envelope",
  ],
  [
    "unknown content block",
    { type: "assistant", message: { content: [{ type: "unreviewed" }] } },
    "invalid_envelope",
  ],
  [
    "unknown delta",
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "unreviewed" },
      },
    },
    "invalid_envelope",
  ],
  [
    "malformed assistant",
    { type: "assistant", message: { content: "not block array" } },
    "invalid_envelope",
  ],
  [
    "unknown result subtype",
    { type: "result", subtype: "unreviewed", structured_output: { ok: true } },
    "invalid_envelope",
  ],
  [
    "Bash summary",
    {
      type: "tool_use_summary",
      summary: "Bash completed",
      preceding_tool_use_ids: ["exec-1"],
    },
    "tool_use_forbidden",
  ],
  [
    "summary with no auditable tool IDs",
    { type: "tool_use_summary", summary: "unknown" },
    "tool_use_forbidden",
  ],
  [
    "unseen formatting progress",
    {
      type: "tool_progress",
      tool_name: "StructuredOutput",
      tool_use_id: "unknown",
    },
    "tool_use_forbidden",
  ],
  [
    "MCP formatting lookalike progress",
    {
      type: "tool_progress",
      tool_name: "mcp__evil__StructuredOutput",
      tool_use_id: "format-1",
    },
    "tool_use_forbidden",
  ],
  [
    "tool block inside message_start",
    {
      type: "stream_event",
      event: {
        type: "message_start",
        message: { content: [{ type: "tool_use", name: "Bash" }] },
      },
    },
    "tool_use_forbidden",
  ],
  [
    "user executable tool result",
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "exec-1", content: "done" },
        ],
      },
    },
    "tool_use_forbidden",
  ],
  [
    "server tool block",
    {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "server_tool_use", name: "web_search" },
      },
    },
    "tool_use_forbidden",
  ],
  [
    "subagent answer",
    {
      type: "assistant",
      parent_tool_use_id: "exec-1",
      message: { content: [{ type: "text", text: "ok" }] },
    },
    "tool_use_forbidden",
  ],
  [
    "hook progress",
    { type: "system", subtype: "hook_progress" },
    "tool_use_forbidden",
  ],
  [
    "deferred tool in final",
    {
      type: "result",
      subtype: "success",
      deferred_tool_use: { name: "Bash" },
      structured_output: { ok: true },
    },
    "tool_use_forbidden",
  ],
] as const) {
  test(`Claude audit rejects ${name}`, () =>
    assert.throws(() => feed("claude", [event]), { code }));
}
for (const type of [
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "collab_tool_call",
  "web_search",
]) {
  for (const stage of ["item.started", "item.updated", "item.completed"]) {
    test(`Codex audit rejects ${stage} ${type}`, () => {
      assert.throws(
        () => feed("codex", [{ type: stage, item: { type, command: "Bash" } }]),
        { code: "tool_use_forbidden" },
      );
    });
  }
}
test("Claude metadata discriminators are not repaired by string coercion", () => {
  for (const event of [
    { type: "system", subtype: "session_state_changed", state: ["running"] },
    { type: "rate_limit_event", rate_limit_info: { status: ["allowed"] } },
    { type: "result", subtype: ["success"], structured_output: { ok: true } },
  ])
    assert.throws(() => feed("claude", [event]), { code: "invalid_envelope" });
});
test("Codex item discriminators are not repaired by string coercion", () => {
  assert.throws(
    () =>
      feed("codex", [
        { type: "item.completed", item: { type: ["reasoning"] } },
      ]),
    { code: "invalid_envelope" },
  );
});
test("reviewed Claude lifecycle, text and thinking stream envelopes remain accepted", () => {
  const progress: unknown[] = [
    { type: "system", subtype: "init", model: "test-model" },
    {
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      max_retries: 2,
      retry_delay_ms: 10,
      error_status: 503,
      error: "server_error",
    },
    { type: "system", subtype: "status", status: "compacting" },
    {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 1 },
    },
    { type: "system", subtype: "status", status: null },
    {
      type: "system",
      subtype: "thinking_tokens",
      estimated_tokens: 1,
      estimated_tokens_delta: 1,
    },
    { type: "system", subtype: "session_state_changed", state: "running" },
    { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
    { type: "user", message: { content: "literal input" } },
  ];
  for (const event of [
    { type: "message_start", message: { content: [] } },
    { type: "ping" },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "private thought" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "opaque" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "answer" },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ])
    progress.push({ type: "stream_event", event });
  progress.push({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "answer" },
        { type: "redacted_thinking", data: "opaque" },
      ],
    },
  });
  assert.deepEqual(feed("claude", progress).output, { ok: true });
});
test("only tracked StructuredOutput formatting calls may produce progress, summary or tool results", () => {
  const events = [
    {
      type: "stream_event",
      event: { type: "message_start", message: { content: [] } },
    },
    {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          name: "StructuredOutput",
          id: "format-1",
          input: {},
        },
      },
    },
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"ok":true}' },
      },
    },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "StructuredOutput",
            id: "format-1",
            input: { ok: true },
          },
        ],
      },
    },
    {
      type: "tool_progress",
      tool_name: "StructuredOutput",
      tool_use_id: "format-1",
    },
    {
      type: "tool_use_summary",
      summary: "formatted",
      preceding_tool_use_ids: ["format-1"],
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "format-1",
            content: "formatted",
          },
        ],
      },
      tool_use_result: { ok: true },
    },
  ];
  assert.deepEqual(feed("claude", events).output, { ok: true });
  assert.throws(
    () =>
      feed("claude", [
        ...events,
        {
          type: "tool_use_summary",
          preceding_tool_use_ids: ["format-1", "exec-1"],
        },
      ]),
    { code: "tool_use_forbidden" },
  );
});
