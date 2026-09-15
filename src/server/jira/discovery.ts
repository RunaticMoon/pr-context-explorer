import {
  discoverySettings,
  isIssueKey,
  parseRegisteredIssueLink,
  JiraConfigurationError,
} from "./config.ts";
export type JiraDeployment = "cloud" | "data_center";
export interface JiraSite {
  id: string;
  deployment: JiraDeployment;
  webBaseUrl: string;
  apiBaseUrl: string;
}
export interface DiscoveryConfig {
  sites: readonly JiraSite[];
  projectHosts: Readonly<Record<string, readonly string[]>>;
  /** Only [A-Z][A-Z0-9_]{m,n}, 0 <= m <= n <= 31. */
  projectKeyPattern?: string;
}
export interface DiscoveryInput {
  title?: string;
  body?: string;
  branch?: string;
  commits?: readonly { sha: string; subject: string; body: string }[];
  explicitLinks?: readonly string[];
}
export interface CandidateSource {
  id: string;
  fieldPath: string;
  kind:
    | "pr_title"
    | "pr_body"
    | "branch"
    | "commit_subject"
    | "commit_body"
    | "explicit_link"
    | "manual";
  text: string;
  commitSha?: string;
}
export interface CandidateProvenance {
  sourceId: string;
  fieldPath: string;
  start: number;
  end: number;
  matchedText: string;
  method: "issue_key" | "explicit_link" | "manual";
}
export interface JiraCandidate {
  id: string;
  host: string | null;
  connectionId: string | null;
  key: string;
  excluded: boolean;
  provenance: CandidateProvenance[];
}
export interface CandidateDiscovery {
  candidates: JiraCandidate[];
  sources: CandidateSource[];
  rejectedLinks: {
    sourceId: string;
    start: number;
    end: number;
    original: string;
    reason: string;
  }[];
}
export function candidateId(host: string | null, key: string): string {
  return JSON.stringify([host, key]);
}
export function discoverJiraCandidates(
  input: DiscoveryInput,
  config: DiscoveryConfig,
): CandidateDiscovery {
  const { sites, pattern } = discoverySettings(config);
  let sourceSize = 0;
  const sources: CandidateSource[] = [];
  const addSource = (
    kind: CandidateSource["kind"],
    fieldPath: string,
    text: string | undefined,
    commitSha?: string,
  ) => {
    if (text !== undefined) {
      sourceSize += text.length;
      if (sourceSize > 1_000_000 || sources.length >= 10_000)
        throw new JiraConfigurationError("Candidate source limit exceeded");
      sources.push({
        id: fieldPath,
        fieldPath,
        kind,
        text,
        ...(commitSha ? { commitSha } : {}),
      });
    }
  };
  addSource("pr_title", "/title", input.title);
  addSource("pr_body", "/body", input.body);
  addSource("branch", "/branch", input.branch);
  input.commits?.forEach((c, i) => {
    addSource("commit_subject", `/commits/${i}/subject`, c.subject, c.sha);
    addSource("commit_body", `/commits/${i}/body`, c.body, c.sha);
  });
  input.explicitLinks?.forEach((text, i) =>
    addSource("explicit_link", `/explicitLinks/${i}`, text),
  );
  const candidates = new Map<string, JiraCandidate>();
  const rejectedLinks: CandidateDiscovery["rejectedLinks"] = [];
  let occurrences = 0;
  const add = (
    key: string,
    site: JiraSite | undefined,
    source: CandidateSource,
    start: number,
    end: number,
    method: CandidateProvenance["method"],
  ) => {
    if (++occurrences > 10_000)
      throw new JiraConfigurationError("Candidate occurrence limit exceeded");
    const host = site?.webBaseUrl.replace(/\/$/, "") ?? null;
    const id = candidateId(host, key);
    const c = candidates.get(id) ?? {
      id,
      host,
      connectionId: site?.id ?? null,
      key,
      excluded: false,
      provenance: [],
    };
    c.provenance.push({
      sourceId: source.id,
      fieldPath: source.fieldPath,
      start,
      end,
      matchedText: source.text.slice(start, end),
      method,
    });
    candidates.set(id, c);
  };
  for (const source of sources) {
    const ranges: [number, number][] = [];
    for (const match of source.text.matchAll(
      /[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s<>"'\)\]]+/g,
    )) {
      const start = match.index,
        end = start + match[0].length;
      ranges.push([start, end]);
      const parsed = parseRegisteredIssueLink(
        match[0],
        sites,
        config.projectKeyPattern,
      );
      if (parsed)
        add(parsed.key, parsed.site, source, start, end, "explicit_link");
      else
        rejectedLinks.push({
          sourceId: source.id,
          start,
          end,
          original: match[0],
          reason: "not_a_registered_issue_link",
        });
    }
    if (source.kind === "explicit_link") continue;
    let rangeIndex = 0;
    for (const match of source.text.matchAll(
      new RegExp(
        `(?<![A-Za-z0-9_])${pattern}-[1-9][0-9]{0,19}(?![A-Za-z0-9_])`,
        "g",
      ),
    )) {
      const start = match.index,
        end = start + match[0].length;
      while (rangeIndex < ranges.length && ranges[rangeIndex][1] <= start)
        rangeIndex++;
      if (rangeIndex < ranges.length && start >= ranges[rangeIndex][0])
        continue;
      const ids = config.projectHosts[match[0].split("-")[0]] ?? [];
      if (!ids.length)
        add(match[0], undefined, source, start, end, "issue_key");
      for (const id of ids)
        add(
          match[0],
          sites.find((s) => s.id === id),
          source,
          start,
          end,
          "issue_key",
        );
    }
  }
  return { candidates: [...candidates.values()], sources, rejectedLinks };
}

export function addManualJiraCandidate(
  discovery: CandidateDiscovery,
  input: { connectionId: string; key: string; note?: string },
  config: DiscoveryConfig,
): CandidateDiscovery {
  const { sites } = discoverySettings(config);
  const site = sites.find((s) => s.id === input.connectionId);
  if (!site)
    throw new JiraConfigurationError(
      "Manual candidate requires registered site",
    );
  if (!isIssueKey(input.key, config.projectKeyPattern))
    throw new JiraConfigurationError("Invalid issue key");
  if ((input.note?.length ?? 0) > 4096 || discovery.sources.length >= 10_000)
    throw new JiraConfigurationError("Manual source limit exceeded");
  const result = structuredClone(discovery);
  const fieldPath = `/manual/${result.sources.filter((s) => s.kind === "manual").length}`;
  const text = input.key + (input.note === undefined ? "" : `\n${input.note}`);
  result.sources.push({ id: fieldPath, fieldPath, kind: "manual", text });
  const id = candidateId(site.webBaseUrl, input.key);
  let candidate = result.candidates.find((c) => c.id === id);
  if (!candidate) {
    candidate = {
      id,
      host: site.webBaseUrl,
      connectionId: site.id,
      key: input.key,
      excluded: false,
      provenance: [],
    };
    result.candidates.push(candidate);
  }
  candidate.provenance.push({
    sourceId: fieldPath,
    fieldPath,
    start: 0,
    end: input.key.length,
    matchedText: input.key,
    method: "manual",
  });
  return result;
}

export function setJiraCandidateExcluded(
  discovery: CandidateDiscovery,
  id: string,
  excluded: boolean,
): CandidateDiscovery {
  const result = structuredClone(discovery);
  const candidate = result.candidates.find((c) => c.id === id);
  if (!candidate)
    throw new JiraConfigurationError("Unknown candidate identity");
  candidate.excluded = excluded;
  return result;
}
