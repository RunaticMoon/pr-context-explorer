import type { JiraSite, DiscoveryConfig } from "./discovery.ts";

/** Configuration errors contain fixed messages, never credentials or URL input. */
export class JiraConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraConfigurationError";
  }
}

export function approvedBaseUrl(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\\\s%?#]/.test(value) ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(value)
  ) {
    throw new JiraConfigurationError("Invalid registered HTTPS endpoint");
  }
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new JiraConfigurationError("Invalid registered HTTPS endpoint");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    !u.hostname ||
    u.pathname.includes("//") ||
    !u.pathname.split("/").every((segment) => /^[A-Za-z0-9_-]*$/.test(segment))
  ) {
    throw new JiraConfigurationError("Invalid registered HTTPS endpoint");
  }
  return `${u.origin}${u.pathname.replace(/\/$/, "")}`;
}

/** Deliberately a bounded grammar, not caller-supplied JavaScript regex. */
export function projectPattern(pattern = "[A-Z][A-Z0-9_]{0,19}"): string {
  const m = /^\[A-Z\]\[A-Z0-9_\]\{(\d{1,2}),(\d{1,2})\}$/.exec(pattern);
  if (!m || +m[1] > +m[2] || +m[2] > 31)
    throw new JiraConfigurationError("Unsupported bounded project key pattern");
  return `[A-Z][A-Z0-9_]{${+m[1]},${+m[2]}}`;
}
export function isIssueKey(key: string, pattern?: string): boolean {
  return (
    typeof key === "string" &&
    key.length <= 53 &&
    new RegExp(`^${projectPattern(pattern)}-[1-9][0-9]{0,19}$`).test(key)
  );
}
export function registeredSites(sites: readonly JiraSite[]): JiraSite[] {
  if (!Array.isArray(sites) || sites.length > 100)
    throw new JiraConfigurationError("Registered site limit exceeded");
  const ids = new Set<string>(),
    hosts = new Set<string>();
  return sites.map((site) => {
    if (
      !/^[A-Za-z0-9_-]{1,80}$/.test(site.id) ||
      !["cloud", "data_center"].includes(site.deployment)
    )
      throw new JiraConfigurationError("Invalid registered site");
    const webBaseUrl = approvedBaseUrl(site.webBaseUrl),
      apiBaseUrl = approvedBaseUrl(site.apiBaseUrl);
    if (ids.has(site.id) || hosts.has(webBaseUrl))
      throw new JiraConfigurationError("Duplicate registered site identity");
    ids.add(site.id);
    hosts.add(webBaseUrl);
    return { id: site.id, deployment: site.deployment, webBaseUrl, apiBaseUrl };
  });
}
export function discoverySettings(config: DiscoveryConfig): {
  sites: JiraSite[];
  pattern: string;
} {
  const sites = registeredSites(config.sites),
    pattern = projectPattern(config.projectKeyPattern);
  if (Object.keys(config.projectHosts).length > 1000)
    throw new JiraConfigurationError("Project mapping limit exceeded");
  for (const [key, ids] of Object.entries(config.projectHosts)) {
    if (!isIssueKey(`${key}-1`, config.projectKeyPattern))
      throw new JiraConfigurationError("Invalid project mapping key");
    if (
      !Array.isArray(ids) ||
      ids.length > sites.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !sites.some((s) => s.id === id))
    )
      throw new JiraConfigurationError(
        "Project mapping references unregistered site",
      );
  }
  return { sites, pattern };
}

export function parseRegisteredIssueLink(
  value: string,
  sites: readonly JiraSite[],
  pattern?: string,
): { site: JiraSite; key: string } | null {
  if (
    value.length > 4096 ||
    /[\\\s%]/.test(value) ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(value)
  )
    return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    for (const site of sites) {
      const base = new URL(site.webBaseUrl);
      const prefix = base.pathname.replace(/\/$/, "") + "/browse/";
      if (u.origin !== base.origin || !u.pathname.startsWith(prefix)) continue;
      const key = u.pathname.slice(prefix.length);
      if (isIssueKey(key, pattern)) return { site, key };
    }
  } catch {
    /* Untrusted source links are rejected, not followed. */
  }
  return null;
}
