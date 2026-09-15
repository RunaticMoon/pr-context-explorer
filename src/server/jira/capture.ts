import { createHash } from "node:crypto";
import { candidateId } from "./discovery.ts";
import {
  approvedBaseUrl,
  JiraConfigurationError,
  isIssueKey,
} from "./config.ts";
import type { JiraCandidate } from "./discovery.ts";
import type {
  JiraCaptureOptions,
  JiraCaptureResult,
  JiraReadAdapter,
  JiraFailureState,
} from "./types.ts";
export interface JiraBatchCapture {
  state: "no_data" | "captured" | "partial" | JiraFailureState;
  canAnalyzeWithoutJira: true;
  items: { candidate: JiraCandidate; result: JiraCaptureResult }[];
  excludedCandidateIds: string[];
  omittedCandidateIds: string[];
  captureHash: string;
}
/** No AI invocation or requirement verification occurs here; failures are context coverage, not PR-analysis blockers. */
export async function captureJiraCandidates(
  candidates: readonly JiraCandidate[],
  adapters: readonly JiraReadAdapter[],
  options: JiraCaptureOptions & { maxCandidates?: number } = {},
): Promise<JiraBatchCapture> {
  const max = options.maxCandidates ?? 20;
  if (
    !Number.isSafeInteger(max) ||
    max < 1 ||
    max > 50 ||
    candidates.length > 10_000
  )
    throw new JiraConfigurationError("Invalid Jira batch limit");
  if (new Set(adapters.map((a) => a.site.id)).size !== adapters.length)
    throw new JiraConfigurationError("Duplicate registered adapter");
  const frozenCandidates = structuredClone(candidates) as JiraCandidate[];
  const active = frozenCandidates.filter((c) => !c.excluded);
  const items: JiraBatchCapture["items"] = [];
  for (const candidate of active.slice(0, max)) {
    let result: JiraCaptureResult;
    const adapter = adapters.find((a) => a.site.id === candidate.connectionId);
    if (
      !isIssueKey(candidate.key, "[A-Z][A-Z0-9_]{0,31}") ||
      candidate.id !== candidateId(candidate.host, candidate.key)
    )
      result = {
        state: "communication_error",
        reason: "invalid_candidate_identity",
      };
    else if (!adapter)
      result = { state: "unconnected", reason: "connection_unavailable" };
    else {
      try {
        if (candidate.host !== approvedBaseUrl(adapter.site.webBaseUrl))
          result = {
            state: "communication_error",
            reason: "invalid_candidate_identity",
          };
        else result = await adapter.capture(candidate.key, options);
      } catch {
        result = { state: "communication_error", reason: "adapter_error" };
      }
    }
    items.push({ candidate, result });
  }
  const states = new Set(items.map((i) => i.result.state));
  const omittedCandidateIds = active.slice(max).map((c) => c.id);
  const excludedCandidateIds = frozenCandidates
    .filter((c) => c.excluded)
    .map((c) => c.id);
  const state: JiraBatchCapture["state"] = !active.length
    ? "no_data"
    : omittedCandidateIds.length || states.size > 1
      ? "partial"
      : items[0].result.state;
  const captureHash = createHash("sha256")
    .update(
      JSON.stringify({
        state,
        excludedCandidateIds,
        omittedCandidateIds,
        items: items.map((i) => ({
          candidate: i.candidate,
          result:
            i.result.state === "captured"
              ? { state: "captured", hash: i.result.snapshot.captureHash }
              : i.result,
        })),
      }),
    )
    .digest("hex");
  return {
    state,
    canAnalyzeWithoutJira: true,
    items,
    excludedCandidateIds,
    omittedCandidateIds,
    captureHash,
  };
}
