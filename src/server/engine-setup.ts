import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { userInfo, tmpdir } from "node:os";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareAuth } from "./ai/auth.ts";
import { probeProviders } from "./ai/index.ts";
import { executableIdentity, resolveLocalEngine } from "./ai/discovery.ts";
import { AIError } from "./ai/errors.ts";
import type { AIConfig, ProviderProbe } from "./ai/types.ts";
import type { ProviderId } from "./ai/events.ts";

export interface EngineSetupEntry extends ProviderProbe {
  candidateId: string | null;
  localAuth:
    "available" | "missing" | "reused" | "advanced" | "unsupported" | "session";
}
export interface EngineSetupStatus {
  engines: EngineSetupEntry[];
}
// Internal server dependencies; never accept these from request JSON.
interface Dependencies {
  home: string;
  scratchRoot: string;
  resolve: typeof resolveLocalEngine;
  probe: typeof probeProviders;
  identity: typeof executableIdentity;
  authMetadata: (path: string) => Promise<boolean>;
}
async function authMetadata(path: string): Promise<boolean> {
  try {
    if ((await realpath(path)) !== path) return false;
    const s = await lstat(path);
    return (
      s.isFile() &&
      !s.isSymbolicLink() &&
      s.uid === process.getuid?.() &&
      (s.mode & 0o077) === 0 &&
      s.size > 0 &&
      s.size <= 65536
    );
  } catch {
    return false;
  }
}
/** Session-scoped executable consent. Discovery never reads local credentials.
 * Explicit user tokens use a private temporary file and the existing auth adapter;
 * authenticated CLI probes/inference still pass the production isolation gate. */
