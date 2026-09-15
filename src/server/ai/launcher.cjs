"use strict";
// Executed by /runtime/node INSIDE the OS sandbox. No package imports or shell.
// This loopback-only relay exposes the parent's single allowlisted Unix CONNECT
// proxy to native CLI clients; the sandbox has no other network interface.
const net = require("node:net");
const { spawn } = require("node:child_process");
const [socketPath, executable, ...args] = process.argv.slice(2);
if (!socketPath?.startsWith("/") || !executable?.startsWith("/"))
  process.exit(90);
const sockets = new Set();
const server = net.createServer((client) => {
  if (sockets.size >= 32) {
    client.destroy();
    return;
  }
  const upstream = net.connect(socketPath);
  for (const socket of [client, upstream]) {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  }
  upstream.on("connect", () => {
    client.pipe(upstream);
    upstream.pipe(client);
  });
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
});
server.on("error", () => process.exit(91));
server.listen(0, "127.0.0.1", () => {
  const proxy = `http://127.0.0.1:${server.address().port}`;
  const env = {
    ...process.env,
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    NO_PROXY: "",
    no_proxy: "",
  };
  const child = spawn(executable, args, {
    cwd: process.cwd(),
    env,
    shell: false,
    stdio: ["pipe", "inherit", "inherit"],
  });
  child.on("error", () => process.exit(92));
  child.stdin.on("error", () => {
    /* EPIPE: final exit determines success */
  });
  process.stdin.pipe(child.stdin);
  child.on("exit", (code, signal) => {
    for (const socket of sockets) socket.destroy();
    server.close();
    process.exit(signal ? 93 : (code ?? 94));
  });
});
