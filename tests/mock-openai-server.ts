import http from "node:http";
import type { AddressInfo } from "node:net";

const PREFIX = "/v1";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const SLOW_CHUNK_GAP_MS = 10;

export type MockRequestView = {
  path: string;
  method: string;
  hasAuthorization: boolean;
  authorizationMatches: boolean;
  body: unknown;
  responseFormatType?: string;
  tokenLimitField?: "max_completion_tokens" | "max_tokens";
  hasTools: boolean;
};

export type MockReplyObject = {
  status: number;
  json?: unknown;
  body?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  slowBodyChunks?: number;
};

export type MockReply =
  | MockReplyObject
  | ((req: MockRequestView) => MockReply | Promise<MockReply>);

export type MockOpenAIServer = {
  baseUrl: string;
  calls(): MockRequestView[];
  callCount(): number;
  reset(): void;
  close(): Promise<void>;
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function hasHeader(headers: Record<string, string>, name: string) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

function errorReply(
  status: number,
  message: string,
  code: string | null,
  param: string | null = null,
): MockReplyObject {
  return {
    status,
    json: {
      error: {
        message,
        type: status >= 500 ? "server_error" : "invalid_request_error",
        param,
        code,
      },
    },
  };
}

export function chatCompletion(content: string, extra: object = {}): object {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: 0,
    model: "mock-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, refusal: null },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    ...extra,
  };
}

export function unsupportedParamError(
  param: "response_format" | "max_completion_tokens",
): { status: 400; json: object } {
  return {
    status: 400,
    json: {
      error: {
        message: `Unsupported parameter: '${param}' is not supported with this model.`,
        type: "invalid_request_error",
        param,
        code: "unsupported_parameter",
      },
    },
  };
}

async function readBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) tooLarge = true;
    else chunks.push(chunk);
  }
  return { raw: Buffer.concat(chunks), tooLarge };
}

async function send(res: http.ServerResponse, reply: MockReplyObject) {
  if (reply.delayMs && reply.delayMs > 0) await sleep(reply.delayMs);
  const headers: Record<string, string> = { ...(reply.headers ?? {}) };
  let payload: Buffer;
  if (reply.json !== undefined) {
    payload = Buffer.from(JSON.stringify(reply.json), "utf8");
    if (!hasHeader(headers, "content-type"))
      headers["content-type"] = "application/json";
  } else {
    payload = Buffer.from(reply.body ?? "", "utf8");
    if (!hasHeader(headers, "content-type"))
      headers["content-type"] = "text/plain";
  }
  headers["content-length"] = String(payload.length);
  res.writeHead(reply.status, headers);
  const chunks = Math.max(1, reply.slowBodyChunks ?? 1);
  if (chunks <= 1 || payload.length === 0) {
    res.end(payload);
    return;
  }
  const size = Math.ceil(payload.length / chunks);
  for (let offset = 0; offset < payload.length; offset += size) {
    res.write(payload.subarray(offset, offset + size));
    if (offset + size < payload.length) await sleep(SLOW_CHUNK_GAP_MS);
  }
  res.end();
}

export async function startMockOpenAI(opts: {
  apiKey: string;
  replies?: MockReply[];
  fallback?: MockReply;
  supports?: {
    jsonSchema: boolean;
    jsonObject: boolean;
    maxCompletionTokens: boolean;
  };
}): Promise<MockOpenAIServer> {
  const supports = {
    jsonSchema: opts.supports?.jsonSchema ?? true,
    jsonObject: opts.supports?.jsonObject ?? true,
    maxCompletionTokens: opts.supports?.maxCompletionTokens ?? true,
  };
  const recorded: MockRequestView[] = [];
  const initialReplies = [...(opts.replies ?? [])];
  let queue = [...initialReplies];
  const expectedAuth = `Bearer ${opts.apiKey}`;

  async function respond(req: http.IncomingMessage, res: http.ServerResponse) {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const { raw, tooLarge } = await readBody(req);
    let parsed: unknown;
    try {
      parsed = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : undefined;
    } catch {
      parsed = undefined;
    }
    const auth = req.headers.authorization;
    const view: MockRequestView = {
      path,
      method: req.method ?? "",
      hasAuthorization: typeof auth === "string" && auth.length > 0,
      authorizationMatches: auth === expectedAuth,
      body: parsed,
      hasTools: false,
    };
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const b = parsed as Record<string, unknown>;
      const rf = b.response_format;
      if (
        rf &&
        typeof rf === "object" &&
        typeof (rf as Record<string, unknown>).type === "string"
      )
        view.responseFormatType = (rf as { type: string }).type;
      if ("max_completion_tokens" in b)
        view.tokenLimitField = "max_completion_tokens";
      else if ("max_tokens" in b) view.tokenLimitField = "max_tokens";
      view.hasTools =
        b.tools != null ||
        b.tool_choice != null ||
        b.functions != null ||
        b.function_call != null;
    }
    recorded.push(view);

    if (tooLarge)
      return send(
        res,
        errorReply(
          413,
          "Request body exceeds the mock limit of 2MiB.",
          "request_too_large",
        ),
      );
    if (req.method !== "POST" || path !== `${PREFIX}/chat/completions`)
      return send(
        res,
        errorReply(404, `Unknown request URL: ${req.method} ${path}`, null),
      );
    if (!view.authorizationMatches)
      return send(
        res,
        errorReply(
          401,
          view.hasAuthorization
            ? "Incorrect API key provided."
            : "You didn't provide an API key.",
          view.hasAuthorization ? "invalid_api_key" : null,
        ),
      );
    const formatUnsupported =
      (view.responseFormatType === "json_schema" && !supports.jsonSchema) ||
      (view.responseFormatType === "json_object" && !supports.jsonObject) ||
      (view.responseFormatType !== undefined &&
        !["json_schema", "json_object", "text"].includes(
          view.responseFormatType,
        ));
    if (formatUnsupported)
      return send(res, unsupportedParamError("response_format"));
    if (
      view.tokenLimitField === "max_completion_tokens" &&
      !supports.maxCompletionTokens
    )
      return send(res, unsupportedParamError("max_completion_tokens"));

    let reply: MockReply | undefined =
      queue.length > 0 ? queue.shift() : opts.fallback;
    while (typeof reply === "function") reply = await reply(view);
    if (!reply)
      return send(
        res,
        errorReply(
          500,
          "mock-openai-server: no reply configured for this request.",
          "no_reply",
        ),
      );
    return send(res, reply);
  }

  const server = http.createServer((req, res) => {
    respond(req, res).catch(() =>
      send(
        res,
        errorReply(500, "mock-openai-server: internal error.", "internal_error"),
      ).catch(() => res.destroy()),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;

  let closePromise: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${port}${PREFIX}`,
    calls: () => recorded.slice(),
    callCount: () => recorded.length,
    reset() {
      recorded.length = 0;
      queue = [...initialReplies];
    },
    close() {
      if (!closePromise)
        closePromise = new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
          server.closeAllConnections();
        });
      return closePromise;
    },
  };
}
