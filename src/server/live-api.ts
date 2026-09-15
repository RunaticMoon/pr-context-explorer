import {
  validateJiraSettings,
  emptyJiraSettings,
  discoverForSnapshot,
  editCandidates,
  captureForSnapshot,
  type JiraSettings,
} from "./source-bridge.ts";
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
  ingest?: typeof ingestPull;
  execute?: typeof executeAnalysis;
  /** Trusted test/server injection only; never accepted from HTTP JSON. */
  runner?: PipelineRunner;
  versions?: PipelineOptions["versions"];
  probe?: typeof probeEngines;
  client?: (c: Connection) => GitHubClient;
};
export class LiveAPI {
  readonly store: LocalStore;
  readonly jobs = new Map<string, { job: Job; controller: AbortController }>();
  constructor(private options: LiveAPIOptions = {}) {
    this.store = new LocalStore(
      options.dataDir ||
        process.env.PRCE_DATA_DIR ||
        path.join(homedir(), ".local/share/pr-context-explorer"),
    );
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
    for (const { controller } of this.jobs.values()) controller.abort();
  }
  async handle(
    method: string,
    url: URL,
    body: any,
  ): Promise<{ status: number; data: unknown } | null> {
    const p = url.pathname,
      ok = (data: unknown, status = 200) => ({ status, data }),
      client = (c: Connection) =>
        this.options.client?.(c) || new GitHubClient(c);
    if (p === "/api/connections") {
      if (method === "GET")
        return ok({
          connections: this.store
            .list<Connection>("config")
            .map((x) => x.value)
            .filter((c) => typeof c.webUrl === "string"),
        });
      if (method === "POST") {
        const c = validateConnection(body);
        this.store.put("config", cacheKey({ connection: c.id }), c);
        return ok({ connection: this.connection(c.id) }, 201);
      }
      if (method === "DELETE") {
        this.connection(body.id);
        this.store.delete("config", cacheKey({ connection: body.id }));
        return ok({ deleted: true });
      }
    }
    const jiraSettings = () =>
      this.store.get<JiraSettings>("config", cacheKey({ settings: "jira" })) ||
      emptyJiraSettings;
    if (p === "/api/jira/settings") {
      if (method === "GET") return ok(jiraSettings());
      if (method === "POST") {
        const settings = validateJiraSettings(body);
        this.store.put("config", cacheKey({ settings: "jira" }), settings);
        return ok(jiraSettings(), 201);
      }
    }
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
            const snapshot = await captureForSnapshot(
              s,
              settings,
              discovery(),
              { signal },
            );
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
              runner: this.options.runner,
              cache: localPipelineCache(this.store, c, body.refresh === true),
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
