import {
  emptyJiraSettings,
  discoverForSnapshot,
  editCandidates,
  SourceBridge,
  type JiraSettings,
} from "./source-bridge.ts";
import { createEngineSetupService } from "./engine-setup.ts";
import { HttpEngineSetup } from "./http-engine-setup.ts";
import {
  createHttpVerifier,
  handleHttpEngineAction,
  isHttpEngineAction,
} from "./http-engine-routes.ts";
import { AnalysisConsentStore, type PlanBinding } from "./analysis-consent.ts";
import type { HttpEngineView } from "../ai-contract.ts";
import { readServerSettings } from "./settings.ts";
import path from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { rmSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { LocalStore, cacheKey } from "./store.ts";
import {
  analysisIdentity,
  createPlanBudget,
  localPipelineCache,
  parseScope,
  transmissionPlan,
  validatePipelineResult,
  type PlanEngine,
  type SavedAnalysis,
} from "./live-pipeline.ts";
import {
  PipelineError,
  type PipelineOptions,
  type PipelineRunner,
  type PipelineCoverage,
  type SemanticAudit,
} from "./analysis-v3/index.ts";
import { AIError, type AIErrorCode } from "./ai/errors.ts";
import type { HttpRuntimeConfig } from "./ai/types.ts";
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
  /**
   * Safe public failure cause: a fixed AIError code (or "unknown") and its
   * static description. Never provider text, model output, paths or stderr.
   */
  errorCause?: { code: string; message: string | null; count?: number };
  /** Failed-chunk count per safe cause code, e.g. {tool_use_forbidden: 17}. */
  errorCodes?: Record<string, number>;
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
  /** Trusted server/test seam, never browser configuration. */
  httpSetup?: HttpEngineSetup;
  /** Trusted server/test seam, never browser configuration. */
  consentStore?: AnalysisConsentStore;
  ingest?: typeof ingestPull;
  execute?: typeof executeAnalysis;
  /** Trusted test/server injection only; never accepted from HTTP JSON. */
  runner?: PipelineRunner;
  versions?: PipelineOptions["versions"];
  probe?: typeof probeEngines;
  client?: (c: Connection) => GitHubClient;
};
export class LiveAPI {
  private admissionClosed = false;
  private pendingMutations = 0;
  desktopActive() {
    return (
      this.pendingMutations > 0 ||
      this.engineSetupBusy ||
      [...this.jobs.values()].some(({ job }) =>
        ["queued", "running"].includes(job.status),
      )
    );
  }
  lockDesktopAdmission() {
    if (this.desktopActive()) return false;
    this.admissionClosed = true;
    return true;
  }
  unlockDesktopAdmission() {
    this.admissionClosed = false;
  }
  private engineSetupBusy = false;
  private githubSessions = new Set<string>();
  private readonly lifetime = new AbortController();
  readonly store: LocalStore;
  readonly jira: SourceBridge;
  readonly engineSetup: NonNullable<LiveAPIOptions["engineSetup"]>;
  readonly httpSetup: HttpEngineSetup;
  readonly consent: AnalysisConsentStore;
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
    this.httpSetup =
      options.httpSetup ??
      new HttpEngineSetup({ verifier: createHttpVerifier() });
    this.consent = options.consentStore ?? new AnalysisConsentStore();
    this.httpSetup.onInvalidate((id) => this.consent.invalidate(id));
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
  /**
   * Engine descriptor + plan/binding shared by /api/live/plan and
   * /api/live/run so a planId always covers the exact recomputed request
   * shape. Carries public engine identity only; the credential closure never
   * leaves HttpEngineSetup.resolve().
   */
  private httpPlan(
    snapshot: LiveSnapshot,
    scope: Scope,
    audit: boolean,
    historical: boolean,
    view: HttpEngineView,
  ) {
    const engine: PlanEngine = {
      transport: "http",
      providerId: "openai-compatible",
      model: view.model,
      host: view.host,
      configId: view.configId,
      revision: view.revision,
    };
    const plan = transmissionPlan(snapshot, scope, audit, engine);
    const binding: PlanBinding = {
      snapshotId: snapshot.snapshotId,
      scopeKey: cacheKey(scope),
      providerId: engine.providerId,
      model: engine.model,
      configId: view.configId,
      revision: view.revision,
      audit,
      historical,
      maxProviderCalls: plan.maxProviderCalls,
      ...(plan.maxOutputTokensPerCall !== undefined
        ? { maxOutputTokensPerCall: plan.maxOutputTokensPerCall }
        : {}),
      ...(plan.totalOutputTokenReservation !== undefined
        ? { totalOutputTokenReservation: plan.totalOutputTokenReservation }
        : {}),
    };
    return { engine, plan, binding };
  }
  /**
   * Reconstructs the public engine identity a saved HTTP analysis carries,
   * so stored results stay readable without the key or runtime. Runs record
   * the trusted projection at top level (`metadata.engine`); a result whose
   * plan executed zero stages (e.g. no transmittable context) has no stage
   * metadata (HttpAnalysisMetadata) to recover it from. When stage metadata
   * is present every stage must agree with the same projection — including
   * the top-level one — and a result without either cannot be re-keyed and
   * is rejected closed.
   */
  private savedHttpEngine(r: SavedAnalysis): PlanEngine {
    const projections = new Map<string, PlanEngine>();
    const project = (m: {
      transport?: unknown;
      providerId?: unknown;
      model?: unknown;
      host?: unknown;
      configId?: unknown;
      revision?: unknown;
    }) => {
      if (
        typeof r.metadata?.model !== "string" ||
        m.transport !== "http" ||
        m.providerId !== "openai-compatible" ||
        typeof m.model !== "string" ||
        m.model !== r.metadata.model ||
        typeof m.host !== "string" ||
        typeof m.configId !== "string" ||
        !Number.isSafeInteger(m.revision)
      )
        throw Error("cached identity mismatch");
      projections.set(
        cacheKey({ host: m.host, configId: m.configId, revision: m.revision }),
        {
          transport: "http",
          providerId: "openai-compatible",
          model: r.metadata.model,
          host: m.host,
          configId: m.configId,
          revision: m.revision as number,
        },
      );
    };
    // Runs saved before the top-level projection existed carry only stage
    // metadata; both sources feed the same single-projection requirement.
    if (r.metadata?.engine != null) project(r.metadata.engine);
    const stages = Array.isArray(r.metadata?.stages) ? r.metadata.stages : [];
    for (const stage of stages) {
      const m = stage?.metadata;
      if (!m) continue;
      project(m);
    }
    if (projections.size !== 1) throw Error("cached identity mismatch");
    return projections.values().next().value!;
  }
  private validateSaved(r: SavedAnalysis, key: string) {
    const { snapshot: s } = this.snapshot(r.output?.snapshotId);
    const scope = parseScope(r.scope);
    const engine =
      r.metadata?.providerId === "openai-compatible"
        ? this.savedHttpEngine(r)
        : undefined;
    if (
      !r.policy ||
      typeof r.policy.audit !== "boolean" ||
      typeof r.policy.allowHistoricalSteps !== "boolean" ||
      r.cacheKey !== key ||
      !["codex", "claude", "openai-compatible"].includes(r.metadata.providerId)
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
        engine,
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
    if (this.admissionClosed) throw Error("Desktop update admission closed");
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
        if (job.status === "failed") {
          if (
            e instanceof PipelineError &&
            e.chunkFailureCodes &&
            Object.keys(e.chunkFailureCodes).length
          ) {
            job.errorCodes = e.chunkFailureCodes;
            const [code, count] = Object.entries(e.chunkFailureCodes).sort(
              (a, b) => b[1] - a[1],
            )[0];
            job.errorCause = {
              code,
              count,
              message: this.safeCauseMessage(code),
            };
          } else {
            const code =
              e instanceof AIError
                ? e.code
                : e instanceof PipelineError
                  ? (
                      e.stages.filter((x) => x.status === "failed").at(-1) as
                        { errorCode?: string } | undefined
                    )?.errorCode
                  : undefined;
            if (code)
              job.errorCause = {
                code,
                message: this.safeCauseMessage(code),
              };
          }
        }
        job.error = controller.signal.aborted ? "cancelled" : this.safeError(e);
        event(job.error!);
        if (job.errorCause)
          event(
            `실패 원인 코드: ${job.errorCause.code}` +
              (job.errorCodes ? ` ${JSON.stringify(job.errorCodes)}` : ""),
          );
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
  /** Fixed public description for an AIError code; null for other strings. */
  private safeCauseMessage(code: string): string | null {
    return new AIError(code as AIErrorCode).message || null;
  }
  close() {
    this.lifetime.abort();
    this.jira.close();
    this.engineSetup.close?.();
    this.httpSetup.close();
    for (const ref of this.githubSessions) deleteGitHubSession(ref);
    this.githubSessions.clear();
    for (const { controller } of this.jobs.values()) controller.abort();
  }
  async handle(
    method: string,
    url: URL,
    body: any,
  ): Promise<{ status: number; data: unknown } | null> {
    const mutating = method !== "GET";
    if (mutating && this.admissionClosed)
      return {
        status: 503,
        data: { error: "Desktop update admission closed" },
      };
    if (mutating) this.pendingMutations++;
    try {
      return await this.handleRequest(method, url, body);
    } finally {
      if (mutating) this.pendingMutations--;
    }
  }
  private async handleRequest(
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
        if (method === "GET")
          return ok({
            ...(await this.engineSetup.status()),
            http: this.httpSetup.view(),
          });
        if (method !== "POST") return ok({ error: "method" }, 405);
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw Error("engine setup object required");
        if (isHttpEngineAction(body)) {
          // Runs inside the engineSetupBusy lock so a connection check can
          // never overlap an active analysis job or another mutation.
          try {
            const result = await handleHttpEngineAction(
              this.httpSetup,
              body,
              this.lifetime.signal,
            );
            return ok(result.body, result.status);
          } finally {
            delete body.apiKey;
          }
        }
        const keys = Object.keys(body);
        if (body.action === "rescan" && keys.length === 1)
          return ok({
            ...(await this.engineSetup.rescan()),
            http: this.httpSetup.view(),
          });
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
          return ok({
            ...(await this.engineSetup.reuseLocalAuth(
              body.providerId,
              body.candidateId,
            )),
            http: this.httpSetup.view(),
          });
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
              return ok({
                ...(await this.engineSetup.setSessionAuth(
                  "claude",
                  body.candidateId,
                  body.token,
                )),
                http: this.httpSetup.view(),
              });
            }
            if (!this.engineSetup.forgetSessionAuth) throw Error("unsupported");
            return ok({
              ...(await this.engineSetup.forgetSessionAuth(
                "claude",
                body.candidateId,
              )),
              http: this.httpSetup.view(),
            });
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
      const fields = [
        "snapshotId",
        "scope",
        "audit",
        "providerId",
        "model",
        "allowHistoricalSteps",
      ];
      if (Object.keys(body).some((k) => !fields.includes(k)))
        throw Error(
          "unsupported analysis request field; server configuration cannot be supplied by browser",
        );
      const { snapshot } = this.snapshot(body.snapshotId);
      const scope = parseScope(body.scope);
      if (body.providerId === "openai-compatible") {
        const view = this.httpSetup.view();
        if (!view || !view.ready)
          return ok(
            {
              error: "http engine not ready",
              code: view?.blockers[0] ?? "auth_required",
            },
            409,
          );
        if (body.model !== undefined && body.model !== view.model)
          throw Error("explicit model required");
        const { plan, binding } = this.httpPlan(
          snapshot,
          scope,
          body.audit === true,
          body.allowHistoricalSteps === true,
          view,
        );
        return ok({ ...plan, planId: this.consent.issuePlan(binding) });
      }
      // CLI providers keep the legacy, planId-free response.
      return ok(transmissionPlan(snapshot, scope, body.audit === true));
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
        "planId",
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
        !["codex", "claude", "openai-compatible"].includes(body.providerId) ||
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
      // A planId is meaningful only to the HTTP engine; CLI runs ignore it.
      if (
        body.providerId === "openai-compatible" &&
        typeof body.planId !== "string"
      )
        throw Error("analysis plan required");
      const { snapshot: s } = this.snapshot(body.snapshotId);
      const scope = parseScope(body.scope);
      const c = this.connection(s.connectionId);
      const policy = {
        audit: body.audit === true,
        allowHistoricalSteps: body.allowHistoricalSteps === true,
      };
      let http:
        | {
            engine: PlanEngine;
            runtime: HttpRuntimeConfig;
            budget: ReturnType<typeof createPlanBudget>;
          }
        | undefined;
      if (body.providerId === "openai-compatible") {
        const view = this.httpSetup.view();
        if (!view || !view.ready)
          return ok(
            {
              error: "http engine not ready",
              code: view?.blockers[0] ?? "auth_required",
            },
            409,
          );
        if (body.model !== view.model) throw Error("explicit model required");
        // A busy rejection must not consume the one-shot plan.
        if (
          [...this.jobs.values()].some((x) =>
            ["running", "queued"].includes(x.job.status),
          )
        )
          throw Error("busy: one local collection/model job at a time");
        // Recompute the exact shape the planId was issued for, then consume
        // it. Only fixed phrases and AIError codes leave this block.
        const { engine, plan, binding } = this.httpPlan(
          s,
          scope,
          policy.audit,
          policy.allowHistoricalSteps,
          view,
        );
        try {
          this.consent.validatePlan(body.planId, binding);
        } catch (e) {
          if (e instanceof AIError)
            return ok({ error: "analysis plan required", code: e.code }, 409);
          throw e;
        }
        let runtime: HttpRuntimeConfig;
        try {
          runtime = this.httpSetup.resolve();
        } catch (e) {
          if (e instanceof AIError)
            return ok({ error: "http engine not ready", code: e.code }, 409);
          throw e;
        }
        http = { engine, runtime, budget: createPlanBudget(plan) };
      }
      const key = analysisIdentity(
        s,
        c,
        scope,
        body.providerId,
        body.model,
        policy,
        this.options.versions,
        http?.engine,
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
          // The HTTP engine binds the pre-resolved runtime/budget; the CLI
          // config resolver is never invoked for it.
          const config = http
            ? undefined
            : await this.engineSetup.resolveConfig(body.providerId);
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
                  ? `V3 ${e.stage || "pipeline"}: ${e.type}` +
                      (e?.type === "failed" &&
                      /^[a-z_]{1,40}$/.test(e?.event?.code)
                        ? ` · ${e.event.code}`
                        : "")
                  : "Provider progress event (no internal reasoning exposed)",
              ),
            {
              ...(http
                ? { http: { runtime: http.runtime, budget: http.budget } }
                : { config }),
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
