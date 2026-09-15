import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { AIError, type AIErrorCode } from "./errors.ts";
import { prepareAuth } from "./auth.ts";
import { buildInvocation, parseAuthStatus } from "./cli.ts";
import {
  classifyProviderError,
  compileOutputSchema,
  createEventParser,
  emitEvent,
  type AIEvent,
} from "./events.ts";
import { probeCli } from "./probes.ts";
import { MANAGED_PATHS, managedPolicyPresent } from "./policy.ts";
import { probeSandbox } from "./sandbox.ts";
import { runIsolatedCommand } from "./worker.ts";
import type {
  AIConfig,
  AnalysisRequest,
  AnalysisResult,
  ProviderProbe,
} from "./types.ts";
export { AIError } from "./errors.ts";
export type { AIErrorCode } from "./errors.ts";
export type { EngineAuth } from "./auth.ts";
export type { AIEvent, ProviderId } from "./events.ts";
export type {
  AIConfig,
  AnalysisRequest,
  AnalysisResult,
  ProviderConfig,
  ProviderProbe,
} from "./types.ts";

export async function probeProviders(
  config: AIConfig = {},
): Promise<ProviderProbe[]> {
  return Promise.all(
    (["codex", "claude"] as const).map(async (providerId) => {
      const providerConfig = config.providers?.[providerId];
      const cli = await probeCli(providerId, providerConfig);
      const isolation = await probeSandbox(
        config.sandbox,
        cli.executablePath ?? undefined,
      );
      const blockers: AIErrorCode[] = [];
      const managed = await managedPolicyPresent(MANAGED_PATHS[providerId]);
      if (managed) blockers.push("managed_policy_unsupported");
      if (!cli.executablePath) blockers.push("cli_missing");
      else if (!cli.capabilities.supported) blockers.push("unsupported_cli");
      if (!isolation.available) blockers.push("sandbox_unavailable");
      const authentication: ProviderProbe["authentication"] = {
        status: providerConfig?.auth ? "unknown" : "not_configured",
        method: providerConfig?.auth?.kind ?? null,
        checkedBy: cli.capabilities.supported
          ? "empty-home-cli-status"
          : "not-checked",
        networkValidated: false,
      };
      if (!providerConfig?.auth) blockers.push("auth_required");
      else if (
        !managed &&
        isolation.available &&
        cli.executablePath &&
        cli.capabilities.supported
      ) {
        const scratch = await realpath(await mkdtemp("/tmp/ai-auth-probe-"));
        try {
          const auth = await prepareAuth(
            providerId,
            providerConfig.auth,
            scratch,
          );
          const status = await runIsolatedCommand({
            provider: providerId,
            executablePath: cli.executablePath,
            args:
              providerId === "codex"
                ? ["login", "status"]
                : [
                    "--safe-mode",
                    "--restricted",
                    "--strict-mcp-config",
                    "--setting-sources",
                    "",
                    "auth",
                    "status",
                  ],
            scratch,
            auth,
            sandbox: config.sandbox,
            process: {
              deadlineMs: 10000,
              maxStdoutBytes: 65536,
              maxStderrBytes: 65536,
            },
          });
          authentication.status = parseAuthStatus(
            providerId,
            status.exitCode,
            status.stdout,
            status.stderr,
          );
          authentication.checkedBy = "isolated-cli-status";
          // CODEX_API_KEY is exec-only; login status cannot validate that input.
          if (
            providerId === "codex" &&
            providerConfig.auth.kind === "api-key-file"
          )
            authentication.status = "unknown";
          if (authentication.status === "not_authenticated")
            blockers.push("auth_invalid");
        } catch (e) {
          blockers.push(e instanceof AIError ? e.code : "auth_invalid");
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      }
      return {
        providerId,
        installed: cli.executablePath !== null,
        cliVersion: cli.capabilities.version,
        capabilities: cli.capabilities,
        authentication,
        isolation,
        blockers,
        ready:
          blockers.length === 0 && authentication.status === "authenticated",
        inferenceVerified: false,
      };
    }),
  );
}
function bounded(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum)
    throw new AIError("invalid_request");
  return n;
}
const emit = emitEvent;
/** Only entry point that performs inference. Never falls back to another engine,
 * model, mock, or unsandboxed process. Source is not stored in host scratch.
 */
