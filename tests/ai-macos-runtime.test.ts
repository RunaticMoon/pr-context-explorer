import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { probeSandbox } from "../src/server/ai/sandbox.ts";
import {
  startMacEgress,
  runSeatbeltCommand,
} from "../src/server/ai/macos-runtime.ts";
import { probeCli } from "../src/server/ai/probes.ts";

const darwin = process.platform === "darwin" && process.arch === "arm64";
test("host TCP relay preserves Unix CONNECT authority denials", async () => {
  const dir = await mkdtemp("/tmp/ai-macos-proxy-");
  const proxy = await startMacEgress("codex", `${dir}/proxy.sock`);
  try {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(proxy.port, "127.0.0.1");
      let text = "";
      socket.on("connect", () =>
        socket.write(
          "CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n",
        ),
      );
      socket.on("data", (b) => (text += b));
      socket.on("end", () => resolve(text));
      socket.on("error", reject);
      socket.setTimeout(3000, () => socket.destroy(new Error("timeout")));
    });
    assert.match(response, /403 Forbidden/);
  } finally {
    await proxy.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "actual Darwin Seatbelt probe: scratch, sentinel, auth/schema RO, sockets and detached fork deny",
  { skip: !darwin && "requires actual Darwin arm64, not a Linux profile test" },
  async () => {
    const result = await probeSandbox({ runtimeNodePath: process.execPath });
    assert.equal(result.backend, "darwin-seatbelt");
    assert.equal(result.available, true, JSON.stringify(result));
    assert.equal(result.runtimeVerified, true);
    assert.equal(result.checks?.network, true);
    assert.equal(result.checks?.filesystem, true);
    assert.equal(result.checks?.children, true);
  },
);

test(
  "actual Darwin bounded native process terminates on timeout",
  { skip: !darwin && "requires Darwin arm64" },
  async () => {
    const dir = await realpath(await mkdtemp("/tmp/ai-macos-timeout-"));
    try {
      let pid: number | undefined;
      await assert.rejects(
        runSeatbeltCommand({
          executablePath: process.execPath,
          args: ["-e", "console.log(process.pid);setInterval(()=>{},1000)"],
          scratch: dir,
          process: {
            deadlineMs: 2000,
            onStdout: (b) => {
              pid = Number(b.toString().trim());
            },
          },
        }).then((result) => {
          assert.fail(
            "credential-free timeout probe exited before deadline: " +
              JSON.stringify(result),
          );
        }),
        (e: any) => e.code === "timeout",
      );
      assert.ok(
        pid && Number.isInteger(pid),
        "actual sandboxed process must have started before timeout",
      );
      assert.throws(
        () => process.kill(pid!, 0),
        (e: any) => e.code === "ESRCH",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "actual Darwin missing standalone Node fails closed",
  { skip: !darwin && "requires Darwin arm64" },
  async () => {
    const result = await probeSandbox({
      runtimeNodePath: "/nonexistent/official-node",
    });
    assert.equal(result.backend, "darwin-seatbelt");
    assert.equal(result.available, false);
    assert.equal(result.runtimeVerified, false);
  },
);

test(
  "actual Darwin verified TLS through allowlisted proxy and system PEM (no API request)",
  { skip: !darwin && "requires Darwin arm64 and public TLS connectivity" },
  async () => {
    const dir = await realpath(await mkdtemp("/tmp/ai-macos-tls-"));
    const proxy = await startMacEgress("codex", `${dir}/proxy.sock`);
    try {
      const script = `const net=require('node:net'),tls=require('node:tls'),fs=require('node:fs');
      const s=net.connect({host:'127.0.0.1',port:${proxy.port}});let header=Buffer.alloc(0);
      const fail=()=>process.exit(2);s.on('error',fail);s.setTimeout(10000,fail);
      s.on('connect',()=>s.write('CONNECT api.openai.com:443 HTTP/1.1\\r\\nHost: api.openai.com:443\\r\\n\\r\\n'));
      const receive=b=>{header=Buffer.concat([header,b]);const end=header.indexOf('\\r\\n\\r\\n');if(end<0)return;
        if(!header.toString().startsWith('HTTP/1.1 200 '))return fail();s.removeListener('data',receive);
        if(header.length>end+4)s.unshift(header.subarray(end+4));
        const t=tls.connect({socket:s,servername:'api.openai.com',rejectUnauthorized:true,ca:fs.readFileSync(process.env.SSL_CERT_FILE)});
        t.on('error',fail);t.on('secureConnect',()=>{console.log(JSON.stringify({authorized:t.authorized}));t.destroy()});};s.on('data',receive);`;
      const result = await runSeatbeltCommand({
        executablePath: process.execPath,
        args: ["-e", script],
        scratch: dir,
        proxyPort: proxy.port,
        process: { deadlineMs: 15000 },
      });
      assert.equal(
        result.exitCode,
        0,
        "credential-free verified TLS handshake must succeed through the real boundary: " +
          JSON.stringify(result),
      );
      assert.deepEqual(JSON.parse(result.stdout), { authorized: true });
    } finally {
      await proxy.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

for (const provider of ["codex", "claude"] as const)
  test(
    `actual Darwin pinned official ${provider} help/status under Seatbelt, no auth`,
    {
      skip:
        !darwin && "requires installed native Darwin CLI and actual Seatbelt",
    },
    async () => {
      const diagnostics: unknown[] = [];
      const result = await probeCli(provider, {}, undefined, (args, result) => {
        diagnostics.push({ args, ...result });
      });
      assert.ok(result.executablePath, JSON.stringify(result));
      assert.equal(
        result.capabilities.supported,
        true,
        JSON.stringify({ result, diagnostics }),
      );
      assert.equal(
        result.emptyAuthStatus,
        "not_authenticated",
        "official credential-free status must be explicit, not inferred from an error: " +
          JSON.stringify(diagnostics),
      );
    },
  );
