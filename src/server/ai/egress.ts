import { createServer } from "node:http";
import { connect, BlockList, isIPv4, type Socket } from "node:net";
import { lookup } from "node:dns/promises";
import { chmod } from "node:fs/promises";
import type { ProviderId } from "./events.ts";

// No custom hosts, wildcard domains, inherited proxies, redirects, or service tokens.
export const ENGINE_HOSTS = {
  codex: ["api.openai.com", "chatgpt.com", "auth.openai.com"],
  claude: ["api.anthropic.com", "platform.claude.com", "console.anthropic.com"],
} as const;
export function allowedAuthority(
  provider: ProviderId,
  authority: string,
): string | null {
  return (
    ENGINE_HOSTS[provider].find((host) => `${host}:443` === authority) ?? null
  );
}
// Reviewed IANA IPv4 special-purpose registry + multicast policy. Deny entire
// protocol-assignment /24s conservatively, including their anycast exceptions.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// This is a provider-egress policy, not a claim that all other IPv4 is routable.
const deniedRanges = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], // This network (RFC 791)
  ["10.0.0.0", 8], // Private use (RFC 1918)
  ["100.64.0.0", 10], // Shared address space (RFC 6598)
  ["127.0.0.0", 8], // Loopback (RFC 1122)
  ["169.254.0.0", 16], // Link local (RFC 3927)
  ["172.16.0.0", 12], // Private use (RFC 1918)
  ["192.0.0.0", 24], // Protocol assignments (RFC 6890)
  ["192.0.2.0", 24], // Documentation (RFC 5737)
  ["192.88.99.0", 24], // Deprecated 6to4 relay (RFC 7526), also 6a44 .2
  ["192.168.0.0", 16], // Private use (RFC 1918)
  ["198.18.0.0", 15], // Benchmarking (RFC 2544)
  ["198.51.100.0", 24], // Documentation (RFC 5737)
  ["203.0.113.0", 24], // Documentation (RFC 5737)
  ["224.0.0.0", 4], // Multicast (RFC 1112)
  ["240.0.0.0", 4], // Reserved, including limited broadcast (RFC 1112/919)
] as const)
  deniedRanges.addSubnet(address, prefix, "ipv4");
export function publicIPv4(ip: string): boolean {
  return isIPv4(ip) && !deniedRanges.check(ip, "ipv4");
}

/** Unix-only CONNECT gateway. TLS remains end-to-end and verified by the CLI.
 * The sandbox has no external network; its local TCP relay reaches this one
 * Unix socket. DNS is resolved here and the approved numeric address is pinned.
 */
export async function startEgressProxy(
  provider: ProviderId,
  socketPath: string,
) {
  const sockets = new Set<Socket>();
  let closed = false,
    totalConnections = 0,
    bytes = 0;
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 },
    (_req, res) => {
      res.writeHead(403);
      res.end();
    },
  );
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.setTimeout(120000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (data) => {
      bytes += data.length;
      if (bytes > 64 * 1024 * 1024) for (const s of sockets) s.destroy();
    });
  };
  server.on("connection", (socket) => {
    if (closed || ++totalConnections > 64 || sockets.size >= 16)
      socket.destroy();
    else track(socket);
  });
  server.on("clientError", (_e, socket) => socket.destroy());
  server.on("connect", async (req, raw, head) => {
    const client = raw as Socket,
      host = allowedAuthority(provider, req.url ?? "");
    if (!host) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    try {
      const addresses = await lookup(host, { family: 4, all: true });
      if (closed || client.destroyed) return;
      if (!addresses.length || addresses.some((a) => !publicIPv4(a.address)))
        throw new Error("denied");
      const upstream = connect({ host: addresses[0].address, port: 443 });
      track(upstream);
      const timer = setTimeout(() => {
        client.destroy();
        upstream.destroy();
      }, 10000);
      upstream.once("connect", () => {
        clearTimeout(timer);
        if (closed || client.destroyed) {
          upstream.destroy();
          return;
        }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("close", () => {
        clearTimeout(timer);
        client.destroy();
      });
      client.on("close", () => upstream.destroy());
    } catch {
      client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
  return {
    close: async () => {
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