export async function runAnalysis(
  request: AnalysisRequest,
): Promise<AnalysisResult> {
  if (request.signal?.aborted) throw new AIError("cancelled");
  if (
    !["codex", "claude"].includes(request.providerId) ||
    typeof request.trustedPrompt !== "string" ||
    !request.trustedPrompt.length ||
    request.context === undefined ||
    !request.schema ||
    typeof request.schema !== "object" ||
    Array.isArray(request.schema)
  )
    throw new AIError("invalid_request");
  const config = request.config ?? {},
    deadlineMs = bounded(config.deadlineMs, 120000, 600000);
  const maxInput = bounded(config.maxInputBytes, 1024 * 1024, 8 * 1024 * 1024),
    maxOut = bounded(config.maxStdoutBytes, 4 * 1024 * 1024, 16 * 1024 * 1024),
    maxErr = bounded(config.maxStderrBytes, 256 * 1024, 1024 * 1024);
  const inactivityMs =
    config.inactivityMs === undefined
      ? undefined
      : bounded(config.inactivityMs, 45000, 600000);
  let schemaText: string, invocation: ReturnType<typeof buildInvocation>;
  try {
    schemaText = JSON.stringify(request.schema);
    invocation = buildInvocation(request.providerId, {
      ...request,
      authMode: "api-key",
    });
  } catch (e) {
    throw e instanceof AIError ? e : new AIError("invalid_request");
  }
  if (
    Buffer.byteLength(invocation.stdin) > maxInput ||
    Buffer.byteLength(schemaText) > 65536 ||
    Buffer.byteLength(request.trustedPrompt) > 65536
  )
    throw new AIError("input_limit");
  compileOutputSchema(request.schema);
  const startedAt = new Date().toISOString(),
    started = performance.now(),
    controller = new AbortController();
  const signal = request.signal
    ? AbortSignal.any([request.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  let scratch: string | undefined;
  const remaining = () =>
    Math.max(1, Math.floor(deadlineMs - (performance.now() - started)));
  try {
    emit(request.onEvent, { type: "status", phase: "preparing" });
    if (await managedPolicyPresent(MANAGED_PATHS[request.providerId]))
      throw new AIError("managed_policy_unsupported");
    const initialIsolation = await probeSandbox(
      config.sandbox,
      undefined,
      signal,
    );
    if (!initialIsolation.available) throw new AIError("sandbox_unavailable");
    const provider = config.providers?.[request.providerId],
      cli = await probeCli(request.providerId, provider, signal);
    if (!cli.executablePath) throw new AIError("cli_missing");
    if (!cli.capabilities.supported || !cli.capabilities.version)
      throw new AIError("unsupported_cli");
    const isolation = await probeSandbox(
      config.sandbox,
      cli.executablePath,
      signal,
    );
    if (!isolation.available || !isolation.runtimeVerified)
      throw new AIError("sandbox_unavailable");
    if (signal.aborted) throw new AIError("cancelled");
    scratch = await realpath(await mkdtemp("/tmp/ai-analysis-"));
    const auth = await prepareAuth(request.providerId, provider?.auth, scratch);
    invocation = buildInvocation(request.providerId, {
      ...request,
      authMode: auth.mode,
    });
    const schemaFile = `${scratch}/output-schema.json`;
    await writeFile(schemaFile, schemaText, { mode: 0o600, flag: "wx" });
    const parser = createEventParser(
      request.providerId,
      request.schema,
      request.onEvent,
    );
    emit(request.onEvent, { type: "status", phase: "running" });
    const result = await runIsolatedCommand({
      provider: request.providerId,
      executablePath: cli.executablePath,
      args: invocation.args,
      scratch,
      auth,
      sandbox: config.sandbox,
      schemaFile,
      process: {
        stdin: invocation.stdin,
        signal,
        deadlineMs: remaining(),
        inactivityMs,
        maxStdoutBytes: maxOut,
        maxStderrBytes: maxErr,
        onStdout: (chunk) => parser.push(chunk),
      },
    });
    if (signal.aborted) throw new AIError("cancelled");
    if (result.exitCode !== 0) throw classifyProviderError(result.stderr);
    emit(request.onEvent, { type: "status", phase: "validating" });
    const parsed = parser.finish();
    emit(request.onEvent, { type: "status", phase: "completed" });
    return {
      output: parsed.output,
      metadata: {
        providerId: request.providerId,
        model: request.model,
        observedModel: parsed.observedModel,
        cliVersion: cli.capabilities.version,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started),
        usage: parsed.usage,
        isolation:
          process.platform === "darwin" ? "darwin-seatbelt" : "linux-bwrap",
        schemaValidated: true,
        referenceValidation: "caller-required",
        fallbackUsed: false,
        parserVersion: "1",
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
      },
    };
  } catch (e) {
    if (request.signal?.aborted) throw new AIError("cancelled");
    if (controller.signal.aborted) throw new AIError("timeout");
    throw e instanceof AIError ? e : new AIError("provider_failed");
  } finally {
    clearTimeout(timer);
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}
