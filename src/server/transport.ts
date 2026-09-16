import https from "node:https";
import { lookup } from "node:dns";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Connection } from "./github.ts";
import { githubSessionToken } from "./github-session-secrets.ts";
export type HTTPResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
};
export type Transport = (
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
) => Promise<HTTPResult>;
export const httpsGet: Transport = async (url, headers, signal) => {
  if (process.env.HTTPS_PROXY || process.env.https_proxy)
    throw Error(
      "proxy_configuration: HTTPS proxy transport is not implemented; use approved direct/VPN access. TLS verification is never disabled.",
    );
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        headers,
        signal,
        timeout: 30000,
        rejectUnauthorized: true,
        lookup: (host, options, callback) => {
          lookup(host, options, (err, address, family) => {
            const list = Array.isArray(address)
              ? address.map((x) => x.address)
              : [address];
            if (
              list.some(
                (a) =>
                  !a ||
                  /^(127\.|169\.254\.|0\.|::1$|fe80:|::ffff:(127\.|169\.254\.))/i.test(
                    a,
                  ),
              )
            )
              return callback(
                Error("blocked loopback/link-local endpoint"),
                "",
                4,
              );
            callback(err, address as any, family);
          });
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) {
            req.destroy(Error("response_limit"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode || 0,
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([k, v]) => [
                k,
                Array.isArray(v) ? v.join(",") : v || "",
              ]),
            ),
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    const deadline = setTimeout(
      () => req.destroy(Error("request_timeout")),
      45000,
    );
    deadline.unref();
    req.on("close", () => clearTimeout(deadline));
    req.on("timeout", () => req.destroy(Error("request_timeout")));
    req.on("error", (e: any) =>
      reject(
        Error(
          e.name === "AbortError"
            ? "cancelled"
            : `transport_error ${e.code || ""}: check DNS/VPN/CA/SSO; no insecure TLS fallback`,
        ),
      ),
    );
    req.end();
  });
};
export async function resolveCredential(c: Connection): Promise<string> {
  if (c.auth.kind === "session") return githubSessionToken(c.auth.sessionId);
  if (c.auth.kind === "public") return "";
  if (c.auth.kind === "env") {
    const t = process.env[c.auth.envName];
    if (!t || /[\r\n\0]/.test(t) || t.length > 8192)
      throw Error(
        "authentication_required: set the configured PRCE_ secret in the server environment",
      );
    return t;
  }
  try {
    const { stdout } = await promisify(execFile)(
      "gh",
      ["auth", "token", "--hostname", new URL(c.webUrl).hostname],
      {
        timeout: 10000,
        maxBuffer: 16384,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ...(process.env.XDG_CONFIG_HOME
            ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
            : {}),
          GH_PROMPT_DISABLED: "1",
        },
      },
    );
    const token = stdout.trim();
    if (!token || /[\r\n\0]/.test(token)) throw Error();
    return token;
  } catch {
    throw Error(
      "gh_auth_unavailable: install official gh and run gh auth login --hostname <approved host> outside this app",
    );
  }
}
