import { validToken } from "./session.ts";
import { createServer, type IncomingMessage } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  existsSync,
  lstatSync,
  realpathSync,
  openSync,
  constants,
  closeSync,
} from "node:fs";
import path from "node:path";
import { collect } from "./git.ts";
import { MockProvider, CodexProvider, ClaudeCodeProvider } from "./provider.ts";
import { LiveAPI, type LiveAPIOptions } from "./live-api.ts";
async function readBody(req: IncomingMessage) {
  if (Number(req.headers["content-length"] || 0) > 16384)
    throw Object.assign(Error("request body limit 16 KiB"), { status: 413 });
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384)
      throw Object.assign(Error("request body limit 16 KiB"), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  if (req.headers["content-type"]?.split(";")[0] !== "application/json")
    throw Object.assign(Error("application/json required"), { status: 415 });
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Error("invalid JSON body");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("JSON object required");
  return value;
}
export async function createApp(
  port: number,
  options: LiveAPIOptions & { dist?: string; desktopKey?: string } = {},
) {
  if (options.desktopKey !== undefined && !validToken(options.desktopKey))
    throw Error("invalid desktop capability");
  const snapshot = collect(),
    analysis = await new MockProvider().analyze(snapshot),
    live = new LiveAPI(options);
  const sessions = new Map<string, { expires: number; csrf: string }>();
  const assets = new Map<string, string>();
  const dist = path.resolve(options.dist || "dist");
  if (existsSync(dist) && !lstatSync(dist).isSymbolicLink()) {
    const scan = (dir: string) => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isSymbolicLink()) continue;
        if (f.isDirectory()) scan(p);
        else if (f.isFile()) assets.set("/" + path.relative(dist, p), p);
      }
    };
    scan(dist);
    if (assets.has("/index.html")) assets.set("/", assets.get("/index.html")!);
  }
  const server = createServer(async (req, res) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    const send = (code: number, data: unknown) => {
      if (res.writableEnded) return;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    try {
      const address = server.address();
      const actualPort =
        port || (address && typeof address !== "string" ? address.port : 0);
      const origin = `http://127.0.0.1:${actualPort}`,
        host = `127.0.0.1:${actualPort}`;
      if (options.desktopKey) {
        const key = req.headers["x-prce-desktop"];
        if (
          typeof key !== "string" ||
          !validToken(key) ||
          !timingSafeEqual(Buffer.from(key), Buffer.from(options.desktopKey))
        )
          return send(403, { error: "Desktop capability required" });
      }
      if (
        req.headers.host !== host ||
        (req.headers.origin && req.headers.origin !== origin) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        return send(403, { error: "Host/Origin 거부" });
      if ((req.url || "").length > 4096)
        return send(414, { error: "URL limit" });
      const url = new URL(req.url || "/", origin);
      if (url.origin !== origin)
        return send(403, { error: "absolute request URL denied" });
      if (url.pathname === "/api/session" && req.method === "POST") {
        if (req.headers.origin !== origin)
          return send(403, { error: "정확한 Origin 필요" });
        await readBody(req);
        for (const [key, v] of sessions)
          if (v.expires < Date.now()) sessions.delete(key);
        if (sessions.size >= 32) sessions.delete(sessions.keys().next().value!);
        const token = randomBytes(32).toString("hex"),
          csrf = randomBytes(32).toString("hex");
        sessions.set(token, { expires: Date.now() + 8 * 3600000, csrf });
        res.setHeader(
          "Set-Cookie",
          `prce_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
        );
        return send(200, { ok: true, csrf });
      }
      if (url.pathname.startsWith("/api/")) {
        const token =
          req.headers.cookie
            ?.split(";")
            .map((x) => x.trim())
            .find((x) => x.startsWith("prce_session="))
            ?.slice(13) || "";
        let session: { expires: number; csrf: string } | undefined;
        if (validToken(token))
          for (const [key, value] of sessions)
            if (
              timingSafeEqual(Buffer.from(token), Buffer.from(key)) &&
              value.expires > Date.now()
            )
              session = value;
        if (!session) return send(401, { error: "로컬 세션 필요" });
        const mutation = req.method !== "GET";
        if (mutation) {
          const csrf = req.headers["x-prce-csrf"];
          if (
            req.headers.origin !== origin ||
            typeof csrf !== "string" ||
            !validToken(csrf) ||
            !timingSafeEqual(Buffer.from(csrf), Buffer.from(session.csrf))
          )
            return send(403, { error: "정확한 Origin + CSRF 필요" });
        }
        if (!["GET", "POST", "DELETE"].includes(req.method || ""))
          return send(405, { error: "method" });
        const body = mutation ? await readBody(req) : {};
        if (url.pathname === "/api/snapshot" && req.method === "GET")
          return send(200, {
            snapshot,
            analysis,
            providers: [
              new MockProvider(),
              new CodexProvider(),
              new ClaudeCodeProvider(),
            ].map((p) => p.capability()),
          });
        const result = await live.handle(req.method!, url, body);
        if (result) return send(result.status, result.data);
        return send(404, { error: "지원하지 않는 API" });
      }
      if (req.method !== "GET") return send(405, { error: "method" });
      const file = assets.get(url.pathname);
      if (!file) return send(404, { error: "자산 없음; npm run build 확인" });
      const real = realpathSync(file);
      if (
        real !== file ||
        !real.startsWith(dist + path.sep) ||
        lstatSync(file).isSymbolicLink()
      )
        return send(404, { error: "unsafe asset" });
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        res.setHeader(
          "Content-Type",
          (
            {
              ".html": "text/html; charset=utf-8",
              ".js": "application/javascript",
              ".css": "text/css",
              ".svg": "image/svg+xml",
              ".woff": "font/woff",
              ".woff2": "font/woff2",
            } as Record<string, string>
          )[path.extname(file)] || "application/octet-stream",
        );
        res.end(readFileSync(fd));
      } finally {
        closeSync(fd);
      }
    } catch (e: any) {
      send(e.status || 400, { error: live.safeError(e) });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 50;
  server.on("close", () => live.close());
  return Object.assign(server, {
    desktopStatus: () => ({ active: live.desktopActive() }),
    lockDesktopAdmission: () => live.lockDesktopAdmission(),
    unlockDesktopAdmission: () => live.unlockDesktopAdmission(),
    cancelDesktopJobs: () => live.close(),
  });
}
