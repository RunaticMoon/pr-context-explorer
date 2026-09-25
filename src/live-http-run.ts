// Pure helpers wiring the "openai-compatible" HTTP engine into the live
// analysis flow (src/live.tsx): request-body construction and one-shot
// transmission-plan (planId) reuse checks. No React, no fetch, and no
// credential material — an HttpEngineView only carries public fields.
import type { HttpEngineView, ProviderId } from "./ai-contract.ts";
import type { Scope } from "./server/live-analysis.ts";

/** Public identity of the HTTP engine a plan/run is bound to. A config edit
 * bumps revision, so (configId, revision, model) pin the exact engine. */
export type HttpEngineKey = {
  configId: string;
  revision: number;
  model: string;
};

export function httpEngineKey(
  view: HttpEngineView | null | undefined,
): HttpEngineKey | undefined {
  if (!view) return undefined;
  return {
    configId: view.configId,
    revision: view.revision,
    model: view.model,
  };
}

/** The exact transmission parameters a plan was requested for; a stored
 * planId stays usable only while every field still matches. */
export type LivePlanContext = {
  snapshotId: string;
  scope: Scope;
  audit: boolean;
  allowHistoricalSteps: boolean;
  providerId: ProviderId;
  /** Model the run will send: the saved engine model for HTTP, the manual
   * input for local CLI providers. */
  model: string;
  /** Present for the HTTP transport only. */
  engine?: HttpEngineKey;
};

export function sameScope(a: Scope, b: Scope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "pr") return true;
  const x = a as Extract<Scope, { kind: "code" }>,
    y = b as Extract<Scope, { kind: "code" }>;
  return (
    x.commitSha === y.commitSha &&
    x.fileId === y.fileId &&
    x.side === y.side &&
    x.lineStart === y.lineStart &&
    x.lineEnd === y.lineEnd &&
    x.question === y.question
  );
}

function sameEngineKey(
  a: HttpEngineKey | undefined,
  b: HttpEngineKey | undefined,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.configId === b.configId &&
    a.revision === b.revision &&
    a.model === b.model
  );
}

export function samePlanContext(
  a: LivePlanContext,
  b: LivePlanContext,
): boolean {
  return (
    a.snapshotId === b.snapshotId &&
    a.providerId === b.providerId &&
    a.model === b.model &&
    a.audit === b.audit &&
    a.allowHistoricalSteps === b.allowHistoricalSteps &&
    sameScope(a.scope, b.scope) &&
    sameEngineKey(a.engine, b.engine)
  );
}

/** POST /api/live/plan body. The HTTP plan is issued a one-shot planId bound
 * to provider, model and the history policy, so those ride along; the CLI
 * body keeps its original field set. */
export function buildPlanBody(
  context: LivePlanContext,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    snapshotId: context.snapshotId,
    scope: context.scope,
    audit: context.audit,
  };
  if (context.providerId === "openai-compatible") {
    body.providerId = context.providerId;
    body.model = context.model;
    body.allowHistoricalSteps = context.allowHistoricalSteps;
  }
  return body;
}

export type LiveRunFields = {
  snapshotId: string;
  providerId: ProviderId;
  model: string;
  scope: Scope;
  consent: boolean;
  audit: boolean;
  auditConsent: boolean;
  allowHistoricalSteps: boolean;
  refresh: boolean;
};

/** POST /api/live/run body: the existing CLI field set, plus a one-shot
 * planId when an HTTP plan authorized this exact run. */
export function buildRunBody(
  fields: LiveRunFields,
  planId?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    snapshotId: fields.snapshotId,
    providerId: fields.providerId,
    model: fields.model,
    scope: fields.scope,
    consent: fields.consent,
    audit: fields.audit,
    auditConsent: fields.auditConsent,
    allowHistoricalSteps: fields.allowHistoricalSteps,
    refresh: fields.refresh,
  };
  if (planId) body.planId = planId;
  return body;
}

/** A stored /api/live/plan response plus the parameters it was issued for.
 * The response shape is server-owned: HTTP plans add a planId and the public
 * engine descriptor that CLI responses never carry. */
export type StoredLivePlan = {
  response: any;
  context: LivePlanContext;
};

/** The one-shot planId of a stored plan, and only while it still covers the
 * current transmission parameters (snapshot, scope, audit, history policy,
 * provider/model and the HTTP engine identity). */
export function usablePlanId(
  plan: StoredLivePlan | undefined,
  current: LivePlanContext,
): string | undefined {
  const planId = plan?.response?.planId;
  if (typeof planId !== "string" || planId === "") return undefined;
  return samePlanContext(plan!.context, current) ? planId : undefined;
}

/** Marks a stored plan as consumed: the plan display stays, but its one-shot
 * planId is dropped so it can never authorize a second run. */
export function dropPlanId(plan: StoredLivePlan): StoredLivePlan {
  if (typeof plan.response?.planId !== "string") return plan;
  const { planId: _consumed, ...response } = plan.response;
  return { ...plan, response };
}
