import { isIP } from "node:net";
import { httpsGet, resolveCredential, type Transport } from "./transport.ts";
export type Connection = {
  id: string;
  type: "github" | "ghe-cloud" | "ghes";
  webUrl: string;
  apiUrl: string;
  apiVersion: string;
  account: string;
  serverVersion?: string;
  auth:
    | { kind: "gh" }
    | { kind: "env"; envName: string }
    | { kind: "public" }
    | { kind: "session"; sessionId: string };
};
export type PullRef = { owner: string; repo: string; number: number };
function reflectsCredential(value: unknown, token: string): boolean {
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string" && item.includes(token)) return true;
    if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        if (key.includes(token)) return true;
        pending.push(child);
      }
    }
  }
  return false;
}
export function validateConnection(value: unknown): Connection {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("connection object required");
  const c = value as Connection;
  if (
    ["id", "account", "apiVersion", "webUrl", "apiUrl", "type"].some(
      (key) => typeof (value as any)[key] !== "string",
    )
  )
    throw Error("all explicit connection fields required");
  const allowed = [
    "id",
    "type",
    "webUrl",
    "apiUrl",
    "apiVersion",
    "account",
    "serverVersion",
    "auth",
  ];
  if (Object.keys(c).some((k) => !allowed.includes(k)))
    throw Error("unknown connection field; never submit tokens");
  if (
    !/^[a-zA-Z0-9_-]{1,64}$/.test(c.id) ||
    !["github", "ghe-cloud", "ghes"].includes(c.type) ||
    !/^[-\w.]{1,100}$/.test(c.account) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(c.apiVersion)
  )
    throw Error("invalid connection identity/version");
  const endpoint = (raw: string) => {
    const u = new URL(raw);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.port ||
      isIP(u.hostname) ||
      u.hostname === "localhost" ||
      !u.hostname.includes(".") ||
      u.hostname.endsWith(".localhost")
    )
      throw Error(
        "explicit HTTPS DNS endpoint required (no IP/port/credentials)",
      );
    return u;
  };
  const web = endpoint(c.webUrl),
    api = endpoint(c.apiUrl);
  const basePath = web.pathname === "/" ? "" : web.pathname;
  if (
    c.webUrl !== web.origin + basePath ||
    c.apiUrl.endsWith("/") ||
    (basePath &&
      (c.type !== "ghes" ||
        !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(basePath)))
  )
    throw Error("canonical endpoint without trailing slash required");
  if (
    c.type === "github" &&
    (c.webUrl !== "https://github.com" || c.apiUrl !== "https://api.github.com")
  )
    throw Error("github.com API pairing required");
  if (
    c.type === "ghe-cloud" &&
    !(
      (web.hostname === "github.com" && api.hostname === "api.github.com") ||
      (web.hostname.endsWith(".ghe.com") &&
        (api.hostname === "api." + web.hostname ||
          api.hostname === web.hostname))
    )
  )
    throw Error("Enterprise Cloud API must match approved web host");
  if (c.type === "ghe-cloud" && api.pathname !== "/")
    throw Error("Enterprise Cloud API path");
  if (
    c.type === "ghes" &&
    (web.hostname !== api.hostname ||
      api.pathname !== basePath + "/api/v3" ||
      (c.serverVersion !== undefined &&
        !/^\d+\.\d+(\.\d+)?$/.test(c.serverVersion)))
  )
    throw Error(
      "GHES same host /api/v3 and valid optional serverVersion required",
    );
  if (
    !c.auth ||
    Object.keys(c.auth).some(
      (k) => !["kind", "envName", "sessionId"].includes(k),
    ) ||
    !["gh", "env", "public", "session"].includes(c.auth.kind)
  )
    throw Error("auth must be gh, env-name, or public");
  if (
    c.auth.kind === "env" &&
    !/^PRCE_[A-Z][A-Z0-9_]{0,80}$/.test(c.auth.envName)
  )
    throw Error("use dedicated PRCE_ secret environment name");
  if (c.auth.kind !== "env" && "envName" in c.auth)
    throw Error("unexpected environment name");
  if (
    c.auth.kind === "session"
      ? !/^[a-f0-9]{48}$/.test(c.auth.sessionId)
      : "sessionId" in c.auth
  )
    throw Error("invalid session reference");
  return structuredClone(c);
}
export function parsePullURL(raw: string, c: Connection): PullRef {
  const u = new URL(raw);
  if (raw !== u.href)
    throw Error("noncanonical PR URL rejected without normalization");
  if (
    u.origin !== new URL(c.webUrl).origin ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    raw.includes("%") ||
    raw.includes("\\")
  )
    throw Error(
      "PR URL must use the registered exact host without credentials/query",
    );
  const prefix = new URL(c.webUrl).pathname.replace(/\/$/, "");
  if (!u.pathname.startsWith(prefix + "/"))
    throw Error("PR URL outside registered base path");
  const m = u.pathname
    .slice(prefix.length)
    .match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/);
  if (
    !m ||
    [".", ".."].includes(m[1]) ||
    [".", ".."].includes(m[2]) ||
    !Number.isSafeInteger(Number(m[3]))
  )
    throw Error("invalid PR URL");
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