export function createEngineSetupService(
  base: AIConfig = {},
  overrides: Partial<Dependencies> = {},
) {
  const deps: Dependencies = {
    home: userInfo().homedir,
    scratchRoot: tmpdir(),
    resolve: resolveLocalEngine,
    probe: probeProviders,
    authMetadata,
    identity: executableIdentity,
    ...overrides,
  };
  const selected = new Map<
    ProviderId,
    { id: string; path: string; identity: string; consent: boolean }
  >();
  let cached: EngineSetupStatus | undefined;
  let scratch: string | undefined;
  let sessionAuth: { candidateId: string; path: string } | undefined;
  function forgetToken() {
    const old = sessionAuth;
    sessionAuth = undefined;
    cached = undefined;
    if (old) rmSync(old.path, { force: true });
  }
  const controller = new AbortController();
  const signal = controller.signal;
  let queue: Promise<unknown> = Promise.resolve();
  function check() {
    if (signal.aborted) throw new AIError("cancelled");
  }
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(new AIError("cancelled"));
    const task = queue.then(async () => {
      check();
      const value = await work();
      check();
      return value;
    });
    queue = task.catch(() => {});
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new AIError("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      task
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
  async function validate(
    provider: ProviderId,
    pick: { path: string; identity: string },
  ): Promise<boolean> {
    check();
    try {
      const path = await deps.resolve(provider, pick.path);
      const identity = await deps.identity(path, signal);
      check();
      return path === pick.path && identity === pick.identity;
    } catch {
      check();
      return false;
    }
  }
  const config = (): AIConfig => ({
    ...base,
    providers: Object.fromEntries(
      (["codex", "claude"] as const).map((id) => {
        const pick = selected.get(id),
          advanced = base.providers?.[id];
        return [
          id,
          {
            ...advanced,
            ...(pick ? { executablePath: pick.path } : {}),
            ...(id === "claude" &&
            sessionAuth?.candidateId === pick?.id &&
            sessionAuth
              ? {
                  auth: {
                    kind: "claude-oauth-token-file" as const,
                    path: sessionAuth.path,
                  },
                }
              : {}),
            ...(pick?.consent && !advanced?.auth
              ? {
                  auth: {
                    kind: "codex-auth-file" as const,
                    path: `${deps.home}/.codex/auth.json`,
                  },
                }
              : {}),
          },
        ];
      }),
    ),
  });
  async function scan(): Promise<EngineSetupStatus> {
    check();
    cached = undefined;
    for (const id of ["codex", "claude"] as const) {
      try {
        const path = await deps.resolve(
          id,
          base.providers?.[id]?.executablePath,
        );
        const identity = await deps.identity(path, signal);
        check();
        const old = selected.get(id);
        if (old?.path !== path || old?.identity !== identity) {
          if (id === "claude") forgetToken();
          selected.set(id, {
            id: randomUUID(),
            path,
            identity,
            consent: false,
          });
        }
      } catch {
        check();
        if (id === "claude") forgetToken();
        selected.delete(id);
      }
    }
    const probes = await deps.probe(
      config(),
      signal,
      async (provider, path) => {
        const pick = selected.get(provider);
        if (!pick || pick.path !== path || !(await validate(provider, pick))) {
          check();
          if (pick) pick.consent = false;
          if (provider === "claude") forgetToken();
          cached = undefined;
          throw new AIError("auth_invalid");
        }
        check();
      },
    );
    check();
    // A probe is asynchronous: never publish old readiness after an update.
    for (const [id, pick] of selected) {
      if (!(await validate(id, pick))) {
        if (id === "claude") forgetToken();
        selected.delete(id);
        cached = undefined;
      }
    }
    const entries: EngineSetupEntry[] = [];
    for (const probe of probes) {
      const pick = selected.get(probe.providerId);
      const localAuth: EngineSetupEntry["localAuth"] = base.providers?.[
        probe.providerId
      ]?.auth
        ? "advanced"
        : probe.providerId === "claude" &&
            sessionAuth?.candidateId === pick?.id &&
            sessionAuth
          ? "session"
          : pick?.consent
            ? "reused"
            : probe.providerId === "claude"
              ? "unsupported"
              : (await deps.authMetadata(`${deps.home}/.codex/auth.json`))
                ? "available"
                : "missing";
      check();
      entries.push({
        ...probe,
        installed: !!pick,
        candidateId: pick?.id ?? null,
        localAuth,
        ready:
          !!pick &&
          (pick.consent ||
            localAuth === "session" ||
            !!base.providers?.[probe.providerId]?.auth) &&
          probe.ready &&
          probe.capabilities.supported &&
          probe.authentication.status === "authenticated" &&
          probe.isolation.available &&
          probe.isolation.runtimeVerified,
      });
    }
    return (cached = { engines: entries });
  }
  return {
    status: () => enqueue(async () => cached ?? scan()),
    rescan: () => enqueue(scan),
    close(): void {
      if (signal.aborted) return;
      controller.abort();
      forgetToken();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
      scratch = undefined;
      for (const pick of selected.values()) pick.consent = false;
      selected.clear();
      cached = undefined;
      base = {};
    },
    setSessionAuth(
      provider: ProviderId,
      candidateId: string,
      token: string,
    ): Promise<EngineSetupStatus> {
      return enqueue(async () => {
        const pick = selected.get(provider);
        if (
          provider !== "claude" ||
          !pick ||
          pick.id !== candidateId ||
          base.providers?.claude?.auth
        )
          throw new AIError("invalid_request");
        // Rotation is fail-closed: a bad replacement cannot leave old readiness.
        forgetToken();
        try {
          if (
            typeof token !== "string" ||
            Buffer.byteLength(token, "utf8") > 32768 ||
            !/^sk-ant-oat01-[A-Za-z0-9_-]+$/.test(token) ||
            !(await validate(provider, pick))
          )
            throw new AIError("auth_invalid");
          check();
          scratch ??= realpathSync(
            mkdtempSync(join(deps.scratchRoot, "prce-engine-auth-")),
          );
          const path = join(scratch, randomUUID());
          sessionAuth = { candidateId, path };
          writeFileSync(path, token, { flag: "wx", mode: 0o600 });
          token = "";
          // Reuse production file and credential validation; never copy CLI login state.
          await prepareAuth(
            "claude",
            { kind: "claude-oauth-token-file", path },
            scratch,
          );
          check();
          const result = await scan();
          if (selected.get(provider) !== pick)
            throw new AIError("auth_invalid");
          return result;
        } catch {
          forgetToken();
          check();
          throw new AIError("auth_invalid");
        } finally {
          token = "";
        }
      }).finally(() => {
        token = "";
      });
    },
    forgetSessionAuth(
      provider: ProviderId,
      candidateId: string,
    ): Promise<EngineSetupStatus> {
      return enqueue(async () => {
        const pick = selected.get(provider);
        if (provider !== "claude" || !pick || pick.id !== candidateId)
          throw new AIError("invalid_request");
        forgetToken();
        return scan();
      });
    },
    reuseLocalAuth(
      provider: ProviderId,
      candidateId: string,
    ): Promise<EngineSetupStatus> {
      return enqueue(async () => {
        const pick = selected.get(provider);
        if (
          provider !== "codex" ||
          !pick ||
          pick.id !== candidateId ||
          base.providers?.[provider]?.auth
        )
          throw new AIError("invalid_request");
        // Auth metadata may yield: validate identity AFTER it, before granting consent.
        const available = await deps.authMetadata(
          `${deps.home}/.codex/auth.json`,
        );
        if (!available || !(await validate(provider, pick))) {
          check();
          pick.consent = false;
          cached = undefined;
          throw new AIError("auth_invalid");
        }
        check();
        pick.consent = true;
        const result = await scan();
        if (selected.get(provider) !== pick) throw new AIError("auth_invalid");
        return result;
      });
    },
    resolveConfig(provider: ProviderId): Promise<AIConfig> {
      return enqueue(async () => {
        if (!["codex", "claude"].includes(provider))
          throw new AIError("invalid_request");
        if (!cached) await scan();
        const pick = selected.get(provider);
        if (!pick || !(await validate(provider, pick))) {
          if (pick) pick.consent = false;
          if (provider === "claude") forgetToken();
          cached = undefined;
          throw new AIError("cli_missing");
        }
        check();
        // runAnalysis rechecks capabilities, isolation and allowlisted auth contents.
        return config();
      });
    },
  };
}
