import { Ajv, type ValidateFunction } from "ajv";
import { TextDecoder } from "node:util";
import { AIError, type AIErrorCode } from "./errors.ts";
export type ProviderId = "codex" | "claude";
export type AIEvent =
  | {
      type: "status";
      phase: "preparing" | "running" | "validating" | "completed";
    }
  | { type: "progress"; phase: "started" | "generating" | "retrying" };
export function emitEvent(
  callback: ((event: AIEvent) => void) | undefined,
  event: AIEvent,
): void {
  try {
    const result: unknown = callback?.(event);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch(() => {});
      throw new AIError("callback_failed");
    }
  } catch {
    throw new AIError("callback_failed");
  }
}
export interface ParsedAnalysis {
  output: unknown;
  usage: Record<string, number>;
  observedModel: string | null;
}
export const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AIError("invalid_json");
  }
}
export function classifyProviderError(value: unknown): AIError {
  // Classify bounded diagnostics internally; never return the provider's text.
  const text = (
    typeof value === "string" ? value : (JSON.stringify(value) ?? "")
  )
    .slice(0, 256 * 1024)
    .toLowerCase();
  let code: AIErrorCode = "provider_failed";
  if (/quota|billing|credit balance|error_budget|account_on_hold/.test(text))
    code = "quota_exceeded";
  else if (
    /authentication|unauthorized|invalid.?api.?key|not logged in|oauth|\b401\b|\b403\b/.test(
      text,
    )
  )
    code = "auth_invalid";
  else if (/rate.?limit|\b429\b/.test(text)) code = "rate_limited";
  else if (
    /model.not.found|model.*(?:unavailable|not supported|does not exist)/.test(
      text,
    )
  )
    code = "model_unavailable";
  else if (
    /overloaded|server_error|\b50[0234]\b|connection|network|timed out/.test(
      text,
    )
  )
    code = "provider_unavailable";
  return new AIError(code);
}
export function compileOutputSchema(schema: object): ValidateFunction {
  try {
    return new Ajv({
      allErrors: false,
      strict: true,
      validateFormats: true,
    }).compile(schema);
  } catch {
    throw new AIError("schema_invalid");
  }
}
function safeUsage(value: unknown): Record<string, number> {
  const source = record(value),
    result: Record<string, number> = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cached_input_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ]) {
    const n = source[key];
    if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
      result[key] = n;
  }
  return result;
}
function createClaudeAudit() {
  // Reviewed against Claude SDK 0.3.270 / CLI 2.1.270. Unknown variants
  // require review, never silent acceptance. See docs/ADAPTER-FIXES.md.
  const formattingIds = new Set<string>();
  const formattingBlocks = new Set<number>();
  const knownFormatId = (id: unknown) =>
    typeof id === "string" && formattingIds.has(id);
  const invalid = (): never => {
    throw new AIError("invalid_envelope");
  };
  const forbidden = (): never => {
    throw new AIError("tool_use_forbidden");
  };
  const block = (value: unknown, user = false): void => {
    const b = record(value);
    switch (b.type) {
      case "text":
        if (typeof b.text !== "string") invalid();
        return;
      case "thinking":
        if (user || typeof b.thinking !== "string") invalid();
        return;
      case "redacted_thinking":
        if (user || typeof b.data !== "string") invalid();
        return;
      case "tool_use":
        if (user || b.name !== "StructuredOutput") forbidden();
        if (typeof b.id === "string" && b.id.length) formattingIds.add(b.id);
        return;
      case "tool_result":
        if (!user || !knownFormatId(b.tool_use_id)) forbidden();
        // Formatting results are text, not a tunnel for nested tool envelopes.
        if (Array.isArray(b.content)) {
          for (const child of b.content) {
            if (record(child).type !== "text") forbidden();
            block(child, true);
          }
        } else if (b.content !== undefined && typeof b.content !== "string")
          invalid();
        return;
      case "server_tool_use":
        forbidden();
      default:
        invalid();
    }
  };
  const content = (value: unknown, user = false): void => {
    if (user && typeof value === "string") return;
    if (!Array.isArray(value)) invalid();
    for (const b of value as unknown[]) block(b, user);
  };
  return (event: Record<string, unknown>): void => {
    if (
      event.parent_tool_use_id != null ||
      event.subagent_type != null ||
      event.task_id != null ||
      event.deferred_tool_use != null
    )
      forbidden();
    if (event.tool_name !== undefined && event.tool_name !== "StructuredOutput")
      forbidden();
    switch (event.type) {
      case "system":
        switch (event.subtype) {
          case "init":
          case "api_retry":
          case "compact_boundary":
          case "thinking_tokens":
            return; // Reviewed metadata only; no provider payload is emitted.
          case "status":
            if (
              event.status !== null &&
              event.status !== "compacting" &&
              event.status !== "requesting"
            )
              invalid();
            return;
          case "session_state_changed":
            if (
              typeof event.state !== "string" ||
              !["idle", "running", "requires_action"].includes(event.state)
            )
              invalid();
            return;
          case "hook_started":
          case "hook_progress":
          case "hook_response":
          case "task_started":
          case "task_updated":
          case "task_progress":
          case "task_notification":
          case "local_command_output":
          case "files_persisted":
            forbidden();
          default:
            invalid();
        }
      case "rate_limit_event": {
        const status = record(event.rate_limit_info).status;
        if (
          typeof status !== "string" ||
          !["allowed", "allowed_warning", "rejected"].includes(status)
        )
          invalid();
        return;
      }
      case "assistant":
        content(record(event.message).content);
        return;
      case "user": {
        const body = record(event.message).content;
        content(body, true);
        if (
          event.tool_use_result !== undefined &&
          (!Array.isArray(body) ||
            !body.length ||
            body.some(
              (b) =>
                record(b).type !== "tool_result" ||
                !knownFormatId(record(b).tool_use_id),
            ))
        )
          forbidden();
        return;
      }
      case "stream_event": {
        const nested = record(event.event);
        switch (nested.type) {
          case "message_start":
            formattingBlocks.clear();
            content(record(nested.message).content);
            return;
          case "content_block_start":
            block(nested.content_block);
            if (
              !Number.isSafeInteger(nested.index) ||
              (nested.index as number) < 0
            )
              invalid();
            formattingBlocks.delete(nested.index as number);
            if (record(nested.content_block).type === "tool_use")
              formattingBlocks.add(nested.index as number);
            return;
          case "content_block_delta": {
            const delta = record(nested.delta);
            const fields: Record<string, string> = {
              text_delta: "text",
              thinking_delta: "thinking",
              signature_delta: "signature",
              input_json_delta: "partial_json",
            };
            if (
              typeof delta.type !== "string" ||
              !Object.hasOwn(fields, delta.type)
            )
              invalid();
            if (typeof delta[fields[delta.type as string]] !== "string")
              invalid();
            if (
              delta.type === "input_json_delta" &&
              !formattingBlocks.has(nested.index as number)
            )
              forbidden();
            return;
          }
          case "content_block_stop":
            formattingBlocks.delete(nested.index as number);
            return;
          case "message_delta":
          case "message_stop":
          case "ping":
            return;
          case "error":
            throw classifyProviderError(nested);
          default:
            invalid();
        }
      }
      case "tool_progress":
        if (
          event.tool_name !== "StructuredOutput" ||
          !knownFormatId(event.tool_use_id)
        )
          forbidden();
        return;
      case "tool_use_summary":
        if (
          !Array.isArray(event.preceding_tool_use_ids) ||
          !event.preceding_tool_use_ids.length ||
          !event.preceding_tool_use_ids.every(knownFormatId)
        )
          forbidden();
        return;
      case "result":
        if (
          typeof event.subtype !== "string" ||
          ![
            "success",
            "error",
            "error_during_execution",
            "error_max_turns",
            "error_max_budget_usd",
            "error_max_structured_output_retries",
          ].includes(event.subtype)
        )
          invalid();
        if (event.is_error !== undefined && typeof event.is_error !== "boolean")
          invalid();
        if (
          event.permission_denials !== undefined &&
          (!Array.isArray(event.permission_denials) ||
            event.permission_denials.length)
        )
          forbidden();
        return;
      default:
        invalid();
    }
  };
}

