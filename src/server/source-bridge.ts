import {
  JiraCloudAdapter,
  JiraDataCenterAdapter,
  discoverJiraCandidates,
  captureJiraCandidates,
  addManualJiraCandidate,
  setJiraCandidateExcluded,
  type JiraConnection,
  type CandidateDiscovery,
  type JiraAdapterDependencies,
  type JiraBatchCapture,
} from "./jira/index.ts";
import { hash } from "./git.ts";
import { cacheKey, type LocalStore } from "./store.ts";
import {
  JiraOnboardingSession,
  type JiraConnectInput,
} from "./jira-onboarding.ts";
import type { LiveSnapshot, SourceEvidence } from "./live-git.ts";
/** Routed only behind the existing loopback session/CSRF gate. */
export class SourceBridge {
  private readonly session: JiraOnboardingSession;
  private connecting = false;
  private closed = false;
  private readonly settingsKey = cacheKey({ settings: "jira" });
  constructor(
    private readonly store: LocalStore,
    private readonly dependencies: JiraAdapterDependencies = {},
  ) {
    this.session = new JiraOnboardingSession(dependencies);
  }
  bind = (connection: JiraConnection) => this.session.bind(connection);
  close() {
    this.closed = true;
    this.session.close();
  }
  private settings() {
    return (
      this.store.get<JiraSettings>("config", this.settingsKey) ??
      structuredClone(emptyJiraSettings)
    );
  }
  capture(
    s: LiveSnapshot,
    x: JiraSettings,
    d: CandidateDiscovery,
    options: {
      signal?: AbortSignal;
      dependencies?: JiraAdapterDependencies;
    } = {},
  ) {
    return captureForSnapshot(s, x, d, {
      ...options,
      dependencies: options.dependencies ?? this.dependencies,
      bind: this.bind,
    });
  }
  async handle(
    method: string,
    url: URL,
    body: unknown,
  ): Promise<{ status: number; data: unknown } | null> {
    if (this.closed && method !== "GET")
      throw Error("Jira connection session closed");
    if (url.pathname === "/api/jira/settings") {
      if (method === "GET") return { status: 200, data: this.settings() };
      if (method === "POST") {
        if (this.connecting)
          return {
            status: 409,
            data: { error: "Jira connection in progress" },
          };
        const settings = validateJiraSettings(body);
        const previous = this.settings();
        this.store.put("config", this.settingsKey, settings);
        for (const old of previous.connections) {
          const next = settings.connections.find((c) => c.id === old.id);
          if (!next || JSON.stringify(next) !== JSON.stringify(old))
            this.session.forget(old.id);
        }
        return { status: 201, data: this.settings() };
      }
    }
    if (url.pathname !== "/api/jira/connect" || method !== "POST") return null;
    if (this.connecting)
      return { status: 409, data: { error: "Jira connection in progress" } };
    this.connecting = true;
    let id: string | undefined;
    try {
      const input = body as JiraConnectInput;
      // Bound optional project inputs before any remote read; never repair invalid keys.
      const keys = input?.advanced?.projectKeys ?? [];
      if (
        !Array.isArray(keys) ||
        keys.length > 100 ||
        keys.some(
          (k) => typeof k !== "string" || !/^[A-Z][A-Z0-9_]{0,19}$/.test(k),
        )
      )
        throw Error("Invalid Jira project keys");
      const current = this.settings();
      if (current.connections.length >= 12)
        throw Error("Jira connection limit reached");
      const result = await this.session.connect(input);
      id = result.connection.id;
      if (this.closed) throw Error("Jira connection session closed");
      const replaced = current.connections.filter(
        (c) => c.webBaseUrl === result.connection.webBaseUrl,
      );
      const projectHosts = Object.fromEntries(
        Object.entries(current.projectHosts).map(([key, ids]) => [
          key,
          ids.map((old) => (replaced.some((c) => c.id === old) ? id! : old)),
        ]),
      );
      for (const key of keys)
        projectHosts[key] = [...new Set([...(projectHosts[key] ?? []), id])];
      const settings = validateJiraSettings({
        ...current,
        connections: [
          ...current.connections.filter((c) => !replaced.includes(c)),
          result.connection,
        ],
        projectHosts,
      });
      this.store.put("config", this.settingsKey, settings);
      replaced.forEach((c) => this.session.forget(c.id));
      return {
        status: 201,
        data: { settings: this.settings(), summary: result.summary },
      };
    } catch (error) {
      if (id) this.session.forget(id);
      // All underlying validation/read errors are fixed strings; never serialize requests or responses.
      return {
        status: 400,
        data: {
          error:
            error instanceof Error &&
            /^(Invalid |Enter the |Scoped |Cross-origin |Advanced |Unsupported |A valid |Cloud account |Dedicated |Credentials provided |proxy_configuration:|Jira connection)/.test(
              error.message,
            )
              ? error.message
              : "Jira connection failed: invalid_configuration_or_response",
        },
      };
    } finally {
      this.connecting = false;
    }
  }
}

