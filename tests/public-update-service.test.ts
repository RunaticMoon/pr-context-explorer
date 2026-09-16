import test from "node:test";
import assert from "node:assert/strict";
import { PublicUpdater } from "../desktop/public-update/index.ts";
import { validatePlan } from "../desktop/public-update/helper.ts";
test("service refuses busy install and never accepts renderer configuration", async () => {
  const u = new PublicUpdater({
    currentVersion: "0.5.1",
    appPath: "/Applications/PR Context Explorer.app",
    dataDir: "/nonexistent",
    nodePath: "/untrusted/node",
    helperPath: "/untrusted/helper",
    isBusy: () => true,
  });
  await assert.rejects(u.prepareInstall(), /BUSY/);
  assert.equal(u.status.phase, "error");
  await u.close();
  await assert.rejects(u.check(), /CLOSED/);
});
test("invalid handoff plans reject unknown keys and path escape", () => {
  for (const p of [
    {},
    { schemaVersion: 1, url: "https://evil.test" },
    {
      schemaVersion: 1,
      appPath: "/tmp/foreign.app",
      workDir: "/tmp/../../etc",
    },
  ])
    assert.throws(() => validatePlan(p, "/tmp/plan.json"));
});
