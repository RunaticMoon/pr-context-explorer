import { createHash } from "node:crypto";
import { nodeJiraTransport } from "./transport.ts";
import { validateJsonBounds } from "./schema.ts";
import { jsonObject } from "./normalize.ts";
import type {
  JiraConnection,
  JiraAdapterDependencies,
  JiraFailureState,
  JiraSourceCapture,
  JiraTransportResponse,
} from "./types.ts";
import type { JiraLimits } from "./connection.ts";

export class JiraReadError extends Error {
  constructor(
    readonly state: JiraFailureState,
    readonly reason: string,
  ) {
    super(reason);
  }
}
/** One deadline/byte budget spans credential lookup and every request in a capture. */
export class JiraReadSession {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly cancel: () => void;
  private bytes = 0;
  private readonly deadline: number;
  private headers: Record<string, string> | null = null;
  private readonly pendingBodies = new Set<AsyncIterator<Uint8Array>>();
  constructor(
    private readonly config: JiraConnection,
    private readonly limits: JiraLimits,
    private readonly dependencies: JiraAdapterDependencies,
    private readonly external?: AbortSignal,
  ) {
    this.deadline = performance.now() + limits.timeoutMs;
    this.cancel = () =>
      this.controller.abort(
        new JiraReadError("communication_error", "cancelled"),
      );
    this.timer = setTimeout(
      () =>
        this.controller.abort(
          new JiraReadError("communication_error", "timeout"),
        ),
      limits.timeoutMs,
    );
    if (external?.aborted) this.cancel();
    else external?.addEventListener("abort", this.cancel, { once: true });
  }
  async bounded<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => {
          this.check();
          return operation();
        })
        .then(resolve, reject)
        .finally(() => this.signal.removeEventListener("abort", abort));
    });
  }
  check(): void {
    if (!this.signal.aborted && performance.now() >= this.deadline)
      this.controller.abort(
        new JiraReadError("communication_error", "timeout"),
      );
    if (this.signal.aborted) throw this.signal.reason;
  }
  close(): void {
    clearTimeout(this.timer);
    this.external?.removeEventListener("abort", this.cancel);
    this.controller.abort(
      new JiraReadError("communication_error", "cancelled"),
    );
    for (const iterator of this.pendingBodies) {
      // An uncooperative injected iterator must not defeat the deadline during cleanup.
      try {
        void Promise.resolve(iterator.return?.()).catch(() => {});
      } catch {
        /* best-effort only */
      }
    }
    this.pendingBodies.clear();
    this.headers = null;
  }
  private async credentials(): Promise<Record<string, string>> {
    if (this.headers) return this.headers;
    const credential = this.config.credential;
    if (!credential)
      throw new JiraReadError("unconnected", "credentials_unavailable");
    let result: Record<string, string> | null;
    try {
      result =
        credential.kind === "callback"
          ? await this.bounded(async () =>
              credential.resolve({
                connectionId: this.config.id,
                apiOrigin: new URL(this.config.apiBaseUrl).origin,
                signal: this.signal,
              }),
            )
          : process.env[credential.variable]
            ? {
                authorization: `${credential.scheme} ${process.env[credential.variable]}`,
              }
            : null;
    } catch (error) {
      if (error instanceof JiraReadError) throw error;
      throw new JiraReadError("unconnected", "credentials_unavailable");
    }
    const entries =
      result && typeof result === "object" ? Object.entries(result) : [];
    if (
      entries.length !== 1 ||
      entries[0][0].toLowerCase() !== "authorization" ||
      typeof entries[0][1] !== "string" ||
      entries[0][1].length > 16_384 ||
      !/^(Bearer|Basic) [\x21-\x7E]+$/.test(entries[0][1])
    )
      throw new JiraReadError("unconnected", "credentials_unavailable");
    this.headers = {
      accept: "application/json",
      "accept-encoding": "identity",
      authorization: entries[0][1],
    };
    return this.headers;
  }
  async get(url: URL): Promise<JiraSourceCapture> {
    this.check();
    // Even internal callers must remain within the registered API base/path.
    if (
      !url.href.startsWith(this.config.apiBaseUrl + "/rest/api/") ||
      url.origin !== new URL(this.config.apiBaseUrl).origin ||
      url.username ||
      url.password
    )
      throw new JiraReadError("communication_error", "invalid_endpoint");
    const headers = await this.credentials();
    const response: JiraTransportResponse = await this.bounded(() =>
      (this.dependencies.transport ?? nodeJiraTransport)({
        url: url.href,
        method: "GET",
        headers: { ...headers },
        signal: this.signal,
        customCaPem: this.config.customCaPem,
      }),
    );
    const iterator = response.body[Symbol.asyncIterator]();
    this.pendingBodies.add(iterator);
    if ([401, 403, 404].includes(response.status))
      throw new JiraReadError("unknown_or_forbidden", "unknown_or_forbidden");
    if (response.status !== 200)
      throw new JiraReadError(
        "communication_error",
        response.status === 429
          ? "rate_limited"
          : response.status >= 300 && response.status < 400
            ? "redirect_rejected"
            : "http_error",
      );
    const normalizedHeaders = Object.fromEntries(
      Object.entries(response.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const contentType = normalizedHeaders["content-type"];
    if (
      contentType &&
      !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(contentType)
    )
      throw new JiraReadError("communication_error", "invalid_response");
    if (
      normalizedHeaders["content-encoding"] &&
      normalizedHeaders["content-encoding"] !== "identity"
    )
      throw new JiraReadError(
        "communication_error",
        "unsupported_content_encoding",
      );
    const declared = normalizedHeaders["content-length"];
    if (
      declared &&
      (!/^[0-9]+$/.test(declared) ||
        Number(declared) > this.limits.maxResponseBytes ||
        Number(declared) > this.limits.maxTotalBytes - this.bytes)
    )
      throw new JiraReadError("communication_error", "response_too_large");
    const chunks: Buffer[] = [];
    let length = 0;
    while (true) {
      const next = await this.bounded(() => iterator.next());
      if (next.done) break;
      if (!(next.value instanceof Uint8Array))
        throw new JiraReadError("communication_error", "invalid_response");
      length += next.value.byteLength;
      this.bytes += next.value.byteLength;
      if (
        length > this.limits.maxResponseBytes ||
        this.bytes > this.limits.maxTotalBytes
      )
        throw new JiraReadError("communication_error", "response_too_large");
      chunks.push(Buffer.from(next.value));
    }
    this.pendingBodies.delete(iterator);
    this.check();
    const bytes = Buffer.concat(chunks);
    const rawResponse = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    // Reject, never redact and relabel credential-bearing bytes as exact evidence.
    const token = headers.authorization.slice(
      headers.authorization.indexOf(" ") + 1,
    );
    if (
      rawResponse.includes(headers.authorization) ||
      rawResponse.includes(token)
    )
      throw new JiraReadError("communication_error", "credential_reflection");
    const raw: unknown = JSON.parse(rawResponse);
    validateJsonBounds(raw);
    // JSON escapes can hide credentials on the wire, including in property names.
    // Bounds were checked iteratively above; inspect every decoded key/value before
    // any issue, comment, parent or related source is returned or normalized.
    const pending: unknown[] = [raw];
    while (pending.length) {
      this.check();
      const value = pending.pop();
      if (typeof value === "string" && value.includes(token))
        throw new JiraReadError("communication_error", "credential_reflection");
      if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          if (key.includes(token))
            throw new JiraReadError(
              "communication_error",
              "credential_reflection",
            );
          pending.push(child);
        }
      }
    }
    this.check();
    if (!jsonObject(raw))
      throw new JiraReadError("communication_error", "invalid_response");
    return {
      rawResponse,
      raw,
      sourceHash: createHash("sha256").update(bytes).digest("hex"),
      fetchedAt: (this.dependencies.now?.() ?? new Date()).toISOString(),
      requestPath: url.pathname + url.search,
    };
  }
}
export function readFailure(error: unknown): {
  state: JiraFailureState;
  reason: string;
} {
  return error instanceof JiraReadError
    ? { state: error.state, reason: error.reason }
    : {
        state: "communication_error",
        reason: "invalid_response_or_network_error",
      };
}
