import { createServer, connect, type Socket } from "node:net";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createSecureContext } from "node:tls";
import { AIError } from "./errors.ts";
import { buildSeatbeltProfile, macInvocationArgs } from "./macos.ts";
import {
  cleanEnvironment,
  nativeExecutable,
  type SandboxConfig,
  type SandboxProbe,
} from "./sandbox.ts";
import { startEgressProxy } from "./egress.ts";
import { runBoundedProcess, type ProcessRequest } from "./runner.ts";
import type { PreparedAuth } from "./auth.ts";
import type { ProviderId } from "./events.ts";

/** On Darwin the TCP endpoint stays OUTSIDE Seatbelt. Only this already-bound
 * port is permitted inside; the existing private Unix CONNECT gateway retains
 * exact TLS authorities, public-IP pinning and all transfer/connection bounds. */
export async function startMacEgress(provider: ProviderId, socketPath: string) {
  const proxy = await startEgressProxy(provider, socketPath);
  const sockets = new Set<Socket>();
  let count = 0;
  const server = createServer((client) => {
    if (++count > 64 || sockets.size >= 32) {
      client.destroy();
      return;
    }
    const upstream = connect(socketPath);
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on("error", () => s.destroy());
      s.on("close", () => sockets.delete(s));
      s.setTimeout(120000, () => s.destroy());
    }
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    upstream.on("connect", () => {
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (e) {
    await proxy.close();
    throw e;
  }
  return {
    port: (server.address() as { port: number }).port,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await proxy.close();
    },
  };
}

async function prerequisites(executablePath: string) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new AIError("sandbox_unavailable");
  // No configurable replacement or shell shim for Apple's boundary.
  const sandbox = await nativeExecutable("/usr/bin/sandbox-exec");
  if (sandbox !== "/usr/bin/sandbox-exec" || (await lstat(sandbox)).uid !== 0)
    throw new AIError("sandbox_unavailable");
  const executable = await nativeExecutable(executablePath);
  // The actual platform CA file must exist and parse; never disable TLS checks.
  const caPath = await realpath("/etc/ssl/cert.pem");
  if (caPath !== "/private/etc/ssl/cert.pem")
    throw new AIError("sandbox_unavailable");
  const caStat = await lstat(caPath);
  if (
    !caStat.isFile() ||
    caStat.uid !== 0 ||
    caStat.mode & 0o022 ||
    caStat.size > 4 * 1024 * 1024
  )
    throw new AIError("sandbox_unavailable");
  const ca = await readFile(caPath, "utf8");
  if (!ca.includes("-----BEGIN CERTIFICATE-----"))
    throw new AIError("sandbox_unavailable");
  createSecureContext({ ca });
  return { sandbox, executable };
}
export async function macLayout(scratch: string) {
  const root = await realpath(scratch),
    s = await lstat(root);
  if (
    !/^\/private\/tmp\/[^/]+$/.test(root) ||
    !s.isDirectory() ||
    s.uid !== process.getuid?.() ||
    s.mode & 0o077
  )
    throw new AIError("sandbox_unavailable");
  const dirs = {
    home: `${root}/home`,
    work: `${root}/work`,
    tmp: `${root}/tmp`,
    codex: `${root}/codex`,
    claude: `${root}/claude`,
  };
  for (const p of Object.values(dirs)) {
    await mkdir(p, { mode: 0o700, recursive: true });
    if ((await realpath(p)) !== p || !(await lstat(p)).isDirectory())
      throw new AIError("sandbox_unavailable");
  }
  return { root, ...dirs };
}
export async function runSeatbeltCommand(input: {
  executablePath: string;
  args: string[];
  scratch: string;
  auth?: PreparedAuth;
  schemaFile?: string;
  proxyPort?: number;
  process: Omit<ProcessRequest, "executable" | "args" | "cwd" | "env">;
}) {
  if (input.process.signal?.aborted) throw new AIError("cancelled");
  const { sandbox, executable } = await prerequisites(input.executablePath),
    dirs = await macLayout(input.scratch);
  const readOnly: string[] = [];
  for (const f of input.auth?.files ?? []) {
    if (f.target !== "/home/runner/.codex/auth.json")
      throw new AIError("auth_invalid");
    const target = `${dirs.codex}/auth.json`;
    await copyFile(f.source, target, 1);
    readOnly.push(target);
  }
  const schema = input.schemaFile
    ? await realpath(input.schemaFile)
    : undefined;
  if (schema) readOnly.push(schema);
  const env = {
    ...cleanEnvironment(),
    HOME: dirs.home,
    TMPDIR: dirs.tmp,
    CODEX_HOME: dirs.codex,
    CLAUDE_CONFIG_DIR: dirs.claude,
    PATH: "/nonexistent",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    SSL_CERT_FILE: "/private/etc/ssl/cert.pem",
    NODE_EXTRA_CA_CERTS: "/private/etc/ssl/cert.pem",
    ...input.auth?.env,
  };
  if (input.proxyPort !== undefined) {
    const proxy = `http://127.0.0.1:${input.proxyPort}`;
    Object.assign(env, {
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      https_proxy: proxy,
      http_proxy: proxy,
      NO_PROXY: "",
      no_proxy: "",
    });
  }
  const profile = buildSeatbeltProfile({
    executable,
    writable: Object.values(dirs).filter((p) => p !== dirs.root),
    readOnly,
    proxyPort: input.proxyPort,
  });
  return runBoundedProcess({
    ...input.process,
    executable: sandbox,
    args: ["-p", profile, executable, ...macInvocationArgs(input.args, schema)],
    cwd: dirs.work,
    env,
  });
}

/** Runtime verification is never memoized across OS updates or invocations. */
export async function probeMacSandbox(
  config: SandboxConfig = {},
  enginePath?: string,
  signal?: AbortSignal,
): Promise<SandboxProbe> {
  const failed = (blocker: string): SandboxProbe => ({
    backend: "darwin-seatbelt",
    available: false,
    runtimeVerified: false,
    blocker,
  });
  let scratch: string | undefined, outside: string | undefined;
  let proxy: Awaited<ReturnType<typeof startMacEgress>> | undefined;
  const forbidden = createServer((s) => s.end("FORBIDDEN"));
  const unix = createServer((s) => s.end("FORBIDDEN"));
  try {
    if (signal?.aborted) throw new AIError("cancelled");
    if (!config.runtimeNodePath && process.versions.electron)
      return failed(
        "A standalone official ARM64 Node sidecar is required, not Electron.",
      );
    const node = await nativeExecutable(
      config.runtimeNodePath ?? process.execPath,
    );
    if (enginePath) await prerequisites(enginePath);
    scratch = await realpath(await mkdtemp("/tmp/ai-seatbelt-"));
    outside = await realpath(await mkdtemp("/tmp/ai-seatbelt-outside-"));
    const marker = `${outside}/sentinel`,
      schema = `${scratch}/schema.json`,
      fakeAuth = `${scratch}/auth.json`;
    await writeFile(marker, "FAKE HOST SENTINEL", { mode: 0o600 });
    await writeFile(schema, '{"type":"object"}', { mode: 0o600 });
    await writeFile(
      fakeAuth,
      '{"auth_mode":"apikey","OPENAI_API_KEY":"FAKE-PROBE-NOT-A-KEY"}',
      { mode: 0o600 },
    );
    await new Promise<void>((resolve, reject) => {
      forbidden.once("error", reject);
      forbidden.listen(0, "127.0.0.1", resolve);
    });
    const unixPath = `${outside}/forbidden.sock`;
    await new Promise<void>((resolve, reject) => {
      unix.once("error", reject);
      unix.listen(unixPath, resolve);
    });
    proxy = await startMacEgress("codex", `${scratch}/egress.sock`);
    const dirs = await macLayout(scratch);
    const script = `const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process'),tls=require('node:tls');
      const denied=f=>{try{f();return false}catch(e){return ['EPERM','EACCES'].includes(e.code)}};
      const blocked=options=>new Promise(resolve=>{let done=false;const s=net.connect(options);const end=v=>{if(done)return;done=true;s.destroy();resolve(v)};s.on('connect',()=>end(false));s.on('error',e=>end(['EPERM','EACCES'].includes(e.code)));s.setTimeout(1500,()=>end(false))});
      (async()=>{
      fs.writeFileSync('scratch','ok');
      fs.symlinkSync(${JSON.stringify(marker)}, 'escape');
      const auth=process.env.CODEX_HOME+'/auth.json';
      const filesystem=fs.readFileSync('scratch','utf8')==='ok' && fs.readFileSync(auth,'utf8').includes('FAKE-PROBE') && fs.readFileSync(${JSON.stringify(schema)},'utf8').includes('object') && denied(()=>fs.writeFileSync(auth,'bad')) && denied(()=>fs.unlinkSync(auth)) && denied(()=>fs.renameSync(process.env.CODEX_HOME,process.env.CODEX_HOME+'-moved')) && denied(()=>fs.writeFileSync(${JSON.stringify(schema)},'bad')) && denied(()=>fs.readFileSync(${JSON.stringify(marker)})) && denied(()=>fs.writeFileSync(${JSON.stringify(marker)},'bad')) && denied(()=>fs.readFileSync('/etc/passwd')) && denied(()=>fs.readFileSync('escape'));
      const fork=cp.spawnSync(process.execPath,['-e','process.exit(0)'],{detached:true});
      const shell=cp.spawnSync('/usr/bin/true',[]);
      const children=[fork,shell].every(r=>r.error && ['EPERM','EACCES'].includes(r.error.code));
      const environment=!['GITHUB_TOKEN','GH_TOKEN','JIRA_TOKEN','NODE_OPTIONS','DYLD_INSERT_LIBRARIES','DYLD_LIBRARY_PATH','ELECTRON_RUN_AS_NODE','SSH_AUTH_SOCK','ANTHROPIC_API_KEY'].some(k=>process.env[k]) && process.env.HOME===${JSON.stringify(dirs.home)} && !process.versions.electron;
      tls.createSecureContext({ca:fs.readFileSync(process.env.SSL_CERT_FILE)});
      const blockedAll=(await Promise.all([blocked({host:'127.0.0.1',port:${(forbidden.address() as { port: number }).port}}),blocked({host:'1.1.1.1',port:443}),blocked({path:${JSON.stringify(unixPath)}})])).every(Boolean);
      const allowed=await new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port:${proxy.port}});let text='';s.on('connect',()=>s.write('CONNECT evil.example:443 HTTP/1.1\\r\\nHost: evil.example:443\\r\\n\\r\\n'));s.on('data',b=>text+=b);s.on('end',()=>resolve(text.includes('403 Forbidden')));s.on('error',()=>resolve(false));s.setTimeout(1500,()=>{s.destroy();resolve(false)})});
      console.log(JSON.stringify({filesystem,children,environment,cwd:process.cwd()===${JSON.stringify(dirs.work)},network:blockedAll&&allowed}));
      })().catch(()=>process.exit(2));`;
    const result = await runSeatbeltCommand({
      executablePath: node,
      args: ["-e", script],
      scratch,
      auth: {
        env: {},
        files: [{ source: fakeAuth, target: "/home/runner/.codex/auth.json" }],
        mode: "oauth-file",
      },
      schemaFile: schema,
      proxyPort: proxy.port,
      process: {
        signal,
        deadlineMs: 10000,
        maxStdoutBytes: 65536,
        maxStderrBytes: 65536,
      },
    });
    if (result.exitCode !== 0)
      return failed(
        "Seatbelt runtime could not start or complete; unsupported profile/OS is not bypassed.",
      );
    const checks = JSON.parse(result.stdout) as NonNullable<
      SandboxProbe["checks"]
    >;
    if (
      !["filesystem", "children", "environment", "cwd", "network"].every(
        (k) => checks[k as keyof typeof checks] === true,
      )
    )
      return failed(
        "Seatbelt runtime failed filesystem, environment, process or exact-port network denial checks.",
      );
    return {
      backend: "darwin-seatbelt",
      available: true,
      runtimeVerified: true,
      blocker: null,
      checks,
    };
  } catch {
    if (signal?.aborted) throw new AIError("cancelled");
    return failed(
      "Seatbelt, trusted ARM64 runtime or macOS CA prerequisites failed; no fallback.",
    );
  } finally {
    await proxy?.close();
    await Promise.all(
      [forbidden, unix].map(
        (s) => new Promise<void>((resolve) => s.close(() => resolve())),
      ),
    );
    if (scratch) await rm(scratch, { recursive: true, force: true });
    if (outside) await rm(outside, { recursive: true, force: true });
  }
}
