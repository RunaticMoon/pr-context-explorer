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
  assert.match(diagnostic, /--startup-ab-icu-file/);
  const nativeBuild = diagnostic.indexOf(
    "node scripts/build-macos-acl.mjs --arch arm64",
  );
  const aclTests = diagnostic.indexOf("tsx --test tests/ai-macos-acl.test.ts");
  assert.ok(nativeBuild > diagnostic.indexOf("npm ci"));
  assert.ok(
    aclTests > nativeBuild &&
      aclTests < diagnostic.indexOf("--startup-ab-icu-file"),
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

test("hotfix CI installs the exact Mac15-gated archive on a fresh Mac26 runner", () => {
  const workflow = readFileSync(".github/workflows/macos-unsigned.yml", "utf8");
  assert.match(workflow, /branches: \[.*fix\/standalone-runtime-deps/);
  assert.match(workflow, /github.ref == 'refs\/heads\/fix\/standalone-runtime-deps'/);
  const install = workflow.split("\n  macos26-install:\n")[1]?.split("\n  native-diagnostic:")[0];
  assert.ok(install, "Mac26 installation job required");
  assert.match(install, /needs: build/);
  assert.match(install, /runs-on: macos-26/);
  assert.match(install, /timeout-minutes: 10/);
  assert.match(install, /artifact-ids: \$\{\{ needs.build.outputs.artifact-id \}\}/);
  assert.match(install, /digest-mismatch: error/);
  assert.match(install, /PRCE_DESKTOP_ZIP=/);
  assert.match(install, /PRCE_PACKAGED_CI: '1'/);
  assert.match(install, /npm ci --ignore-scripts/);
  assert.match(install, /npm run desktop:smoke:packaged/);
  assert.doesNotMatch(install, /continue-on-error|desktop:build|desktop:dist|desktop:prepare|npm test|secrets\.|contents: write|--no-sandbox/);
  assert.ok(workflow.indexOf('distribution/ci-gate.sh') < workflow.indexOf('id: artifact'));
});
