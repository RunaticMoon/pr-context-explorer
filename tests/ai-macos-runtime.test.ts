import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  lstat,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { connect } from "node:net";
import { probeSandbox } from "../src/server/ai/sandbox.ts";
import {
  startMacEgress,
  runSeatbeltCommand,
} from "../src/server/ai/macos-runtime.ts";
import { probeCli } from "../src/server/ai/probes.ts";

import { validateMacSystemPolicyReads } from "../src/server/ai/macos.ts";

test(
  "actual macOS 15 ICU 76 exact read/stat without parent or sibling grants",
  {
    skip: process.platform !== "darwin" || process.arch !== "arm64",
  },
  async () => {
    const leaf = "/usr/share/icu/icudt76l.dat";
    // Native root-owned OS metadata/ACL positive control; never print data bytes.
    await validateMacSystemPolicyReads();
    assert.ok((await lstat(leaf)).isFile());
    assert.ok((await readFile(leaf)).length > 0);
    for (const path of [
      "/usr",
      "/usr/share",
      "/usr/share/icu",
      "/usr/share/zoneinfo",
    ])
      assert.ok((await readdir(path)).length > 0);
    for (const path of ["/etc/passwd", "/usr/share/zoneinfo/UTC"])
      assert.ok((await readFile(path)).length > 0);
    const scratch = await realpath(await mkdtemp("/tmp/ai-macos-icu-"));
    try {
      const script = `const fs=require('node:fs');
      const outcome=f=>{try{f();return 'ALLOWED'}catch(e){return e.code}};
      console.log(JSON.stringify({
        read:fs.readFileSync(${JSON.stringify(leaf)}).length>0,
        stat:fs.statSync(${JSON.stringify(leaf)}).isFile(),
        parents:['/usr','/usr/share','/usr/share/icu','/usr/share/zoneinfo'].map(p=>outcome(()=>fs.readdirSync(p))),
        siblings:['/etc/passwd','/usr/share/zoneinfo/UTC'].map(p=>outcome(()=>fs.readFileSync(p)))
      }));`;
      const result = await runSeatbeltCommand({
        executablePath: process.execPath,
        args: ["-e", script],
        scratch,
        process: { deadlineMs: 10000 },
      });
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      const checks = JSON.parse(result.stdout);
      assert.equal(checks.read, true);
      assert.equal(checks.stat, true);
      assert.equal(checks.parents.length, 4);
      assert.equal(checks.siblings.length, 2);
      for (const code of [...checks.parents, ...checks.siblings])
        assert.ok(
          ["EPERM", "EACCES"].includes(code),
          `not denial evidence: ${code}`,
        );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

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
  "actual Darwin literal root listing does not grant root-child, outside-file or symlink access",
  { skip: !darwin && "requires actual Darwin arm64" },
  async () => {
    const scratch = await realpath(await mkdtemp("/tmp/ai-macos-root-"));
    const outside = await realpath(
      await mkdtemp("/tmp/ai-macos-root-outside-"),
    );
    const marker = `${outside}/sentinel`;
    try {
      await writeFile(marker, "HOST-READABLE-SENTINEL", { mode: 0o600 });
      // Positive unsandboxed controls: denial must not be ENOENT or host DAC.
      assert.equal(await readFile(marker, "utf8"), "HOST-READABLE-SENTINEL");
      assert.ok((await readdir(outside)).includes("sentinel"));
      assert.ok((await readdir("/")).includes("private"));
      assert.ok((await readdir("/private")).includes("etc"));
      assert.ok((await readFile("/etc/passwd", "utf8")).length > 0);
      const script = `const fs=require('node:fs');
        const outcome=f=>{try{f();return 'ALLOWED'}catch(e){return e.code}};
        fs.symlinkSync(${JSON.stringify(marker)}, 'escape-file');
        fs.symlinkSync(${JSON.stringify(outside)}, 'escape-dir');
        const checks={
          rootListing:fs.readdirSync('/').includes('private'),
          rootChildDirectory:outcome(()=>fs.readdirSync('/private')),
          rootDescendantFile:outcome(()=>fs.readFileSync('/etc/passwd')),
          outsideDirectory:outcome(()=>fs.readdirSync(${JSON.stringify(outside)})),
          outsideFile:outcome(()=>fs.readFileSync(${JSON.stringify(marker)})),
          outsideWrite:outcome(()=>fs.writeFileSync(${JSON.stringify(marker)},'bad')),
          outsideCreate:outcome(()=>fs.writeFileSync(${JSON.stringify(`${outside}/new-file`)},'bad')),
          symlinkFile:outcome(()=>fs.readFileSync('escape-file')),
          symlinkDirectory:outcome(()=>fs.readdirSync('escape-dir')),
          symlinkDescendant:outcome(()=>fs.readFileSync('escape-dir/sentinel')),
          symlinkWrite:outcome(()=>fs.writeFileSync('escape-file','bad')),
        }; console.log(JSON.stringify(checks));`;
      const result = await runSeatbeltCommand({
        executablePath: process.execPath,
        args: ["-e", script],
        scratch,
        process: { deadlineMs: 10000 },
      });
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      const { rootListing, ...denials } = JSON.parse(result.stdout);
      assert.equal(rootListing, true);
      assert.deepEqual(
        Object.keys(denials).sort(),
        [
          "rootChildDirectory",
          "rootDescendantFile",
          "outsideDirectory",
          "outsideFile",
          "outsideWrite",
          "outsideCreate",
          "symlinkFile",
          "symlinkDirectory",
          "symlinkDescendant",
          "symlinkWrite",
        ].sort(),
      );
      for (const [name, code] of Object.entries(denials))
        assert.ok(
          code === "EPERM" || code === "EACCES",
          `${name}: ${code}; missing files are NOT denial evidence`,
        );
      assert.equal(await readFile(marker, "utf8"), "HOST-READABLE-SENTINEL");
      assert.deepEqual(await readdir(outside), ["sentinel"]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  },
);

test(
  "actual Darwin system-config absence is ENOENT, not a sandbox permission error",
  {
    skip:
      !darwin && "requires actual Darwin arm64; no fabricated absence results",
  },
  async () => {
    const scratch = await realpath(await mkdtemp("/tmp/ai-macos-config-"));
    try {
      // Only the trusted OS OpenSSL file may exist. No contents are emitted;
      // runSeatbeltCommand must validate its owner/type/ACL before execution.
      const opensslPresent = await lstat("/System/Library/OpenSSL/openssl.cnf")
        .then((stat) => {
          assert.ok(stat.isFile());
          return true;
        })
        .catch((error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        });
      const paths = [
        "/System/Library/OpenSSL/openssl.cnf",
        "/System/Library/OpenSSL//openssl.cnf",
        ...["/etc", "/private/etc"].flatMap((root) =>
          ["requirements.toml", "managed_config.toml", "config.toml"].map(
            (name) => `${root}/codex/${name}`,
          ),
        ),
      ];
      const script = `const fs=require('node:fs');
        const outcome=f=>{try{f();return 'ALLOWED'}catch(e){return e.code}};
        console.log(JSON.stringify({
          reads:${JSON.stringify(paths)}.map(p=>outcome(()=>fs.readFileSync(p))),
          metadata:${JSON.stringify(paths)}.map(p=>outcome(()=>fs.lstatSync(p))),
          directories:['/etc','/private/etc','/System/Library'].map(p=>outcome(()=>fs.readdirSync(p))),
          passwd:outcome(()=>fs.readFileSync('/etc/passwd')),
          overrides:['OPENSSL_CONF','OPENSSL_MODULES','OPENSSL_ENGINES','OPENSSL_CONF_INCLUDE'].filter(k=>k in process.env)
        }));`;
      const result = await runSeatbeltCommand({
        executablePath: process.execPath,
        args: ["-e", script],
        scratch,
        process: { deadlineMs: 10000 },
      });
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      const checks = JSON.parse(result.stdout);
      assert.deepEqual(
        checks.reads,
        paths.map((_, index) =>
          index < 2 && opensslPresent ? "ALLOWED" : "ENOENT",
        ),
      );
      assert.deepEqual(
        checks.metadata,
        paths.map((_, index) =>
          index < 2 && opensslPresent ? "ALLOWED" : "ENOENT",
        ),
      );
      for (const code of [...checks.directories, checks.passwd])
        assert.ok(
          ["EPERM", "EACCES"].includes(code),
          `not denial evidence: ${code}`,
        );
      assert.deepEqual(checks.overrides, []);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
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
