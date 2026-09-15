import path from "node:path";
export function validStatusSender(
  event: { sender: unknown; senderFrame?: { url: string } | null },
  contents: { mainFrame: unknown },
  origin: string,
  args: unknown[],
): boolean {
  if (
    args.length ||
    event.sender !== contents ||
    event.senderFrame !== contents.mainFrame
  )
    return false;
  try {
    const url = new URL(event.senderFrame!.url);
    return url.origin === origin && url.pathname === "/" && !url.search;
  } catch {
    return false;
  }
}
export function signatureAllowed(
  signedBuild: boolean,
  packaged: boolean,
  platform: string,
  team: string,
  metadata: string,
  verified: boolean,
): boolean {
  return (
    signedBuild &&
    packaged &&
    platform === "darwin" &&
    /^[A-Z0-9]{10}$/.test(team) &&
    verified &&
    metadata.split("\n").includes("TeamIdentifier=" + team) &&
    metadata
      .split("\n")
      .includes("Identifier=com.runaticmoon.pr-context-explorer") &&
    /^Authority=Developer ID Application:/m.test(metadata) &&
    /flags=0x[0-9a-f]+\(runtime\)/i.test(metadata)
  );
}
export const REPOSITORY = {
  owner: "RunaticMoon",
  repo: "pr-context-explorer",
} as const;
/** Re-applied at EVERY request, including redirects. No wildcard hosts. */
export function updateRequest(
  raw: string,
  input: Record<string, unknown> = {},
): Record<string, string> {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    throw Error("Update destination denied");
  const api = url.hostname === "api.github.com";
  if (
    api
      ? !/^\/repos\/RunaticMoon\/pr-context-explorer\/releases(?:\/latest|\/assets\/[0-9]+)?$/.test(
          url.pathname,
        )
      : ![
          "release-assets.githubusercontent.com",
          "objects.githubusercontent.com",
          "github-releases.githubusercontent.com",
        ].includes(url.hostname)
  )
    throw Error("Update destination denied");
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase();
    if (
      typeof value === "string" &&
      ([
        "accept",
        "user-agent",
        "range",
        "cache-control",
        "x-github-api-version",
      ].includes(lower) ||
        (api && lower === "authorization"))
    )
      result[lower] = value;
  }
  return result;
}

export function backendEnvironment(
  data: string,
  nodeDirectory: string,
  _inherited: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    HOME: path.join(data, "home"),
    TMPDIR: path.join(data, "tmp"),
    PATH: `${nodeDirectory}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PRCE_DATA_DIR: path.join(data, "live"),
    PRCE_FIXTURE_DIR: path.join(data, "demo"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}
