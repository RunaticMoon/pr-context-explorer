import type { AIErrorCode } from "./errors.ts";
import type { EngineAuth } from "./auth.ts";
import type { AIEvent, ProviderId } from "./events.ts";
import type { SandboxConfig, SandboxProbe } from "./sandbox.ts";
import type { Capabilities } from "./cli.ts";
export interface ProviderConfig {
  executablePath?: string;
  auth?: EngineAuth;
}
/** Server-owned configuration only. Never deserialize these paths from a browser request. */
export interface AIConfig {
  providers?: Partial<Record<ProviderId, ProviderConfig>>;
  sandbox?: SandboxConfig;
  deadlineMs?: number;
  inactivityMs?: number;
  maxInputBytes?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}
export interface AnalysisRequest {
  providerId: ProviderId;
  model: string;
  schema: object;
  context: unknown;
  trustedPrompt: string;
  signal?: AbortSignal;
  onEvent?: (event: AIEvent) => void;
  config?: AIConfig;
}
export interface ProviderProbe {
  providerId: ProviderId;
  installed: boolean;
  cliVersion: string | null;
  capabilities: Capabilities;
  authentication: {
    status:
      "not_configured" | "authenticated" | "not_authenticated" | "unknown";
    method: EngineAuth["kind"] | null;
    checkedBy: "empty-home-cli-status" | "isolated-cli-status" | "not-checked";
    networkValidated: false;
  };
  isolation: SandboxProbe;
  blockers: AIErrorCode[];
  ready: boolean;
  inferenceVerified: false;
}
export interface AnalysisResult {
  output: unknown;
  metadata: {
    providerId: ProviderId;
    model: string;
    observedModel: string | null;
    cliVersion: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    usage: Record<string, number>;
    isolation: "linux-bwrap" | "darwin-seatbelt";
    schemaValidated: true;
    referenceValidation: "caller-required";
    fallbackUsed: false;
    parserVersion: "1";
    stdoutBytes: number;
    stderrBytes: number;
  };
}
