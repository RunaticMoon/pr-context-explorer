import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, readFile, access } from "node:fs/promises";
import { runBoundedProcess } from "../src/server/ai/runner.ts";

test("help-only diagnostic accepts exactly Claude and builds a bounded no-auth help launch", async () => {
  const d = await import("../scripts/macos-ai-diagnostics.ts");
  assert.equal(typeof d.diagnosticOptions, "function");
  assert.deepEqual(d.diagnosticOptions([]), {
    ab: false,
    only: undefined,
    help: false,
  });
  assert.deepEqual(d.diagnosticOptions(["--startup-help-only=claude"]), {
    ab: false,
    only: "claude",
    help: true,
  });
  for (const args of [
    ["--startup-help-only=node"],
    ["--startup-help-only=codex"],
    ["--startup-help-only"],
    ["--startup-help-only=claude", "--auth"],
    ["--startup-help-only=claude", "--startup-only=claude"],
    ["--startup-help-only=claude", "--startup-ab-root-directory"],
    ["--startup-help-only=claude", "--startup-help-only=claude"],
    ["--startup-help-only=claude", "--help"],
    ["--unknown"],
  ])
    assert.throws(() => d.diagnosticOptions(args));
  assert.deepEqual(
    d.startupCommandInput("/opt/claude", "/private/tmp/fresh", "claude", true),
    {
      executablePath: "/opt/claude",
      scratch: "/private/tmp/fresh",
      args: ["--help"],
      process: {
        deadlineMs: 10000,
        maxStdoutBytes: 65536,
        maxStderrBytes: 65536,
        maxTotalBytes: 131072,
      },
    },
  );
  assert.deepEqual(
    d.startupCommandInput("/opt/claude", "/private/tmp/fresh", "claude", false)
      .args,
    ["--version"],
  );
});

test("root-directory A/B flag is explicit, exclusive and rejects malformed input", async () => {
  const d = await import("../scripts/macos-ai-diagnostics.ts");
  assert.equal(typeof d.startupABRootDirectory, "function");
  assert.equal(d.startupABRootDirectory([]), false);
  assert.equal(d.startupABRootDirectory(["--startup-only=claude"]), false);
  assert.equal(d.startupABRootDirectory(["--startup-ab-root-directory"]), true);
  for (const args of [
    ["--startup-ab-root-directory=claude"],
    ["--startup-ab-root-directory", "--startup-only=claude"],
    ["--startup-ab-root-directory", "--auth"],
    ["--startup-ab-root-directory", "--startup-ab-root-directory"],
  ])
    assert.throws(() => d.startupABRootDirectory(args));
});

