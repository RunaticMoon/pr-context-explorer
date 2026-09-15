import { request } from "node:https";
import type { JiraTransport } from "./types.ts";
/** No redirects, proxy environment, cookie jar, or external agents. TLS verification is explicit. */
export const nodeJiraTransport: JiraTransport = async (input) =>
  new Promise((resolve, reject) => {
    const req = request(
      input.url,
      {
        method: "GET",
        headers: input.headers,
        signal: input.signal,
        agent: false,
        rejectUnauthorized: true,
        maxHeaderSize: 16_384,
        ...(input.customCaPem ? { ca: input.customCaPem } : {}),
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers))
          if (value !== undefined)
            headers[key] = Array.isArray(value) ? value.join(", ") : value;
        resolve({ status: res.statusCode ?? 0, headers, body: res });
      },
    );
    req.on("error", reject);
    req.end();
  });
