import { randomBytes } from "node:crypto";
import { approvedBaseUrl } from "./jira/config.ts";
import { connectionSettings } from "./jira/connection.ts";
import { JiraReadSession, readFailure } from "./jira/session.ts";
import type { JiraAdapterDependencies, JiraConnection } from "./jira/types.ts";

export interface JiraConnectInput {
  deployment: "cloud" | "data_center";
  webUrl: string;
  authentication: "token" | "anonymous" | "env";
  email?: string;
  token?: string;
  advanced?: {
    apiBaseUrl?: string;
    customCaPem?: string;
    projectKeys?: string[];
    acceptanceCriteriaFields?: { id: string }[];
    projectKeyPattern?: string;
    credential?: { kind: "env"; variable: string; scheme: "Basic" | "Bearer" };
  };
}
export interface JiraConnectionSummary {
  status: "connected" | "anonymous";
  authentication: "verified" | "anonymous";
  accountId: string | null;
  webBaseUrl: string;
  apiBaseUrl: string;
  apiVersion: "2" | "3";
  serverVersion: string | null;
  metadataStatus: string;
}
/** Process memory only. No environment mutation, disk vault, or browser secret reference. */
export class JiraOnboardingSession {
  #closed = false;
  #active = new Set<JiraReadSession>();
  #secrets = new Map<
    string,
    { binding: string; authorization: string; controller: AbortController }
  >();
  constructor(private readonly dependencies: JiraAdapterDependencies = {}) {}
  private binding(c: JiraConnection) {
    return JSON.stringify([
      c.id,
      c.deployment,
      c.webBaseUrl,
      c.apiBaseUrl,
      c.accountContextId,
      c.customCaPem ?? null,
    ]);
  }
  bind(c: JiraConnection): JiraConnection {
    const saved = this.#secrets.get(c.id);
    if (!saved || saved.binding !== this.binding(c)) return c;
    const binding = saved.binding;
    return {
      ...c,
      credential: {
        kind: "callback",
        signal: saved.controller.signal,
        resolve: (context) => {
          const current = this.#secrets.get(c.id);
          return context.connectionId === c.id &&
            context.apiOrigin === new URL(c.apiBaseUrl).origin &&
            current === saved &&
            current.binding === binding
            ? { authorization: current.authorization }
            : null;
        },
      },
    };
  }
  forget(id: string) {
    this.#secrets.get(id)?.controller.abort();
    this.#secrets.delete(id);
  }
  close() {
    this.#closed = true;
    for (const session of this.#active) session.close();
    this.#active.clear();
    for (const id of this.#secrets.keys()) this.forget(id);
  }
  async connect(
    input: JiraConnectInput,
  ): Promise<{ connection: JiraConnection; summary: JiraConnectionSummary }> {
    if (
      !input ||
      typeof input !== "object" ||
      Object.keys(input).some(
        (k) =>
          ![
            "deployment",
            "webUrl",
            "authentication",
            "email",
            "token",
            "advanced",
          ].includes(k),
      )
    )
      throw Error("Invalid Jira connection request");
    if (this.#closed) throw Error("Jira connection session closed");
    const endpoint = simpleJiraEndpoint(input.deployment, input.webUrl);
    const advanced = input.advanced ?? {};
    if (
      typeof advanced !== "object" ||
      Array.isArray(advanced) ||
      Object.keys(advanced).some(
        (k) =>
          ![
            "apiBaseUrl",
            "customCaPem",
            "projectKeys",
            "acceptanceCriteriaFields",
            "projectKeyPattern",
            "credential",
          ].includes(k),
      )
    )
      throw Error("Invalid advanced Jira settings");
    const apiBaseUrl = advanced.apiBaseUrl
      ? approvedBaseUrl(advanced.apiBaseUrl)
      : endpoint.apiBaseUrl;
    if (new URL(apiBaseUrl).origin !== new URL(endpoint.webBaseUrl).origin)
      throw Error(
        "Cross-origin Jira API mapping is unsupported; scoped Cloud tokens need a separate cloud-ID flow",
      );
    if (/[\/]rest\/api(?:\/|$)/.test(new URL(apiBaseUrl).pathname))
      throw Error("Advanced API base must not include /rest/api");
    if (!["token", "anonymous", "env"].includes(input.authentication))
      throw Error("Unsupported authentication mode");
    let authorization: string | undefined;
    let credential: JiraConnection["credential"];
    if (input.authentication === "token") {
      if (
        typeof input.token !== "string" ||
        !/^[\x21-\x7e]{1,8192}$/.test(input.token)
      )
        throw Error("A valid Jira token is required");
      if (
        input.deployment === "cloud" &&
        (typeof input.email !== "string" ||
          !/^[^\s:@]+@[^\s:@]+$/.test(input.email) ||
          input.email.length > 254)
      )
        throw Error("Cloud account email is required");
      authorization =
        input.deployment === "cloud"
          ? "Basic " +
            Buffer.from(`${input.email}:${input.token}`).toString("base64")
          : "Bearer " + input.token;
      credential = {
        kind: "callback",
        resolve: () => ({ authorization: authorization! }),
      };
    } else if (input.authentication === "env") {
      const env = advanced.credential;
      if (
        !env ||
        env.kind !== "env" ||
        !/^PRCE_[A-Z][A-Z0-9_]{0,80}$/.test(env.variable) ||
        !["Basic", "Bearer"].includes(env.scheme) ||
        Object.keys(env).some(
          (k) => !["kind", "variable", "scheme"].includes(k),
        )
      )
        throw Error(
          "Dedicated PRCE_ credential environment reference required",
        );
      credential = { ...env };
    }
    if (
      input.authentication !== "token" &&
      (input.token !== undefined || input.email !== undefined)
    )
      throw Error("Credentials provided for the wrong authentication mode");
    if (
      (process.env.HTTPS_PROXY || process.env.https_proxy) &&
      !this.dependencies.transport
    )
      throw Error("proxy_configuration: use approved direct/VPN access");
    const connection: JiraConnection = {
      id: "jira_" + randomBytes(16).toString("hex"),
      deployment: input.deployment,
      webBaseUrl: endpoint.webBaseUrl,
      apiBaseUrl,
      accountContextId: "anonymous",
      ...(input.authentication === "anonymous"
        ? { authentication: "anonymous" as const }
        : input.authentication === "token"
          ? { authentication: "session" as const }
          : { credential }),
      ...(advanced.customCaPem !== undefined
        ? { customCaPem: advanced.customCaPem }
        : {}),
      ...(advanced.acceptanceCriteriaFields !== undefined
        ? { acceptanceCriteriaFields: advanced.acceptanceCriteriaFields }
        : {}),
      ...(advanced.projectKeyPattern !== undefined
        ? { projectKeyPattern: advanced.projectKeyPattern }
        : {}),
    };
    const validated = connectionSettings(
      { ...connection, credential },
      input.deployment,
    );
    const session = new JiraReadSession(
      validated.config,
      validated.limits,
      this.dependencies,
    );
    this.#active.add(session);
    try {
      let identity: string | null = null;
      if (input.authentication !== "anonymous") {
        const myself = (
          await session.get(
            new URL(
              `${connection.apiBaseUrl}/rest/api/${endpoint.apiVersion}/myself`,
            ),
          )
        ).raw;
        const value =
          input.deployment === "cloud" ? myself.accountId : myself.name;
        if (
          typeof value !== "string" ||
          !value ||
          value.length > 200 ||
          /[\x00-\x1f\x7f]/.test(value)
        )
          throw Error("Invalid identity");
        identity = value;
        connection.accountContextId = identity;
      }
      let serverVersion: string | null = null,
        metadataStatus = "unavailable";
      try {
        const info = (
          await session.get(
            new URL(
              `${connection.apiBaseUrl}/rest/api/${endpoint.apiVersion}/serverInfo`,
            ),
          )
        ).raw;
        if (typeof info.version === "string" && info.version.length <= 100) {
          serverVersion = info.version;
          metadataStatus = "verified";
        }
      } catch (error) {
        metadataStatus = readFailure(error).reason;
        if (input.authentication === "anonymous") throw error;
      }
      if (this.#closed) throw Error("Jira connection session closed");
      if (authorization)
        this.#secrets.set(connection.id, {
          binding: this.binding(connection),
          authorization,
          controller: new AbortController(),
        });
      return {
        connection,
        summary: {
          status: identity ? "connected" : "anonymous",
          authentication: identity ? "verified" : "anonymous",
          accountId: identity,
          webBaseUrl: connection.webBaseUrl,
          apiBaseUrl: connection.apiBaseUrl,
          apiVersion: endpoint.apiVersion,
          serverVersion,
          metadataStatus,
        },
      };
    } catch (error) {
      const failure = readFailure(error);
      throw Error(`Jira connection failed: ${failure.reason}`);
    } finally {
      this.#active.delete(session);
      session.close();
    }
  }
}

export function simpleJiraEndpoint(deployment: unknown, webUrl: string) {
  if (deployment !== "cloud" && deployment !== "data_center")
    throw Error("Invalid Jira deployment");
  const webBaseUrl = approvedBaseUrl(webUrl);
  // Simple onboarding accepts an instance, not arbitrary pages/API/issue links.
  const path = new URL(webBaseUrl).pathname;
  if (path !== "/" && !(deployment === "data_center" && path === "/jira"))
    throw Error(
      "Enter the Jira instance URL (Data Center /jira context supported)",
    );
  if (new URL(webBaseUrl).hostname === "api.atlassian.com")
    throw Error(
      "Scoped Cloud tokens require a separate cloud-ID flow; use a conventional API token",
    );
  return {
    webBaseUrl,
    apiBaseUrl: webBaseUrl,
    apiVersion: deployment === "cloud" ? ("3" as const) : ("2" as const),
  };
}
