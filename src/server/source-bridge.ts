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
import { cacheKey } from "./store.ts";
import type { LiveSnapshot, SourceEvidence } from "./live-git.ts";
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
    x.connections.map((c) => adapter(c, options.dependencies)),
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
