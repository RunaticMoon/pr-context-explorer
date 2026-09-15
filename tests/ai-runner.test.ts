import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, readFile, access } from "node:fs/promises";
import { runBoundedProcess } from "../src/server/ai/runner.ts";

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
