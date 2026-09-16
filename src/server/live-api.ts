import {
  emptyJiraSettings,
  discoverForSnapshot,
  editCandidates,
  SourceBridge,
  type JiraSettings,
} from "./source-bridge.ts";
import { createEngineSetupService } from "./engine-setup.ts";
import { readServerSettings } from "./settings.ts";
import path from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { rmSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { LocalStore, cacheKey } from "./store.ts";
import {
  analysisIdentity,
  localPipelineCache,
  parseScope,
  transmissionPlan,
  validatePipelineResult,
  type SavedAnalysis,
} from "./live-pipeline.ts";
import {
  PipelineError,
  type PipelineOptions,
  type PipelineRunner,
  type PipelineCoverage,
  type SemanticAudit,
} from "./analysis-v3/index.ts";
import { GitHubClient, validateConnection, type Connection } from "./github.ts";
import { connectGitHub, connectionView } from "./github-simple.ts";
import {
  deleteGitHubSession,
  replaceGitHubSession,
} from "./github-session-secrets.ts";
import { ingestPull, bareCachePath, pruneGitCache } from "./ingest.ts";
import { compareGit, type LiveSnapshot } from "./live-git.ts";
import { executeAnalysis, probeEngines, type Scope } from "./live-analysis.ts";
export type Job = {
  id: string;
  kind: "snapshot" | "analysis";
  status:
    "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";
  events: { at: string; message: string }[];
  result?: unknown;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  processStatus?: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  analysisStatus?: "complete" | "partial" | "insufficient_context";
  coverage?: PipelineCoverage;
  semanticAudit?: SemanticAudit;
};
export type LiveAPIOptions = {
  dataDir?: string;
  /** Trusted server/test seam, never browser configuration. */
  engineSetup?: Omit<
    ReturnType<typeof createEngineSetupService>,
    "close" | "setSessionAuth" | "forgetSessionAuth"
  > &
    Partial<
      Pick<
        ReturnType<typeof createEngineSetupService>,
        "setSessionAuth" | "forgetSessionAuth"
      >
    > & {
      close?: () => void;
    };
  ingest?: typeof ingestPull;
  execute?: typeof executeAnalysis;
  /** Trusted test/server injection only; never accepted from HTTP JSON. */
  runner?: PipelineRunner;
  versions?: PipelineOptions["versions"];
  probe?: typeof probeEngines;
  client?: (c: Connection) => GitHubClient;
};
export class LiveAPI {
  private engineSetupBusy = false;
  private githubSessions = new Set<string>();
  private readonly lifetime = new AbortController();
  readonly store: LocalStore;
  readonly jira: SourceBridge;
  readonly engineSetup: NonNullable<LiveAPIOptions["engineSetup"]>;
  readonly jobs = new Map<string, { job: Job; controller: AbortController }>();
  constructor(private options: LiveAPIOptions = {}) {
    this.store = new LocalStore(
      options.dataDir ||
        process.env.PRCE_DATA_DIR ||
        path.join(homedir(), ".local/share/pr-context-explorer"),
    );
    this.jira = new SourceBridge(this.store);
    this.engineSetup =
      options.engineSetup ??
      createEngineSetupService(readServerSettings(process.env.PRCE_AI_CONFIG));
    this.store.prune();
    pruneGitCache(this.store.root, this.store.retentionMs);
  }
  connection(id: string) {
    const c = this.store.get<Connection>(
      "config",
      cacheKey({ connection: id }),
    );
    if (!c) throw Error("connection not found");
    return validateConnection(c);
  }
  snapshot(id: string) {
    const item = this.store.get<{ snapshot: LiveSnapshot; stale: boolean }>(
      "snapshot",
      id,
    );
    if (!item) throw Error("snapshot not found or expired");
    return item;
  }
  private validateSaved(r: SavedAnalysis, key: string) {
    const { snapshot: s } = this.snapshot(r.output?.snapshotId);
    const scope = parseScope(r.scope);
    if (
      !r.policy ||
      typeof r.policy.audit !== "boolean" ||
      typeof r.policy.allowHistoricalSteps !== "boolean" ||
      r.cacheKey !== key ||
      !["codex", "claude"].includes(r.metadata.providerId)
    )
      throw Error("cached identity mismatch");
    if (
      analysisIdentity(
        s,
        this.connection(s.connectionId),
        scope,
        r.metadata.providerId,
        r.metadata.model,
        r.policy,
        this.options.versions,
      ) !== key
    )
      throw Error("cached input/version mismatch");
    validatePipelineResult(r, s, scope, r.policy);
  }
  private start(
    kind: Job["kind"],
    work: (
      signal: AbortSignal,
      event: (message: string) => void,
    ) => Promise<any>,
  ) {
    if (
      [...this.jobs.values()].some((x) =>
        ["running", "queued"].includes(x.job.status),
      )
    )
      throw Error("busy: one local collection/model job at a time");
    while (this.jobs.size >= 16)
      this.jobs.delete(this.jobs.keys().next().value!);
    const id = randomBytes(16).toString("hex"),
      controller = new AbortController();
    const job: Job = {
      id,
      kind,
      status: "queued",
      processStatus: "queued",
      events: [],
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(id, { job, controller });
    const event = (message: string) => {
      if (job.events.length < 150)
        job.events.push({
          at: new Date().toISOString(),
          message: message.slice(0, 240),
        });
    };
    queueMicrotask(async () => {
      try {
        job.status = "running";
        job.processStatus = "running";
        event("Started");
        const result = await work(controller.signal, event);
        controller.signal.throwIfAborted();
        job.result = result;
        job.processStatus = "succeeded";
        job.analysisStatus = result?.output?.analysisStatus;
        job.status =
          result?.snapshot?.coverage?.complete === false
            ? "partial"
            : "succeeded";
        event(
          job.analysisStatus
            ? `Process succeeded; analysisStatus=${job.analysisStatus}; semanticAudit=${result.semanticAudit.status}`
            : "Collection finished; see coverage",
        );
      } catch (e: any) {
        job.status = controller.signal.aborted ? "cancelled" : "failed";
        job.processStatus = job.status;
        if (e instanceof PipelineError) {
          job.coverage = e.coverage || undefined;
          job.semanticAudit = e.semanticAudit;
        }
        job.error = controller.signal.aborted ? "cancelled" : this.safeError(e);
        event(job.error!);
      } finally {
        job.finishedAt = new Date().toISOString();
      }
    });
    return job;
  }
  safeError(e: any) {
    const message =
      typeof e?.message === "string" ? e.message : "local operation failed";
    return message
      .replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "[redacted]")
      .slice(0, 400);
  }
  close() {
    this.lifetime.abort();
    this.jira.close();
    this.engineSetup.close?.();
    for (const ref of this.githubSessions) deleteGitHubSession(ref);
    this.githubSessions.clear();
    for (const { controller } of this.jobs.values()) controller.abort();
  }
  async handle(
    method: string,
    url: URL,
    body: any,
  ): Promise<{ status: number; data: unknown } | null> {
    if (this.lifetime.signal.aborted && method !== "GET")
      throw Error("Connection session closed");
    const p = url.pathname,
      ok = (data: unknown, status = 200) => ({ status, data }),
      client = (c: Connection) =>
        this.options.client?.(c) || new GitHubClient(c);
    if (p === "/api/connections/connect" && method === "POST") {
      const c = await connectGitHub(body, client, this.lifetime.signal);
      const newRef = c.auth.kind === "session" ? c.auth.sessionId : undefined;
      try {
        this.lifetime.signal.throwIfAborted();
        const previous = this.store.get<Connection>(
          "config",
          cacheKey({ connection: c.id }),
        );
        if (previous?.auth.kind === "session" && newRef) {
          validateConnection(previous);
          c.auth = { kind: "session", sessionId: previous.auth.sessionId };
        }
        this.store.put("config", cacheKey({ connection: c.id }), c);
        if (c.auth.kind === "session" && newRef) {
          replaceGitHubSession(newRef, c.auth.sessionId);
          this.githubSessions.add(c.auth.sessionId);
        }
        return ok({ connection: connectionView(c) }, 201);
      } catch {
        if (newRef) deleteGitHubSession(newRef);
        throw Error("Unable to save GitHub connection");
      }
    }
    if (p === "/api/connections") {
      if (method === "GET")
        return ok({
          connections: this.store
            .list<Connection>("config")
            .map((x) => x.value)
            .filter((c) => typeof c.webUrl === "string")
            .map(connectionView),
        });
      if (method === "POST") {
        const c = validateConnection(body);
        if (c.auth.kind === "session")
          throw Error("Use PAT connection onboarding");
        this.store.put("config", cacheKey({ connection: c.id }), c);
        return ok({ connection: this.connection(c.id) }, 201);
      }
      if (method === "DELETE") {
        const c = this.connection(body.id);
        if (c.auth.kind === "session") deleteGitHubSession(c.auth.sessionId);
        this.store.delete("config", cacheKey({ connection: body.id }));
        return ok({ deleted: true });
      }
    }
    if (p === "/api/engines/setup") {
      // A probe can revoke stale credentials too. Do not mutate their files
      // while an analysis owns its config, or start analysis during mutation.
      if (
        this.engineSetupBusy ||
        [...this.jobs.values()].some(
          ({ job }) => job.kind === "analysis" && !job.finishedAt,
        )
      )
        return ok({ error: "engine setup busy" }, 409);
      this.engineSetupBusy = true;
      try {
        if (url.search)
          throw Error("engine setup query parameters are not accepted");
        if (method === "GET") return ok(await this.engineSetup.status());
        if (method !== "POST") return ok({ error: "method" }, 405);
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw Error("engine setup object required");
        const keys = Object.keys(body);
        if (body.action === "rescan" && keys.length === 1)
          return ok(await this.engineSetup.rescan());
        if (
          body.action === "reuse-auth" &&
          keys.length === 3 &&
          keys.every((k) =>
            ["action", "providerId", "candidateId"].includes(k),
          ) &&
          body.providerId === "codex" &&
          typeof body.candidateId === "string" &&
          /^[a-zA-Z0-9-]{1,100}$/.test(body.candidateId)
        ) {
          return ok(
            await this.engineSetup.reuseLocalAuth(
              body.providerId,
              body.candidateId,
            ),
          );
        }
        if (
          ["set-session-auth", "forget-session-auth"].includes(body.action) &&
          keys.length === (body.action === "set-session-auth" ? 4 : 3) &&
          keys.every((k) =>
            (body.action === "set-session-auth"
              ? ["action", "providerId", "candidateId", "token"]
              : ["action", "providerId", "candidateId"]
            ).includes(k),
          ) &&
          body.providerId === "claude" &&
          typeof body.candidateId === "string" &&
          /^[a-zA-Z0-9-]{1,100}$/.test(body.candidateId) &&
          (body.action !== "set-session-auth" || typeof body.token === "string")
        ) {
          try {
            if (body.action === "set-session-auth") {
              if (!this.engineSetup.setSessionAuth) throw Error("unsupported");
              return ok(
                await this.engineSetup.setSessionAuth(
                  "claude",
                  body.candidateId,
                  body.token,
                ),
              );
            }
            if (!this.engineSetup.forgetSessionAuth) throw Error("unsupported");
            return ok(
              await this.engineSetup.forgetSessionAuth(
                "claude",
                body.candidateId,
              ),
            );
          } catch {
            return ok({ error: "engine session authentication failed" }, 400);
          } finally {
            delete body.token;
          }
        }
        throw Error("invalid engine setup request");
      } finally {
        this.engineSetupBusy = false;
      }
    }
    const jiraReply = await this.jira.handle(method, url, body);
    if (jiraReply) return jiraReply;
    const jiraSettings = () =>
      this.store.get<JiraSettings>("config", cacheKey({ settings: "jira" })) ||
      emptyJiraSettings;
    if (p.startsWith("/api/jira/candidates") || p === "/api/jira/capture") {
      const { snapshot: s } = this.snapshot(body.snapshotId),
        settings = jiraSettings(),
        key = cacheKey({ jiraCandidates: s.snapshotId, settings });
      const discovery = () =>
        this.store.get<ReturnType<typeof discoverForSnapshot>>(
          "selection",
          key,
        ) || discoverForSnapshot(s, settings);
      if (p === "/api/jira/candidates" && method === "POST") {
        const d = discovery();
        this.store.put("selection", key, d);
        return ok(d);
      }
      if (p === "/api/jira/candidates/edit" && method === "POST") {
        const d = editCandidates(discovery(), settings, body);
        this.store.put("selection", key, d);
        return ok(this.store.get("selection", key));
      }
      if (p === "/api/jira/capture" && method === "POST")
        return ok(
          this.start("snapshot", async (signal, event) => {
            event(
              "Read explicitly selected Jira candidates; no model transmission",
            );
            const snapshot = await this.jira.capture(s, settings, discovery(), {
              signal,
            });
            signal.throwIfAborted();
            this.store.put("snapshot", snapshot.snapshotId, {
              snapshot,
              stale: false,
            });
            return this.snapshot(snapshot.snapshotId);
          }),
          202,
        );
    }
    if (p === "/api/live/verify" && method === "POST")
      return ok({
        user: await client(this.connection(body.connectionId)).verify(),
      });
    if (p === "/api/live/list" && method === "POST")
      return ok(
        await client(this.connection(body.connectionId)).list(body.filters),
      );
    if (p === "/api/live/capabilities" && method === "GET")
      return ok({
        providers: await (this.options.probe || probeEngines)(),
        jira: {
          status: jiraSettings().connections.length
            ? "configured"
            : "unconnected",
          reason:
            "Jira Cloud / Data Center adapter ready; candidate fetch is explicit. No simulated tickets.",
        },
      });
    if (p === "/api/live/snapshots" && method === "GET")
      return ok({
        snapshots: this.store
          .list<{ snapshot: LiveSnapshot; stale: boolean }>("snapshot")
          .map(({ value }) => ({
            snapshotId: value.snapshot.snapshotId,
            pr: value.snapshot.pr,
            capturedAt: value.snapshot.capturedAt,
            stale: value.stale,
            coverage: value.snapshot.coverage,
          })),
      });
    if (p === "/api/live/snapshot" && method === "GET")
      return ok(this.snapshot(url.searchParams.get("id") || ""));
    if (p === "/api/live/snapshots" && method === "POST") {
      const c = this.connection(body.connectionId);
      if (typeof body.url !== "string") throw Error("PR URL required");
      return ok(
        this.start("snapshot", async (signal, event) => {
          const snapshot = await (this.options.ingest || ingestPull)(
            c,
            body.url,
            this.store.root,
            { signal, onProgress: event },
          );
          signal.throwIfAborted();
          for (const { key, value } of this.store.list<{
            snapshot: LiveSnapshot;
            stale: boolean;
          }>("snapshot"))
            if (
              value.snapshot.connectionId === snapshot.connectionId &&
              value.snapshot.repositoryId === snapshot.repositoryId &&
              value.snapshot.prNumber === snapshot.prNumber &&
              key !== snapshot.snapshotId
            )
              this.store.put("snapshot", key, { ...value, stale: true });
          this.store.put("snapshot", snapshot.snapshotId, {
            snapshot,
            stale: false,
          });
          return this.snapshot(snapshot.snapshotId);
        }),
        202,
      );
    }
    if (p === "/api/live/job" && method === "GET") {
      const item = this.jobs.get(url.searchParams.get("id") || "");
      if (!item) return ok({ error: "job expired or unknown" }, 404);
      return ok(item.job);
    }
    if (p === "/api/live/cancel" && method === "POST") {
      const item = this.jobs.get(body.id);
      if (!item) throw Error("job not found");
      item.controller.abort();
      return ok({ cancelRequested: true });
    }
    if (p === "/api/live/compare" && method === "POST") {
      const { snapshot: s } = this.snapshot(body.snapshotId),
        allowed = new Set([
          s.baseSha,
          s.headSha,
          ...s.mergeBaseShas,
          ...s.phases.flatMap((p) => [p.sha, ...p.parents]),
          s.baseline.sha,
        ]);
      if (!allowed.has(body.fromSha) || !allowed.has(body.toSha))
        throw Error("comparison outside pinned snapshot");
      return ok(
        await compareGit(
          bareCachePath(
            this.connection(s.connectionId),
            s.repositoryId,
            this.store.root,
          ),
          body.fromSha,
          body.toSha,
        ),
      );
    }
    if (p === "/api/live/plan" && method === "POST") {
      const { snapshot } = this.snapshot(body.snapshotId);
      return ok(
        transmissionPlan(snapshot, parseScope(body.scope), body.audit === true),
      );
    }
    if (p === "/api/live/run" && method === "POST") {
      if (this.engineSetupBusy) return ok({ error: "engine setup busy" }, 409);
      const fields = [
        "snapshotId",
        "providerId",
        "model",
        "scope",
        "consent",
        "audit",
        "auditConsent",
        "allowHistoricalSteps",
        "refresh",
      ];
      if (Object.keys(body).some((k) => !fields.includes(k)))
        throw Error(
          "unsupported analysis request field; server configuration cannot be supplied by browser",
        );
      for (const k of [
        "audit",
        "auditConsent",
        "allowHistoricalSteps",
        "refresh",
      ])
        if (body[k] !== undefined && typeof body[k] !== "boolean")
          throw Error("invalid analysis policy");
      if (body.audit === true && body.auditConsent !== true)
        throw Error(
          "explicit additional audit transmission/billing consent required",
        );
      if (
        !["codex", "claude"].includes(body.providerId) ||
        body.consent !== true
      )
        throw Error(
          "explicit real provider and model-transmission consent required",
        );
      if (
        typeof body.model !== "string" ||
        !/^[-a-zA-Z0-9_.:/]{1,120}$/.test(body.model)
      )
        throw Error("explicit model required");
      const { snapshot: s } = this.snapshot(body.snapshotId);
      const scope = parseScope(body.scope);
      const c = this.connection(s.connectionId);
      const policy = {
        audit: body.audit === true,
        allowHistoricalSteps: body.allowHistoricalSteps === true,
      };
      const key = analysisIdentity(
        s,
        c,
        scope,
        body.providerId,
        body.model,
        policy,
        this.options.versions,
      );
      const cached = this.store.get<SavedAnalysis>("analysis", key);
      if (cached && !body.refresh && cached.cacheExpiresAt > Date.now()) {
        try {
          this.validateSaved(cached, key);
          return ok({ cached: true, result: cached });
        } catch {
          this.store.delete("analysis", key);
        }
      }
      return ok(
        this.start("analysis", async (signal, event) => {
          event(
            "Only selected context is sent to the explicitly selected model provider",
          );
          const config = await this.engineSetup.resolveConfig(body.providerId);
          signal.throwIfAborted();
          const cache = localPipelineCache(
            this.store,
            c,
            body.refresh === true,
          );
          const guardedCache = {
            ...cache,
            set: (...args: Parameters<typeof cache.set>) => {
              signal.throwIfAborted();
              this.lifetime.signal.throwIfAborted();
              return cache.set(...args);
            },
          };
          const result = await (this.options.execute || executeAnalysis)(
            s,
            body.providerId,
            body.model,
            scope,
            signal,
            (e: any) =>
              event(
                [
                  "started",
                  "validated",
                  "cache_hit",
                  "cache_rejected",
                  "cache_unavailable",
                  "failed",
                  "completed",
                ].includes(e?.type)
                  ? `V3 ${e.stage || "pipeline"}: ${e.type}`
                  : "Provider progress event (no internal reasoning exposed)",
              ),
            {
              config,
              runner: this.options.runner,
              cache: guardedCache,
              audit: { enabled: policy.audit, failurePolicy: "downgrade" },
              allowHistoricalSteps: policy.allowHistoricalSteps,
              versions: this.options.versions,
            },
          );
          signal.throwIfAborted();
          validatePipelineResult(result, s, scope, policy);
          if (
            result.metadata.providerId !== body.providerId ||
            result.metadata.model !== body.model
          )
            throw Error("result provider/model mismatch");
          this.store.put("analysis", key, {
            ...result,
            scope,
            cacheKey: key,
            policy,
            cacheExpiresAt: Date.now() + 600000,
          });
          const saved = this.store.get<SavedAnalysis>("analysis", key)!;
          this.validateSaved(saved, key);
          return saved;
        }),
        202,
      );
    }
    if (p === "/api/live/analysis" && method === "GET") {
      const key = url.searchParams.get("key") || "";
      const result = this.store.get<SavedAnalysis>("analysis", key);
      if (result) this.validateSaved(result, key);
      return result
        ? ok({ result })
        : ok({ error: "analysis expired or missing" }, 404);
    }
    if (p === "/api/live/cache" && method === "DELETE") {
      if (body.confirm !== "delete-local-cache")
        throw Error("explicit cache deletion confirmation required");
      if (
        [...this.jobs.values()].some((x) =>
          ["running", "queued"].includes(x.job.status),
        )
      )
        throw Error("cancel active job before cache deletion");
      for (const b of [
        "snapshot",
        "analysis",
        "chunk",
        "jira",
        "selection",
      ] as const)
        this.store.clear(b);
      const git = path.join(this.store.root, "git");
      if (existsSync(git)) {
        if (lstatSync(git).isSymbolicLink()) throw Error("unsafe Git cache");
        for (const name of readdirSync(git)) {
          const dir = path.join(git, name);
          if (
            /^[a-f0-9]{64}$/.test(name) &&
            !lstatSync(dir).isSymbolicLink() &&
            existsSync(path.join(dir, "prce-owned"))
          )
            rmSync(dir, { recursive: true });
        }
      }
      this.jobs.clear();
      return ok({ deleted: true, connectionsPreserved: true });
    }
    return null;
  }
}