export type PullItem = {
  number: number;
  title: string;
  html_url: string;
  state: string;
  draft: boolean;
};
export type ListFilter = {
  tab: "authored" | "review-requested";
  repository?: string;
  organization?: string;
  author?: string;
  state?: string;
  draft?: string;
  search?: string;
  page?: number;
};
export class GitHubClient {
  readonly connection: Connection;
  private transport: Transport;
  private credential: () => Promise<string>;
  constructor(
    c: Connection,
    options: { transport?: Transport; credential?: () => Promise<string> } = {},
  ) {
    this.connection = validateConnection(c);
    this.transport = options.transport || httpsGet;
    this.credential = options.credential || (() => resolveCredential(c));
  }
  async request(route: string, signal?: AbortSignal) {
    if (
      !route.startsWith("/") ||
      route.startsWith("//") ||
      route.includes("..") ||
      route.includes("\\")
    )
      throw Error("API route not allowed");
    const token = await this.credential();
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "PR-Context-Explorer",
      "X-GitHub-Api-Version": this.connection.apiVersion,
    };
    if (token) headers.Authorization = "Bearer " + token;
    const response = await this.transport(
      this.connection.apiUrl + route,
      headers,
      signal,
    );
    if (
      token &&
      (response.body.includes(token) ||
        reflectsCredential(response.headers, token))
    )
      throw Error("credential_reflection: upstream response rejected");
    if (response.status >= 300 && response.status < 400)
      throw Error("redirect_denied: credentials never forwarded");
    if (
      response.status === 429 ||
      (response.status === 403 &&
        response.headers["x-ratelimit-remaining"] === "0")
    )
      throw Error(
        "rate_limit: reset " +
          (response.headers["x-ratelimit-reset"] || "unknown"),
      );
    if (response.status === 401)
      throw Error("authentication_required: expired or invalid credential");
    if (response.status === 403 || response.status === 404)
      throw Error(
        "unknown_or_forbidden: check repository access, SSO approval and endpoint",
      );
    if (response.status !== 200) throw Error("github_http_" + response.status);