test("root-directory A/B changes exactly one literal rule and no launch inputs", async () => {
  const { rootDirectoryABPlans } = await import("../scripts/mac-native-ab.ts");
  const { buildSeatbeltProfile } = await import("../src/server/ai/macos.ts");
  const { createHash } = await import("node:crypto");
  const root = "/private/tmp/ab-fixture";
  const dirs = {
    root,
    home: `${root}/home`,
    work: `${root}/work`,
    tmp: `${root}/tmp`,
    codex: `${root}/codex`,
    claude: `${root}/claude`,
  };
  const [a, b] = rootDirectoryABPlans("/opt/claude", dirs);
  const baseline = buildSeatbeltProfile({
    executable: "/opt/claude",
    writable: Object.values(dirs).filter((p) => p !== root),
    readOnly: [],
  });
  assert.equal(a.profile, baseline);
  assert.equal(b.profile, baseline + '\n(allow file-read-data (literal "/"))');
  for (const p of [a, b]) {
    assert.equal(
      p.sha256,
      createHash("sha256").update(p.profile).digest("hex"),
    );
    assert.equal(p.request.executable, "/usr/bin/sandbox-exec");
    assert.deepEqual(p.request.args, [
      "-p",
      p.profile,
      "/opt/claude",
      "--version",
    ]);
    assert.equal(p.request.deadlineMs, 10000);
    assert.equal(p.request.maxTotalBytes, 131072);
    assert.equal(p.request.cwd, dirs.work);
    assert.equal(p.request.env.HOME, dirs.home);
    assert.equal(p.request.stdin, undefined);
    assert.equal(p.request.env.ANTHROPIC_API_KEY, undefined);
  }
  assert.deepEqual({ ...a.request, args: [] }, { ...b.request, args: [] });
  const source = await readFile(
    new URL("../scripts/mac-native-ab.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /process\.env|auth\.ts|startEgressProxy|subpath "\/"|allow mach/,
  );
});

test("credential-free real self-SIGKILL retains the help diagnostic PID and empty output", async () => {
  const result = await runBoundedProcess({
    executable: process.execPath,
    args: ["-e", "process.kill(process.pid,'SIGKILL')"],
    cwd: "/tmp",
    env: {},
    deadlineMs: 10000,
    maxStdoutBytes: 65536,
    maxStderrBytes: 65536,
    maxTotalBytes: 131072,
  });
  assert.ok(Number.isSafeInteger(result.pid) && result.pid! > 0);
  assert.notEqual(result.pid, process.pid);
  assert.equal(result.exitCode, null);
  assert.equal(result.terminationSignal, "SIGKILL");
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("real fake SIGTERM preserves native termination signal without output", async () => {
  const result = await runBoundedProcess({
    executable: process.execPath,
    args: ["-e", "process.kill(process.pid,'SIGTERM')"],
    cwd: "/tmp",
    env: {},
    deadlineMs: 2000,
  });
  assert.equal(result.exitCode, null);
  assert.equal(result.terminationSignal, "SIGTERM");
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("returns the actual host child PID for normal and signal exits", async () => {
  for (const signal of [false, true]) {
    const result = await runBoundedProcess({
      executable: process.execPath,
      args: [
        "-e",
        `process.stdout.write(String(process.pid),()=>{${signal ? "process.kill(process.pid,'SIGTERM')" : "process.exit(0)"}})`,
      ],
      cwd: "/tmp",
      env: {},
      deadlineMs: 2000,
    });
    assert.equal(result.pid, Number(result.stdout));
    assert.ok(Number.isSafeInteger(result.pid) && result.pid! > 0);
    assert.notEqual(result.pid, process.pid);
    assert.equal(result.terminationSignal, signal ? "SIGTERM" : undefined);
  }
});

test("Mac diagnostics never replace the production deny-default profile", async () => {
  const source = await readFile(
    new URL("../scripts/macos-ai-diagnostics.ts", import.meta.url),
    "utf8",
  );
  assert.ok(!source.includes("(with report)"));
  assert.ok(!source.includes("spawnSync"));
  assert.match(source, /const pid = result.pid/);
});

test("fresh IPS summaries require exact PID, executable and launch window and omit private sections", async () => {
  const diagnostics = await import("../scripts/macos-ai-diagnostics.ts");
  assert.equal(typeof diagnostics.summarizeCrash, "function");
  const scope = {
    pid: 123,
    executable: "/opt/node",
    startedAt: Date.parse("2026-09-15T04:44:49Z"),
    endedAt: Date.parse("2026-09-15T04:44:50Z"),
  };
  const body = {
    pid: 123,
    procPath: "/opt/node",
    procLaunch: "2026-09-15 04:44:49.123 +0000",
    captureTime: "2026-09-15 04:44:49.456 +0000",
    exception: { type: "EXC_CRASH", signal: "SIGABRT", private: "SECRET" },
    termination: { namespace: "SIGNAL", code: 6 },
    asi: { libsystem_c: ["abort() called"] },
    faultingThread: 0,
    threads: [
      {
        frames: [
          {
            symbol: "abort",
            imageIndex: 0,
            imageOffset: 123,
            private: "SECRET",
          },
        ],
        threadState: "SECRET",
      },
    ],
    environment: { token: "SECRET" },
    vmSummary: "SECRET",
  };
  const ips = (b: unknown) =>
    JSON.stringify({ app_name: "node" }) + "\n" + JSON.stringify(b);
  const summary = diagnostics.summarizeCrash(ips(body), scope);
  assert.ok(summary);
  assert.match(JSON.stringify(summary), /abort\(\) called/);
  assert.match(JSON.stringify(summary), /SIGABRT/);
  const dyld = diagnostics.summarizeCrash(
    ips({
      ...body,
      termination: {
        namespace: "DYLD",
        details: ["Library missing"],
        reasons: ["not found"],
      },
    }),
    scope,
  );
  assert.match(JSON.stringify(dyld), /Library missing/);
  assert.match(JSON.stringify(dyld), /not found/);
  assert.ok(!JSON.stringify(summary).includes("SECRET"));
  for (const change of [
    { pid: 124 },
    { procPath: "/other/node" },
    { procLaunch: "2026-09-14 04:44:49 +0000" },
    { captureTime: "2026-09-14 04:44:49 +0000" },
    { procLaunch: "invalid" },
  ])
    assert.equal(
      diagnostics.summarizeCrash(ips({ ...body, ...change }), scope),
      undefined,
    );
  assert.equal(diagnostics.summarizeCrash("{incomplete", scope), undefined);
  assert.equal(
    diagnostics.summarizeCrash("x".repeat(2 * 1024 * 1024 + 1), scope),
    undefined,
  );
  const bounded = diagnostics.summarizeCrash(
    ips({ ...body, asi: { libsystem_c: ["x".repeat(100000)] } }),
    scope,
  );
  assert.ok(JSON.stringify(bounded).length < 16000);
});

test("termination text keeps bounded scalar strings without fabricated null entries", async () => {
  const { summarizeCrash } = await import("../scripts/macos-ai-diagnostics.ts");
  const scope = {
    pid: 42,
    executable: "/opt/claude",
    startedAt: 10000,
    endedAt: 10100,
  };
  for (const procPath of [scope.executable, "/Users/USER/*/claude"]) {
    for (const value of [
      undefined,
      null,
      2,
      { nested: "SECRET" },
      [null, "kept\ntext", { nested: "SECRET" }, "x".repeat(2000), "excluded"],
      "scalar\ttext",
    ]) {
      const rejected: any[] = [];
      const result = summarizeCrash(
        JSON.stringify({
          pid: 42,
          procPath,
          procLaunch: new Date(10006).toISOString(),
          captureTime: new Date(10021).toISOString(),
          termination: {
            namespace: "<0x23>",
            code: 2,
            details: value,
            reasons: value,
          },
          environment: { token: "SECRET" },
        }),
        scope,
        (v) => rejected.push(v),
      );
      const termination =
        result?.termination ?? rejected[0].hypothesis.termination;
      const expected = Array.isArray(value)
        ? ["kept text", "x".repeat(1024)]
        : typeof value === "string"
          ? ["scalar text"]
          : [];
      assert.deepEqual(termination.details, expected);
      assert.deepEqual(termination.reasons, expected);
      assert.ok(!JSON.stringify(result ?? rejected).includes("SECRET"));
      if (!result)
        assert.equal(
          rejected[0].hypothesis.status,
          "unverified-executable-match",
        );
    }
  }
});

test("minimal Mac diagnostic selects exactly one startup and rejects unknown options", async () => {
  const { startupOnlyTarget } =
    await import("../scripts/macos-ai-diagnostics.ts");
  assert.equal(startupOnlyTarget([]), undefined);
  for (const target of ["node", "codex", "claude"]) {
    assert.equal(startupOnlyTarget([`--startup-only=${target}`]), target);
  }
  for (const args of [
    ["--startup-only=other"],
    ["--unknown"],
    ["--startup-only=node", "--startup-only=claude"],
  ]) {
    assert.throws(() => startupOnlyTarget(args));
  }
});

test("IPS rejection evidence is bounded metadata, not rejected report content", async () => {
  const { summarizeCrash } = await import("../scripts/macos-ai-diagnostics.ts");
  const scope = {
    pid: 13874,
    executable: "/opt/claude",
    startedAt: 1789450096619,
    endedAt: 1789450096642,
  };
  // Synthetic IPS using the actual CI unified-log clock offset; not a recovered IPS.
  const body = {
    pid: scope.pid,
    procPath: scope.executable,
    procLaunch: "2026-09-15 05:28:16.267 +0000",
    captureTime: "2026-09-15 05:28:16.357 +0000",
    environment: { token: "SECRET" },
  };
  const rejected: unknown[] = [];
  const reject = (value: unknown) => rejected.push(value);
  assert.ok(summarizeCrash(JSON.stringify(body), scope, reject));
  assert.deepEqual(rejected, []);
  assert.equal(
    summarizeCrash(
      JSON.stringify({ ...body, procLaunch: "2026-09-15 05:28:14.000 +0000" }),
      scope,
      reject,
    ),
    undefined,
  );
  assert.deepEqual(rejected.pop(), {
    reason: "identity_or_time_mismatch",
    pidMatches: true,
    executableMatches: true,
    launchDeltaMs: -2619,
    captureDeltaMs: -262,
  });
  summarizeCrash(
    JSON.stringify({ ...body, pid: 42, procPath: "SECRET" }),
    scope,
    reject,
  );
  assert.deepEqual(rejected.pop(), {
    reason: "identity_or_time_mismatch",
    pidMatches: false,
    executableMatches: false,
    launchDeltaMs: -352,
    captureDeltaMs: -262,
  });
  summarizeCrash(
    JSON.stringify({ ...body, procLaunch: "SECRET" }),
    scope,
    reject,
  );
  assert.deepEqual(rejected.pop(), {
    reason: "identity_or_time_mismatch",
    pidMatches: true,
    executableMatches: true,
    launchDeltaMs: null,
    captureDeltaMs: -262,
  });
  summarizeCrash("{SECRET", scope, reject);
  assert.deepEqual(rejected.pop(), { reason: "invalid_json" });
  summarizeCrash("SECRET".repeat(400000), scope, reject);
  assert.deepEqual(rejected.pop(), { reason: "payload_too_large" });
});

test("crash candidate reads reject stale files, symlinks and oversize payloads", async () => {
  const diagnostics = await import("../scripts/macos-ai-diagnostics.ts");
  assert.equal(typeof diagnostics.readCrashCandidate, "function");
  const { writeFile, symlink, utimes } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp("/tmp/ai-crash-test-"));
  const now = Date.now();
  const scope = {
    pid: 42,
    executable: "/opt/node",
    startedAt: now - 1000,
    endedAt: now,
  };
  const path = `${root}/node-fixture.ips`;
  try {
    await writeFile(
      path,
      JSON.stringify({
        pid: 42,
        procPath: "/opt/node",
        procLaunch: new Date(now).toISOString(),
        captureTime: new Date(now).toISOString(),
      }),
    );
    assert.ok(await diagnostics.readCrashCandidate(path, scope));
    const rejected: unknown[] = [];
    await writeFile(path, "{SECRET");
    assert.equal(
      await diagnostics.readCrashCandidate(path, scope, (v) =>
        rejected.push(v),
      ),
      undefined,
    );
    assert.deepEqual(rejected.pop(), {
      reason: "invalid_json",
      sizeBytes: 7,
      mtimeDeltaMs:
        (await (await import("node:fs/promises")).stat(path)).mtimeMs -
        scope.startedAt,
    });
    await symlink(path, `${root}/link.ips`);
    await assert.rejects(
      diagnostics.readCrashCandidate(`${root}/link.ips`, scope),
    );
    await utimes(path, new Date(now - 60000), new Date(now - 60000));
    assert.equal(await diagnostics.readCrashCandidate(path, scope), undefined);
    await writeFile(path, "x".repeat(2 * 1024 * 1024 + 1));
    assert.equal(await diagnostics.readCrashCandidate(path, scope), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redacted-path IPS remains unverified but exposes bounded abort hypothesis", async () => {
  const { summarizeCrash } = await import("../scripts/macos-ai-diagnostics.ts");
  const scope = {
    pid: 123,
    executable: "/Users/runner/tools/claude",
    startedAt: Date.parse("2026-09-15T05:47:05Z"),
    endedAt: Date.parse("2026-09-15T05:47:05.050Z"),
  };
  // Synthetic two-object Apple IPS shape, NOT a recovered CI crash payload.
  // The CI log exposes only match booleans/deltas, not the reported path.
  const body = {
    pid: 123,
    procPath: "/Users/USER/*/claude",
    procName: "claude",
    procLaunch: "2026-09-15 05:47:05.006 +0000",
    captureTime: "2026-09-15 05:47:05.021 +0000",
    exception: { type: "EXC_CRASH", signal: "SIGABRT", private: "SECRET" },
    termination: {
      namespace: "DYLD",
      reasons: ["Library missing\n" + "x".repeat(3000)],
    },
    environment: { token: "SECRET" },
    threads: [{ threadState: "SECRET" }],
    vmSummary: "SECRET",
  };
  const rejected: any[] = [];
  const ips =
    JSON.stringify({ bug_type: "309", private: "SECRET" }) +
    "\n" +
    JSON.stringify(body);
  assert.equal(
    summarizeCrash(ips, scope, (v) => rejected.push(v)),
    undefined,
  );
  const evidence = rejected[0];
  assert.equal(evidence.executableMatches, false);
  assert.equal(evidence.reportedIdentity.procPath, "/Users/USER/*/claude");
  assert.equal(evidence.reportedIdentity.fieldTypes.procPath, "string");
  assert.equal(evidence.reportedIdentity.fieldTypes.usedImages, "missing");
  assert.equal(evidence.reportedIdentity.reportType, "309");
  assert.equal(evidence.hypothesis.status, "unverified-executable-match");
  assert.equal(evidence.hypothesis.exception.signal, "SIGABRT");
  assert.match(evidence.hypothesis.termination.reasons[0], /^Library missing /);
  assert.equal(evidence.hypothesis.termination.reasons[0].length, 1024);
  assert.ok(!JSON.stringify(evidence).includes("SECRET"));
  assert.ok(JSON.stringify(evidence).length < 16000);
});

test("unverified abort frames expose only bounded faulting symbols", async () => {
  const { summarizeCrash } = await import("../scripts/macos-ai-diagnostics.ts");
  const scope = {
    pid: 42,
    executable: "/opt/claude",
    startedAt: 10000,
    endedAt: 10100,
  };
  const body = {
    pid: 42,
    procPath: "/Users/USER/*/claude",
    procLaunch: new Date(10006).toISOString(),
    captureTime: new Date(10021).toISOString(),
    faultingThread: 1,
    threads: [
      { frames: [{ symbol: "SECRET" }] },
      {
        triggered: true,
        threadState: "SECRET",
        frames: Array.from({ length: 20 }, () => ({
          symbol: "ignite\n" + "x".repeat(1000),
          imageOffset: 123456,
          imageIndex: 7,
          symbolLocation: 98765,
          registers: "SECRET",
        })),
      },
    ],
    usedImages: [{ name: "SECRET", base: 123456 }],
  };
  for (const change of [
    {},
    { faultingThread: undefined },
    { pid: 43 },
    { captureTime: "invalid" },
  ]) {
    const rejected: any[] = [];
    assert.equal(
      summarizeCrash(JSON.stringify({ ...body, ...change }), scope, (v) =>
        rejected.push(v),
      ),
      undefined,
    );
    const hypothesis = rejected[0].hypothesis;
    if ("pid" in change || "captureTime" in change)
      assert.equal(hypothesis, undefined);
    else {
      assert.equal(hypothesis.status, "unverified-executable-match");
      assert.deepEqual(
        hypothesis.faultingSymbols,
        Array(16).fill(("ignite " + "x".repeat(1000)).slice(0, 512)),
      );
    }
    assert.doesNotMatch(JSON.stringify(rejected), /SECRET|123456|98765/);
  }
});

test("mismatch metadata distinguishes absent, malformed and sanitized paths without asserting identity", async () => {
  const { summarizeCrash } = await import("../scripts/macos-ai-diagnostics.ts");
  const scope = {
    pid: 42,
    executable: "/opt/claude",
    startedAt: 10000,
    endedAt: 10100,
  };
  for (const [pathFields, type, marker] of [
    [{}, "missing", false],
    [{ procPath: null }, "null", false],
    [{ procPath: { private: "SECRET" } }, "object", false],
    [{ procPath: "/Users/alice/" + "x".repeat(1000) + "\n" }, "string", false],
    [{ procPath: "/Users/USER/*/claude" }, "string", true],
    [{ procPath: "/other/claude" }, "string", false],
  ] as const) {
    const rejected: any[] = [];
    assert.equal(
      summarizeCrash(
        JSON.stringify({
          pid: 42,
          procLaunch: new Date(10006).toISOString(),
          captureTime: new Date(10021).toISOString(),
          ...pathFields,
          bug_type: { private: "SECRET" },
        }),
        scope,
        (v) => rejected.push(v),
      ),
      undefined,
    );
    const identity = rejected[0].reportedIdentity;
    assert.equal(identity.fieldTypes.procPath, type);
    assert.equal(identity.pathHasRedactionMarker, marker);
    assert.equal(identity.reportType, undefined);
    assert.ok((identity.procPath?.length ?? 0) <= 256);
    assert.ok(!JSON.stringify(rejected).includes("alice"));
    assert.ok(!JSON.stringify(rejected).includes("SECRET"));
    assert.equal(rejected[0].hypothesis.status, "unverified-executable-match");
    assert.deepEqual(rejected[0].hypothesis.exception, {});
  }
});

test("PID or time mismatch never exposes rejected report text or hypothesis", async () => {
  const { summarizeCrash } = await import("../scripts/macos-ai-diagnostics.ts");
  const scope = {
    pid: 42,
    executable: "/opt/claude",
    startedAt: 10000,
    endedAt: 10100,
  };
  for (const change of [
    { pid: 43 },
    { procLaunch: "invalid" },
    { captureTime: "invalid" },
    { procLaunch: new Date(8999).toISOString() },
    { captureTime: new Date(11101).toISOString() },
  ]) {
    const rejected: any[] = [];
    assert.equal(
      summarizeCrash(
        JSON.stringify({
          pid: 42,
          procPath: "/other/SECRET",
          procLaunch: new Date(10006).toISOString(),
          captureTime: new Date(10021).toISOString(),
          exception: { signal: "SECRET" },
          termination: { reasons: ["SECRET"] },
          ...change,
        }),
        scope,
        (v) => rejected.push(v),
      ),
      undefined,
    );
    assert.equal(rejected[0].hypothesis, undefined);
    assert.equal(rejected[0].reportedIdentity, undefined);
    assert.ok(!JSON.stringify(rejected).includes("SECRET"));
  }
});

const base = {
  executable: process.execPath,
  cwd: "/tmp",
  env: {},
  deadlineMs: 150,
};
for (const scenario of [
  {
    name: "absolute deadline despite continuous output",
    code: `const t=setInterval(()=>console.log('tick'),10);setTimeout(()=>clearInterval(t),600)`,
    expected: "timeout",
    options: {},
  },
  {
    name: "inactivity deadline",
    code: `setTimeout(()=>{},600)`,
    expected: "inactivity_timeout",
    options: { deadlineMs: 1000, inactivityMs: 100 },
  },
  {
    name: "stdout cap",
    code: `console.log('x'.repeat(10000))`,
    expected: "output_limit",
    options: { maxStdoutBytes: 128 },
  },
  {
    name: "stderr cap",
    code: `console.error('x'.repeat(10000))`,
    expected: "output_limit",
    options: { maxStderrBytes: 128 },
  },
]) {
  test(`real fake process: ${scenario.name}`, async () => {
    await assert.rejects(
      runBoundedProcess({
        ...base,
        ...scenario.options,
        args: ["-e", scenario.code],
      }),
      { code: scenario.expected },
    );
  });
}
test("pre-abort does not spawn even a marker-writing process", async () => {
  const cwd = await realpath(await mkdtemp("/tmp/ai-preabort-"));
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runBoundedProcess({
        ...base,
        cwd,
        signal: controller.signal,
        args: ["-e", `require('fs').writeFileSync('spawned','bad')`],
      }),
      { code: "cancelled" },
    );
    await assert.rejects(access(`${cwd}/spawned`));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("cancel while streaming reaps group descendants", async () => {
  const cwd = await realpath(await mkdtemp("/tmp/ai-cancel-"));
  const controller = new AbortController();
  try {
    await assert.rejects(
      runBoundedProcess({
        ...base,
        cwd,
        deadlineMs: 2000,
        signal: controller.signal,
        args: [
          "-e",
          `const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{stdio:'ignore'});require('fs').writeFileSync('pid',String(c.pid));console.log('ready');setTimeout(()=>{},700)`,
        ],
        onStdout: () => controller.abort(),
      }),
      { code: "cancelled" },
    );
    const pid = Number(await readFile(`${cwd}/pid`, "utf8"));
    if (process.platform === "linux") {
      // A dead zombie can briefly remain until init reaps it; it cannot execute.
      const state = await readFile(`/proc/${pid}/stat`, "utf8").catch(
        () => "gone",
      );
      assert.ok(state === "gone" || state.split(" ")[2] === "Z", state);
    } else {
      // Darwin has no /proc; ENOENT there never proved process cleanup.
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          process.kill(pid, 0);
        } catch (e) {
          assert.equal((e as NodeJS.ErrnoException).code, "ESRCH");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail("cancelled descendant still exists after cleanup");
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("real fake process receives only explicit env, scratch cwd and stdin", async () => {
  const cwd = await realpath(await mkdtemp("/tmp/ai-test-"));
  try {
    const result = await runBoundedProcess({
      executable: process.execPath,
      args: [
        "-e",
        `let input=''; process.stdin.on('data',d=>input+=d); process.stdin.on('end',()=>console.log(JSON.stringify({cwd:process.cwd(),env:process.env,input})))`,
      ],
      cwd,
      env: { HOME: cwd, AI_FAKE: "yes" },
      stdin: "SOURCE_BUNDLE_ONLY",
      deadlineMs: 2000,
    });
    assert.equal(result.exitCode, 0);
    const observed = JSON.parse(result.stdout);
    // Darwin inserts this one CoreFoundation field after exec. All other
    // fields must still match exactly; service credentials are not exempted.
    if (
      process.platform === "darwin" &&
      observed.env.__CF_USER_TEXT_ENCODING !== undefined
    ) {
      assert.match(
        observed.env.__CF_USER_TEXT_ENCODING,
        /^0x[0-9a-f]+:0x[0-9a-f]+:0x[0-9a-f]+$/i,
      );
      delete observed.env.__CF_USER_TEXT_ENCODING;
    }
    assert.deepEqual(observed, {
      cwd,
      env: { HOME: cwd, AI_FAKE: "yes" },
      input: "SOURCE_BUNDLE_ONLY",
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
