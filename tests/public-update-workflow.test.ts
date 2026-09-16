import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
test("public update Mac jobs receive explicit real update acceptance inputs", () => {
  const w = readFileSync(".github/workflows/macos-public-release.yml", "utf8");
  for (const job of [
    w.split("  build:\n")[1].split("  macos26-install:")[0],
    w.split("  macos26-install:\n")[1].split("  publish:")[0],
  ]) {
    assert.equal(
      (job.match(/npm run desktop:smoke:packaged/g) || []).length,
      1,
    );
    assert.ok(
      job.indexOf("export PRCE_DESKTOP_ZIP=") <
        job.indexOf("npm run desktop:smoke:packaged"),
    );
    assert.ok(
      job.indexOf("npm run desktop:smoke:packaged") <
        job.indexOf("npm run test:public-update:mac"),
    );
    assert.match(job, /PRCE_PUBLIC_UPDATE_CI: '1'/);
    assert.match(job, /PRCE_PUBLIC_UPDATE_OLD_VERSION: '0\.5\.99'/);
    assert.match(job, /export PRCE_PUBLIC_UPDATE_ZIP="\$PRCE_DESKTOP_ZIP"/);
    assert.match(
      job,
      /export PRCE_PUBLIC_UPDATE_MANIFEST="\$GITHUB_WORKSPACE\/release\/public-mac.json"/,
    );
  }
  const publish = w.split("  publish:\n")[1];
  assert.match(publish, /inputs.approve_public_release == true/);
  assert.match(publish, /github.event_name == 'workflow_dispatch'/);
  assert.doesNotMatch(publish, /refs\/heads\/feat\/public-updates/);
});
