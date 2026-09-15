import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
test("every executable Mac validation step has an explicit bounded deadline", () => {
  const workflow = readFileSync(".github/workflows/macos-unsigned.yml", "utf8");
  const steps = workflow
    .split(/^      - /m)
    .slice(1)
    .filter((step) => /^        run:/m.test(step));
  assert.ok(steps.length >= 6);
  for (const step of steps) {
    const minutes = Number(
      step.match(/^        timeout-minutes: (\d+)$/m)?.[1],
    );
    assert.ok(
      Number.isInteger(minutes) && minutes > 0 && minutes <= 10,
      `Missing/unsafe step deadline: ${step.split("\n")[0]}`,
    );
  }
  const jobMinutes = Number(
    workflow.match(/^    timeout-minutes: (\d+)$/m)?.[1],
  );
  assert.ok(Number.isInteger(jobMinutes) && jobMinutes > 0 && jobMinutes <= 30);
});
test("native-only CI cannot build or expose installation artifacts", () => {
  const workflow = readFileSync(".github/workflows/macos-unsigned.yml", "utf8");
  const diagnostic = workflow.split("\n  native-diagnostic:\n")[1];
  assert.ok(diagnostic, "explicit diagnostic-only job required");
  assert.match(
    workflow.split("\n  native-diagnostic:\n")[0],
    /!contains\(github.event.head_commit.message, '\[native-diagnostic\]'\)/,
  );
  assert.match(diagnostic, /--startup-help-only=claude/);
  const nativeBuild = diagnostic.indexOf(
    "node scripts/build-macos-acl.mjs --arch arm64",
  );
  const aclTests = diagnostic.indexOf("tsx --test tests/ai-macos-acl.test.ts");
  assert.ok(nativeBuild > diagnostic.indexOf("npm ci"));
  assert.ok(
    aclTests > nativeBuild &&
      aclTests < diagnostic.indexOf("--startup-help-only=claude"),
  );
  const compileStep = diagnostic
    .split(/^      - /m)
    .find((step) => step.includes("node scripts/build-macos-acl.mjs"));
  assert.match(compileStep || "", /timeout-minutes: 2/);
  assert.doesNotMatch(compileStep || "", /continue-on-error/);
  assert.doesNotMatch(
    diagnostic,
    /upload-artifact|desktop:dist|desktop:prepare|GH_TOKEN|contents: write/,
  );
});

test("Mac CI may collect independent diagnostics but artifacts require every actual gate success", () => {
  const script = "distribution/ci-gate.sh";
  assert.ok(existsSync(script), "CI outcome gate implementation required");
  const run = (values: string[]) =>
    spawnSync("bash", [script, ...values], { encoding: "utf8" });
  assert.equal(run(["success", "success", "success"]).status, 0);
  for (let position = 0; position < 3; position++) {
    for (const outcome of [
      "failure",
      "cancelled",
      "skipped",
      "",
      "success; true",
    ]) {
      const values = ["success", "success", "success"];
      values[position] = outcome;
      assert.notEqual(run(values).status, 0);
    }
  }
  assert.notEqual(run([]).status, 0);
});
