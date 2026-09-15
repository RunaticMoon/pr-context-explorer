// Integration guard only: deliberately no AI config/credential, no inference.
// Uses an app-owned synthetic Git fixture, never a user repository/account.
import { sample } from "../tests/analysis-v3-fixtures.test.ts";
import { executeAnalysis } from "../src/server/live-analysis.ts";
if (process.env.PRCE_AI_CONFIG) throw Error("guard probe requires PRCE_AI_CONFIG unset");
const cleanup: (() => void)[] = [];
try {
  const snapshot = await sample({ after: (fn) => cleanup.push(fn) });
  let rejected: string | undefined;
  try {
    await executeAnalysis(snapshot, "codex", "guard-no-inference", { kind: "pr" }, new AbortController().signal, () => {});
  } catch (e) { rejected = e instanceof Error ? e.message : "rejected"; }
  if (!rejected) throw Error("unguarded execution unexpectedly succeeded");
  console.log(JSON.stringify({ check: "default executeAnalysis V3 → official adapter absence guard", rejected, credentialConfigured: false, inferenceVerified: false, targetSourceExecuted: false, resultFabricated: false }, null, 2));
} finally { cleanup.forEach((fn) => fn()); }
