import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runBoundedProcess } from "../src/server/ai/runner.ts";
import { startEgressProxy } from "../src/server/ai/egress.ts";

test("real fake engine exercises executable launcher stdin, proxy relay and clean env (NOT inference or OS confinement)", async () => {
  const dir = await mkdtemp("/tmp/ai-launcher-test-");
  const socket = `${dir}/egress.sock`,
    proxy = await startEgressProxy("claude", socket);
  try {
    const fake = `let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const u=new URL(process.env.HTTPS_PROXY);const s=require('net').connect(Number(u.port),u.hostname);let response='';s.on('connect',()=>s.write('CONNECT blocked.invalid:443 HTTP/1.1\\r\\nHost: blocked.invalid\\r\\n\\r\\n'));s.on('data',d=>response+=d);s.on('end',()=>console.log(JSON.stringify({input,blocked:response.includes('403'),cwd:process.cwd(),serviceToken:process.env.GH_TOKEN??null})));});`;
    const result = await runBoundedProcess({
      executable: process.execPath,
      args: [
        fileURLToPath(
          new URL("../src/server/ai/launcher.cjs", import.meta.url),
        ),
        socket,
        process.execPath,
        "-e",
        fake,
      ],
      cwd: dir,
      env: { HOME: dir },
      stdin: "FAKE_SOURCE_ONLY",
      deadlineMs: 4000,
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      input: "FAKE_SOURCE_ONLY",
      blocked: true,
      cwd: dir,
      serviceToken: null,
    });
  } finally {
    await proxy.close();
    await rm(dir, { recursive: true, force: true });
  }
});