export type JiraSettings = {
  connections: JiraConnection[];
  projectHosts: Record<string, string[]>;
  projectKeyPattern?: string;
};
export const emptyJiraSettings: JiraSettings = {
  connections: [],
  projectHosts: {},
};
export function validateJiraSettings(input: unknown): JiraSettings {
  const x = input as JiraSettings;
  if (
    !x ||
    typeof x !== "object" ||
    Object.keys(x).some(
      (k) => !["connections", "projectHosts", "projectKeyPattern"].includes(k),
    ) ||
    !Array.isArray(x.connections) ||
    x.connections.length > 12 ||
    !x.projectHosts ||
    typeof x.projectHosts !== "object"
  )
    throw Error("invalid Jira settings");
  for (const c of x.connections) {
    if (
      !c ||
      Object.keys(c).some(
        (k) =>
          ![
            "id",
            "deployment",
            "webBaseUrl",
            "apiBaseUrl",
            "accountContextId",
            "authentication",
            "customCaPem",
            "credential",
            "acceptanceCriteriaFields",
            "projectKeyPattern",
          ].includes(k),
      )
    )
      throw Error(
        "unsupported Jira connection field; paths/secrets belong only to server",
      );
    if (
      c.credential &&
      (c.credential.kind !== "env" ||
        !/^PRCE_[A-Z][A-Z0-9_]{0,80}$/.test(c.credential.variable) ||
        Object.keys(c.credential).some(
          (k) => !["kind", "variable", "scheme"].includes(k),
        ))
    )
      throw Error(
        "Jira credentials must use a dedicated PRCE_ env name, never a browser token",
      );
    adapter(c);
  }
  discoverJiraCandidates({}, discoveryConfig(x));
  return structuredClone(x);
}
const discoveryConfig = (x: JiraSettings) => ({
  sites: x.connections,
  projectHosts: x.projectHosts,
  projectKeyPattern: x.projectKeyPattern,
});
const adapter = (c: JiraConnection, dependencies?: JiraAdapterDependencies) =>
  c.deployment === "cloud"
    ? new JiraCloudAdapter(c, dependencies)
    : new JiraDataCenterAdapter(c, dependencies);
export function discoverForSnapshot(
  s: LiveSnapshot,
  x: JiraSettings,
): CandidateDiscovery {
  validateJiraSettings(x);
  return discoverJiraCandidates(
    {
      title: s.pr.title,
      body: s.pr.body,
      branch: s.pr.headRef,
      commits: s.phases.map((p) => ({
        sha: p.sha,
        subject: p.subject,
        body: p.body,
      })),
    },
    discoveryConfig(x),
  );
}
export function editCandidates(
  d: CandidateDiscovery,
  x: JiraSettings,
  edit: {
    candidateId?: string;
    excluded?: boolean;
    connectionId?: string;
    key?: string;
  },
) {
  if (edit.candidateId) {
    if (typeof edit.excluded !== "boolean")
      throw Error("excluded boolean required");
    return setJiraCandidateExcluded(d, edit.candidateId, edit.excluded);
  }
  if (typeof edit.connectionId !== "string" || typeof edit.key !== "string")
    throw Error("manual Jira connection/key required");
  return addManualJiraCandidate(
    d,
    { connectionId: edit.connectionId, key: edit.key },
    discoveryConfig(x),
  );
}
export async function captureForSnapshot(
  s: LiveSnapshot,
  x: JiraSettings,
  d: CandidateDiscovery,
  options: {
    signal?: AbortSignal;
    dependencies?: JiraAdapterDependencies;
    bind?: (connection: JiraConnection) => JiraConnection;
  } = {},
): Promise<LiveSnapshot> {
  validateJiraSettings(x);
  if (
    (process.env.HTTPS_PROXY || process.env.https_proxy) &&
    !options.dependencies?.transport
  )
    throw Error(
      "proxy_configuration: Jira proxy not enabled; use approved direct/VPN access",
    );
  const batch = await captureJiraCandidates(
    d.candidates,
    x.connections.map((c) =>
      adapter(options.bind?.(c) ?? c, options.dependencies),
    ),
    { signal: options.signal, maxCandidates: 20 },
  );
  options.signal?.throwIfAborted();
  const snapshotId = cacheKey({
    gitSnapshot: s.snapshotId,
    jiraCapture: batch.captureHash,
    settings: x,
    discovery: d,
  });
  const sources: SourceEvidence[] = s.sourceEvidence
      .filter((e) => e.sourceKind !== "jira")
      .map((e) => ({ ...e, snapshotId })),
    jiraSnapshotHashes: string[] = [];
  for (const item of batch.items) {
    if (item.result.state !== "captured") continue;
    const j = item.result.snapshot;
    jiraSnapshotHashes.push(j.captureHash);
    for (const doc of [
      j.title,
      j.description,
      ...j.acceptanceCriteria.map((c) => c.document),
    ])
      if (doc.present && doc.text) {
        sources.push({
          id:
            "jira:" +
            hash(
              [
                j.identity.host,
                j.identity.issueId,
                doc.pointer,
                j.captureHash,
              ].join(":"),
            ).slice(0, 24),
          sourceKind: "jira",
          snapshotId,
          sourceId: j.webUrl,
          contentHash: hash(doc.text),
          version: j.captureHash,
          fieldPath: doc.pointer,
          text: doc.text,
          host: j.identity.host,
          issueId: j.identity.issueId,
          issueKey: j.identity.issueKey,
          fetchedAt: j.fetchedAt,
          updatedAt: j.updatedAt || undefined,
        });
      }
  }
  const missing = batch.items
    .filter((i) => i.result.state !== "captured")
    .map((i) => i.candidate.key + ": " + i.result.state);
  return {
    ...structuredClone(s),
    snapshotId,
    capturedAt: new Date().toISOString(),
    jiraStatus: batch.state,
    jiraSnapshotHashes,
    evidence: s.evidence.map((e) => ({ ...e, snapshotId })),
    sourceEvidence: sources,
    jiraData: { discovery: d, batch },
    coverage: {
      ...s.coverage,
      unavailable: [...s.coverage.unavailable, ...missing],
      complete:
        s.coverage.complete &&
        missing.length === 0 &&
        batch.omittedCandidateIds.length === 0,
    },
  };
}