export function createEventParser(
  provider: ProviderId,
  schema: object,
  onEvent?: (event: AIEvent) => void,
  limits: { maxLineBytes?: number; maxEvents?: number } = {},
) {
  const validate = compileOutputSchema(schema),
    decoder = new TextDecoder("utf-8", { fatal: true });
  const auditClaude = createClaudeAudit();
  const maxLine = limits.maxLineBytes ?? 2 * 1024 * 1024,
    maxEvents = limits.maxEvents ?? 10000;
  let pending = "",
    finalText: string | undefined,
    output: unknown,
    usage: Record<string, number> = {},
    observedModel: string | null = null;
  let terminal = false,
    finished = false,
    count = 0;
  const progress = (phase: "started" | "generating" | "retrying") =>
    emitEvent(onEvent, { type: "progress", phase });
  const accept = (line: string) => {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > maxLine || ++count > maxEvents)
      throw new AIError("output_limit");
    if (terminal) throw new AIError("invalid_envelope");
    const event = record(parse(line)),
      item = record(event.item);
    if (typeof event.type !== "string") throw new AIError("invalid_envelope");
    if (event.type === "error" || event.type === "turn.failed")
      throw classifyProviderError(event);
    if (provider === "codex") {
      if (event.type === "tool_progress" || event.type === "tool_use_summary")
        throw new AIError("tool_use_forbidden");
      // Codex rust-v0.154.0 exec_events.rs ThreadEvent discriminators.
      if (
        ![
          "item.started",
          "item.updated",
          "item.completed",
          "turn.completed",
          "thread.started",
          "turn.started",
        ].includes(event.type)
      )
        throw new AIError("invalid_envelope");
      if (
        ["item.started", "item.updated", "item.completed"].includes(event.type)
      ) {
        if (typeof item.type !== "string")
          throw new AIError("invalid_envelope");
        if (!["agent_message", "reasoning", "todo_list"].includes(item.type))
          throw new AIError("tool_use_forbidden");
        if (event.type === "item.completed" && item.type === "agent_message") {
          if (typeof item.text !== "string")
            throw new AIError("invalid_envelope");
          finalText = item.text;
          progress("generating");
        }
      } else if (event.type === "turn.completed") {
        if (finalText === undefined) throw new AIError("invalid_envelope");
        output = parse(finalText);
        usage = safeUsage(event.usage);
        terminal = true;
      } else if (
        event.type === "thread.started" ||
        event.type === "turn.started"
      )
        progress("started");
    } else {
      auditClaude(event);
      if (event.type === "system" && event.subtype === "init") {
        if (
          typeof event.model === "string" &&
          /^[A-Za-z0-9._:/-]{1,160}$/.test(event.model)
        )
          observedModel = event.model;
        progress("started");
      }
      if (event.type === "system" && event.subtype === "api_retry")
        progress("retrying");

      if (event.type === "assistant" || event.type === "stream_event")
        progress("generating");
      if (event.type === "result") {
        if (event.is_error === true || event.subtype !== "success")
          throw classifyProviderError(event);
        if (!Object.hasOwn(event, "structured_output"))
          throw new AIError("invalid_envelope");
        output = event.structured_output;
        usage = safeUsage(event.usage);
        terminal = true;
      }
    }
  };
  return {
    push(chunk: Buffer) {
      if (finished) throw new AIError("invalid_envelope");
      try {
        pending += decoder.decode(chunk, { stream: true });
      } catch {
        throw new AIError("invalid_json");
      }
      let index: number;
      while ((index = pending.indexOf("\n")) !== -1) {
        accept(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
      if (Buffer.byteLength(pending) > maxLine)
        throw new AIError("output_limit");
    },
    finish(): ParsedAnalysis {
      if (finished) throw new AIError("invalid_envelope");
      try {
        pending += decoder.decode();
      } catch {
        throw new AIError("invalid_json");
      }
      accept(pending);
      pending = "";
      finished = true;
      if (!terminal) throw new AIError("invalid_envelope");
      if (!validate(output)) throw new AIError("schema_mismatch");
      return { output, usage, observedModel };
    },
  };
}
