import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  fetchBytes,
  type Transport,
} from "../desktop/public-update/network.ts";
import { assetURL } from "../desktop/public-update/policy.ts";
test("real TLS fixture: bounded redirects, partial bodies, cancellation, no remote authority override", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-tls-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(root, "key.pem"),
      "-out",
      path.join(root, "cert.pem"),
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  const cert = await readFile(path.join(root, "cert.pem")),
    key = await readFile(path.join(root, "key.pem"));
  let mode = "ok";
  let requests = 0;
  const server = https.createServer({ key, cert }, (req, res) => {
    requests++;
    assert.equal(req.headers.authorization, undefined);
    if (mode === "redirect") {
      res.writeHead(302, { location: "https://attacker.example/steal" });
      res.end();
    } else if (mode === "loop") {
      res.writeHead(302, { location: assetURL("v0.6.0", "public-mac.json") });
      res.end();
    } else if (mode === "limit") {
      res.writeHead(200, { "content-length": 100 });
      res.end("too big");
    } else if (mode === "partial") {
      res.writeHead(200, { "content-length": 10 });
      res.write("xx");
      setTimeout(() => res.destroy(), 20);
    } else if (mode === "wait") {
      res.writeHead(200);
      res.write("a");
    } else {
      res.writeHead(200, { "content-length": 2 });
      res.end("ok");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const transport: Transport = (_url, signal) =>
    new Promise((resolve, reject) => {
      const req = https.get(
        {
          hostname: "127.0.0.1",
          servername: "localhost",
          port,
          path: "/",
          ca: cert,
          signal,
          agent: false,
        },
        resolve,
      );
      req.on("error", reject);
    });
  const url = assetURL("v0.6.0", "public-mac.json");
  try {
    assert.equal(
      (
        await fetchBytes(
          url,
          "asset",
          20,
          new AbortController().signal,
          undefined,
          transport,
        )
      ).toString(),
      "ok",
    );
    mode = "redirect";
    const before = requests;
    await assert.rejects(
      fetchBytes(
        url,
        "asset",
        20,
        new AbortController().signal,
        undefined,
        transport,
      ),
      /UNSAFE_URL/,
    );
    assert.equal(requests, before + 1);
    mode = "loop";
    await assert.rejects(
      fetchBytes(
        url,
        "asset",
        20,
        new AbortController().signal,
        undefined,
        transport,
      ),
      /REDIRECT/,
    );
    mode = "limit";
    await assert.rejects(
      fetchBytes(
        url,
        "asset",
        20,
        new AbortController().signal,
        undefined,
        transport,
      ),
      /BODY_LIMIT/,
    );
    mode = "partial";
    await assert.rejects(
      fetchBytes(
        url,
        "asset",
        20,
        new AbortController().signal,
        undefined,
        transport,
      ),
    );
    mode = "wait";
    const c = new AbortController(),
      timer = setTimeout(() => c.abort(), 30);
    await assert.rejects(
      fetchBytes(url, "asset", 20, c.signal, undefined, transport),
      /CANCELLED/,
    );
    clearTimeout(timer);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
