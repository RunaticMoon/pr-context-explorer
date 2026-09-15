import { isIssueKey } from "./config.ts";
import { connectionSettings } from "./connection.ts";
import type { JiraLimits } from "./connection.ts";
import { JiraReadError, JiraReadSession, readFailure } from "./session.ts";
import { validateIssue } from "./schema.ts";
import {
  jsonObject,
  normalizeJiraDocument,
  JIRA_NORMALIZER_VERSION,
} from "./normalize.ts";
import {
  collectOptional,
  updateCaptureHash,
  validCaptureOptions,
} from "./optional.ts";
import type { JiraSite } from "./discovery.ts";
import type {
  JiraConnection,
  JiraAdapterDependencies,
  JiraCaptureResult,
  JiraReadAdapter,
  JiraIssueSnapshot,
  JiraCaptureOptions,
} from "./types.ts";

class JiraAdapter implements JiraReadAdapter {
  readonly site: JiraSite;
  #config: JiraConnection;
  #limits: JiraLimits;
  #dependencies: JiraAdapterDependencies;
  constructor(
    config: JiraConnection,
    deployment: "cloud" | "data_center",
    dependencies: JiraAdapterDependencies = {},
  ) {
    const settings = connectionSettings(config, deployment);
    this.#config = settings.config;
    this.#limits = settings.limits;
    this.#dependencies = { ...dependencies };
    this.site = Object.freeze({
      id: this.#config.id,
      deployment: this.#config.deployment,
      webBaseUrl: this.#config.webBaseUrl,
      apiBaseUrl: this.#config.apiBaseUrl,
    });
  }
  async capture(
    issueKeyOrId: string,
    options: JiraCaptureOptions = {},
  ): Promise<JiraCaptureResult> {
    if (
      typeof issueKeyOrId !== "string" ||
      (!isIssueKey(issueKeyOrId, this.#config.projectKeyPattern) &&
        !/^[1-9][0-9]{0,19}$/.test(issueKeyOrId))
    )
      return {
        state: "communication_error",
        reason: "invalid_issue_identifier",
      };
    if (!validCaptureOptions(options))
      return {
        state: "communication_error",
        reason: "invalid_capture_options",
      };
    // Copy options too: async credential callbacks cannot race validation by mutating caller state.
    const scope = {
      ...options,
      comments: options.comments ? { ...options.comments } : undefined,
      related: options.related ? { ...options.related } : undefined,
    };
    const session = new JiraReadSession(
      this.#config,
      this.#limits,
      this.#dependencies,
      scope.signal,
    );
    try {
      const snapshot = await this.#readIssue(issueKeyOrId, session, scope);
      await collectOptional(snapshot, scope, this.#config, session, (id) =>
        this.#readIssue(id, session, {}),
      );
      updateCaptureHash(snapshot, scope);
      return { state: "captured", snapshot };
    } catch (error) {
      return readFailure(error);
    } finally {
      session.close();
    }
  }
  async #readIssue(
    identifier: string,
    session: JiraReadSession,
    options: JiraCaptureOptions,
  ): Promise<JiraIssueSnapshot> {
    const fields = [
      "summary",
      "description",
      "status",
      "issuetype",
      "updated",
      ...(this.#config.acceptanceCriteriaFields ?? []).map((f) => f.id),
    ];
    if (options.parent) fields.push("parent");
    if (options.related) fields.push("issuelinks");
    const url = new URL(
      `${this.#config.apiBaseUrl}/rest/api/${this.#config.deployment === "cloud" ? "3" : "2"}/issue/${identifier}`,
    );
    url.searchParams.set("fields", fields.join(","));
    const source = await session.get(url);
    const { raw, sourceHash, fetchedAt } = source;
    if (
      !validateIssue(raw, this.#config.deployment) ||
      !jsonObject(raw.fields) ||
      !isIssueKey(String(raw.key), this.#config.projectKeyPattern) ||
      (isIssueKey(identifier, this.#config.projectKeyPattern)
        ? raw.key !== identifier
        : raw.id !== identifier)
    )
      throw new JiraReadError("communication_error", "invalid_response");
    const f = raw.fields;
    const snapshot: JiraIssueSnapshot = {
      schemaVersion: "jira-snapshot-v1",
      normalizerVersion: JIRA_NORMALIZER_VERSION,
      deployment: this.#config.deployment,
      identity: {
        connectionId: this.#config.id,
        accountContextId: this.#config.accountContextId,
        host: this.#config.webBaseUrl,
        issueId: String(raw.id),
        issueKey: String(raw.key),
      },
      webUrl: `${this.#config.webBaseUrl}/browse/${raw.key}`,
      fetchedAt,
      updatedAt: typeof f.updated === "string" ? f.updated : null,
      sourceHash,
      captureHash: "",
      source,
      title: normalizeJiraDocument(f.summary, "/fields/summary"),
      description: normalizeJiraDocument(f.description, "/fields/description"),
      status: normalizeJiraDocument(
        jsonObject(f.status) ? f.status.name : undefined,
        "/fields/status/name",
      ),
      issueType: normalizeJiraDocument(
        jsonObject(f.issuetype) ? f.issuetype.name : undefined,
        "/fields/issuetype/name",
      ),
      acceptanceCriteria: (this.#config.acceptanceCriteriaFields ?? []).map(
        (field) => ({
          fieldId: field.id,
          label: field.label ?? null,
          document: normalizeJiraDocument(f[field.id], `/fields/${field.id}`),
        }),
      ),
      comments: [],
      commentPages: [],
      parent: null,
      related: [],
      coverage: {
        comments: { state: "not_requested", retrieved: 0, total: null },
        related: { state: "not_requested", retrieved: 0, total: null },
        parent: { state: "not_requested", retrieved: 0, total: null },
      },
    };
    updateCaptureHash(snapshot, options);
    session.check();
    return snapshot;
  }
}
/** Jira Cloud REST API v3, including ADF descriptions. */
export class JiraCloudAdapter extends JiraAdapter {
  constructor(
    config: JiraConnection,
    dependencies: JiraAdapterDependencies = {},
  ) {
    super(config, "cloud", dependencies);
  }
}
/** Jira Data Center REST API v2, with literal wiki/plain descriptions. */
export class JiraDataCenterAdapter extends JiraAdapter {
  constructor(
    config: JiraConnection,
    dependencies: JiraAdapterDependencies = {},
  ) {
    super(config, "data_center", dependencies);
  }
}
