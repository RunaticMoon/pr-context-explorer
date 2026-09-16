import { createHash } from "node:crypto";
import { GitHubClient, validateConnection, type Connection } from "./github.ts";
import {
  createGitHubSession,
  deleteGitHubSession,
  githubSessionAvailable,
} from "./github-session-secrets.ts";
export function connectionView(c: Connection) {
  return {
    ...c,
    credentialState:
      c.auth.kind === "session"
        ? githubSessionAvailable(c.auth.sessionId)
          ? "session"
          : "required"
        : "external",
  };
}
export async function connectGitHub(
  body: any,
  client: (c: Connection) => GitHubClient,
  signal?: AbortSignal,
) {
  let ref: string | undefined;
  let cancel: (() => void) | undefined;
  try {
    signal?.throwIfAborted();
    if (
      !body ||
      typeof body !== "object" ||
      Object.keys(body).some(
        (k) => !["webUrl", "token", "apiUrl", "apiVersion"].includes(k),
      )
    )
      throw Error();
    const web = new URL(body.webUrl);
    const webUrl = web.origin + (web.pathname === "/" ? "" : web.pathname);
    if (body.webUrl !== webUrl && body.webUrl !== webUrl + "/") throw Error();
    const type =
      web.hostname === "github.com"
        ? "github"
        : web.hostname.endsWith(".ghe.com")
          ? "ghe-cloud"
          : "ghes";
    const apiUrl =
      body.apiUrl ||
      (type === "github"
        ? "https://api.github.com"
        : type === "ghe-cloud"
          ? "https://api." + web.hostname
          : webUrl + "/api/v3");
    // Validation precedes any network request. Only the explicitly supplied host
    // (or GitHub's documented cloud API pair) receives the credential.
    const draft = validateConnection({
      id: "discovery",
      type,
      webUrl,
      apiUrl,
      apiVersion: body.apiVersion || "2022-11-28",
      account: "discovery",
      auth: { kind: "public" },
    });
    ref = createGitHubSession(body.token);
    draft.auth = { kind: "session", sessionId: ref };
    const { data, headers } = await new Promise<
      Awaited<ReturnType<GitHubClient["request"]>>
    >((resolve, reject) => {
      cancel = () => {
        if (ref) deleteGitHubSession(ref);
        reject(Error("GitHub connection cancelled"));
      };
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) {
        cancel();
        return;
      }
      client(draft).request("/user", signal).then(resolve, reject);
    });
    signal?.throwIfAborted();
    if (
      typeof data?.login !== "string" ||
      !/^[-\w.]{1,100}$/.test(data.login) ||
      !Number.isSafeInteger(data.id) ||
      data.id <= 0
    )
      throw Error();
    const serverVersion =
      type === "ghes" &&
      /^\d+\.\d+(\.\d+)?$/.test(headers["x-github-enterprise-version"] || "")
        ? headers["x-github-enterprise-version"]
        : undefined;
    return validateConnection({
      ...draft,
      account: data.login,
      id:
        "gh-" +
        createHash("sha256")
          .update(JSON.stringify([webUrl, apiUrl, data.id]))
          .digest("hex")
          .slice(0, 32),
      ...(serverVersion ? { serverVersion } : {}),
    });
  } catch {
    if (ref) deleteGitHubSession(ref);
    // Never reflect upstream bodies, headers, URL input or transport exceptions.
    throw Error(
      "GitHub connection failed: check HTTPS Web URL, PAT access/expiry, SSO, VPN/CA and proxy policy. No redirects are followed.",
    );
  } finally {
    if (cancel) signal?.removeEventListener("abort", cancel);
  }
}