    if (response.body.length > 8 * 1024 * 1024) throw Error("response_limit");
    let data: any;
    try {
      data = JSON.parse(response.body);
    } catch {
      throw Error("invalid_github_json");
    }
    // JSON escapes can hide credential reflections in nested fields or keys.
    if (token && reflectsCredential(data, token))
      throw Error("credential_reflection: decoded upstream body rejected");
    return { data, headers: response.headers };
  }
  async verify(signal?: AbortSignal): Promise<{ login: string; id: number }> {
    if (this.connection.auth.kind === "public")
      throw Error(
        "public mode has no authenticated /user; use a direct public PR URL",
      );
    const { data } = await this.request("/user", signal);
    if (
      typeof data.login !== "string" ||
      !Number.isSafeInteger(data.id) ||
      data.login.toLowerCase() !== this.connection.account.toLowerCase()
    )
      throw Error("authenticated account does not match configured account");
    return { login: data.login, id: data.id };
  }
  async list(f: ListFilter, signal?: AbortSignal) {
    const user = await this.verify(signal);
    const page = f.page ?? 1;
    if (
      !["authored", "review-requested"].includes(f.tab) ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > 10
    )
      throw Error("invalid list page/tab (search max 1000)");
    const q = [
      "is:pr",
      f.tab === "authored"
        ? "author:" + user.login
        : "review-requested:" + user.login,
    ];
    for (const [key, value, regex] of [
      ["repo", f.repository, /^[\w.-]+\/[\w.-]+$/],
      ["org", f.organization, /^[\w.-]+$/],
      ["author", f.author, /^[\w.-]+$/],
    ] as const)
      if (value) {
        if (!regex.test(value)) throw Error("invalid filter");
        q.push(key + ":" + value);
      }
    if (f.state && f.state !== "all") {
      if (!["open", "closed", "merged"].includes(f.state))
        throw Error("invalid state");
      q.push("is:" + f.state);
    }
    if (f.draft && f.draft !== "all") {
      if (!["true", "false"].includes(f.draft)) throw Error("invalid draft");
      q.push("draft:" + f.draft);
    }
    if (f.search) {
      if (f.search.length > 200 || /[\r\n:]/.test(f.search))
        throw Error("search must be plain text, not qualifiers");
      q.push(JSON.stringify(f.search));
    }
    const params = new URLSearchParams({
      q: q.join(" "),
      per_page: "100",
      page: String(page),
      sort: "updated",
      order: "desc",
    });
    const { data, headers } = await this.request(
      "/search/issues?" + params,
      signal,
    );
    if (
      !Array.isArray(data.items) ||
      !Number.isSafeInteger(data.total_count) ||
      data.total_count < 0
    )
      throw Error("invalid search response");
    const items: PullItem[] = data.items.map((x: any) => {
      parsePullURL(x.html_url, this.connection);
      if (!Number.isSafeInteger(x.number) || typeof x.title !== "string")
        throw Error("invalid PR item");
      return {
        number: x.number,
        title: x.title,
        html_url: x.html_url,
        state: x.state,
        draft: !!x.draft,
      };
    });
    const hasMore =
      page < 10 &&
      (page * 100 < Math.min(1000, data.total_count) ||
        !!headers.link?.includes('rel="next"'));
    return {
      items,
      page,
      total: data.total_count,
      hasMore,
      complete:
        !hasMore && !data.incomplete_results && data.total_count <= 1000,
      limitReason:
        data.total_count > 1000
          ? "GitHub Search API cap: 1000; narrow filters"
          : data.incomplete_results
            ? "GitHub incomplete_results"
            : null,
      rateRemaining: headers["x-ratelimit-remaining"] ?? null,
    };
  }
  async pull(ref: PullRef, signal?: AbortSignal) {
    parsePullURL(
      `${this.connection.webUrl}/${ref.owner}/${ref.repo}/pull/${ref.number}`,
      this.connection,
    );
    const { data } = await this.request(
      `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
      signal,
    );
    const sha = /^[a-f0-9]{40}$/;
    if (
      !sha.test(data.base?.sha) ||
      !sha.test(data.head?.sha) ||
      typeof data.title !== "string" ||
      !data.base?.repo?.full_name
    )
      throw Error("invalid PR metadata");
    const returned = parsePullURL(data.html_url, this.connection);
    if (
      data.number !== ref.number ||
      returned.number !== ref.number ||
      returned.owner.toLowerCase() !== ref.owner.toLowerCase() ||
      returned.repo.toLowerCase() !== ref.repo.toLowerCase()
    )
      throw Error("PR response identity mismatch");
    return data;
  }
  async pages(ref: PullRef, kind: "commits" | "files", signal?: AbortSignal) {
    const items: any[] = [];
    const cap = kind === "commits" ? 250 : 3000;
    let complete = false;
    for (let page = 1; items.length < cap; page++) {
      const { data, headers } = await this.request(
        `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/${kind}?per_page=100&page=${page}`,
        signal,
      );
      if (!Array.isArray(data)) throw Error("invalid paginated response");
      items.push(...data.slice(0, cap - items.length));
      if (!headers.link?.includes('rel="next"')) {
        complete = items.length < cap;
        break;
      }
    }
    return {
      items,
      complete,
      limitReason: complete
        ? null
        : `GitHub PR ${kind} endpoint cap ${cap}; Git objects are authoritative`,
    };
  }
}
