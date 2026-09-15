import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { runBoundedProcess } from "../src/server/ai/runner.ts";

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
  const cwd = await mkdtemp("/tmp/ai-preabort-");
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
  const cwd = await mkdtemp("/tmp/ai-cancel-");
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
    // A dead zombie can briefly remain until init reaps it; it cannot execute.
    const state = await readFile(`/proc/${pid}/stat`, "utf8").catch(
      () => "gone",
    );
    assert.ok(state === "gone" || state.split(" ")[2] === "Z", state);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("real fake process receives only explicit env, scratch cwd and stdin", async () => {
  const cwd = await mkdtemp("/tmp/ai-test-");
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
    assert.deepEqual(JSON.parse(result.stdout), {
      cwd,
      env: { HOME: cwd, AI_FAKE: "yes" },
      input: "SOURCE_BUNDLE_ONLY",
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
