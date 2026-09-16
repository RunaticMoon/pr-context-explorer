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
    const revoked =
      config.credential?.kind === "callback"
        ? config.credential.signal
        : undefined;
    if (revoked?.aborted) this.cancel();
    else revoked?.addEventListener("abort", this.cancel, { once: true });
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
    if (this.config.credential?.kind === "callback")
      this.config.credential.signal?.removeEventListener("abort", this.cancel);
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
  }
  private async credentials(): Promise<Record<string, string>> {
    // Resolve each request; callback credentials may have been revoked.
    const credential = this.config.credential;
    if (!credential && this.config.authentication === "anonymous")
      return {
        accept: "application/json",
        "accept-encoding": "identity",
      };
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
    return {
      accept: "application/json",
      "accept-encoding": "identity",
      authorization: entries[0][1],
    };
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
    const authorization = headers.authorization ?? "";
    const token = authorization.slice(authorization.indexOf(" ") + 1);
    const secrets = token ? [authorization, token] : [];
    if (authorization.startsWith("Basic ")) {
      const decoded = Buffer.from(token, "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon >= 0 && decoded.slice(colon + 1))
        secrets.push(decoded, decoded.slice(colon + 1));
    }
    const reflects = (value: string) =>
      secrets.some((secret) => value.includes(secret));
    if (reflects(rawResponse))
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
      if (typeof value === "string" && reflects(value))
        throw new JiraReadError("communication_error", "credential_reflection");
      if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          if (reflects(key))
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
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  if (
    [
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "CERT_HAS_EXPIRED",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ].includes(code)
  )
    return { state: "communication_error", reason: "tls_certificate_error" };
  return error instanceof JiraReadError
    ? { state: error.state, reason: error.reason }
    : {
        state: "communication_error",
        reason: "invalid_response_or_network_error",
      };
}
