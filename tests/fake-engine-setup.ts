import type { LiveAPIOptions } from "../src/server/live-api.ts";
import type { EngineSetupStatus } from "../src/server/engine-setup.ts";
import type { AIConfig } from "../src/server/ai/types.ts";
/** Explicit FAKE setup for scripted runner tests. Never used by production. */
export function fakeEngineSetup(
  config: AIConfig = {},
): NonNullable<LiveAPIOptions["engineSetup"]> {
  const status: EngineSetupStatus = {
    engines: (["codex", "claude"] as const).map((providerId) => ({
      providerId,
      installed: true,
      cliVersion: "FAKE-setup-not-inference",
      candidateId: "FAKE-candidate",
      localAuth: "advanced",
      capabilities: { supported: true, missing: [] } as any,
      authentication: {
        status: "authenticated",
        method: null,
        checkedBy: "not-checked",
        networkValidated: false,
      },
      isolation: {
        available: true,
        runtimeVerified: true,
        platform: "FAKE",
        blocker: null,
      } as any,
      blockers: [],
      ready: true,
      inferenceVerified: false,
    })),
  };
  return {
    close() {},
    status: async () => status,
    rescan: async () => status,
    reuseLocalAuth: async () => status,
    resolveConfig: async () => config,
  };
}
