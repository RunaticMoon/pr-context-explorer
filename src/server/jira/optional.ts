import { createHash } from "node:crypto";
import { isIssueKey } from "./config.ts";
import { jsonObject, normalizeJiraDocument } from "./normalize.ts";
import { JiraReadError, JiraReadSession, readFailure } from "./session.ts";
import type {
  JiraCaptureOptions,
  JiraCaptureResult,
  JiraConnection,
  JiraCoverage,
  JiraIssueSnapshot,
} from "./types.ts";

export function validCaptureOptions(options: JiraCaptureOptions): boolean {
  const bounded = (x: number, max: number) =>
    Number.isSafeInteger(x) && x >= 1 && x <= max;
  return (
    (!options.comments ||
      (bounded(options.comments.maxComments, 100) &&
        bounded(options.comments.maxPages ?? 3, 5))) &&
    (!options.related || bounded(options.related.maxIssues, 10)) &&
    (options.parent === undefined || typeof options.parent === "boolean")
  );
}
export function updateCaptureHash(
  snapshot: JiraIssueSnapshot,
  options: JiraCaptureOptions,
): void {
  const resultHash = (result: JiraCaptureResult) =>
    result.state === "captured"
      ? { state: result.state, captureHash: result.snapshot.captureHash }
      : result;
  const material = {
    identity: snapshot.identity,
    normalizerVersion: snapshot.normalizerVersion,
    sourceHash: snapshot.sourceHash,
    fields: snapshot.acceptanceCriteria.map((f) => ({
      id: f.fieldId,
      label: f.label,
    })),
    scope: {
      comments: options.comments
        ? {
            maxComments: options.comments.maxComments,
            maxPages: options.comments.maxPages ?? 3,
          }
        : null,
      parent: options.parent ?? false,
      related: options.related ?? null,
    },
    comments: snapshot.commentPages.map((p) => p.sourceHash),
    coverage: snapshot.coverage,
    parent: snapshot.parent ? resultHash(snapshot.parent.result) : null,
    related: snapshot.related.map((r) => ({
      issueId: r.issueId,
      result: resultHash(r.result),
    })),
  };
  snapshot.captureHash = createHash("sha256")
    .update(JSON.stringify(material))
    .digest("hex");
}
export async function collectOptional(
  snapshot: JiraIssueSnapshot,
  options: JiraCaptureOptions,
  config: JiraConnection,
  session: JiraReadSession,
  readIssue: (id: string) => Promise<JiraIssueSnapshot>,
): Promise<void> {
  const f = snapshot.source.raw.fields;
  if (!jsonObject(f)) return;
  const getRelated = async (id: string): Promise<JiraCaptureResult> => {
    try {
      return { state: "captured", snapshot: await readIssue(id) };
    } catch (error) {
      return readFailure(error);
    }
  };
  if (options.parent) {
    const parent = f.parent;
    if (parent === null)
      snapshot.coverage.parent = { state: "complete", retrieved: 0, total: 0 };
    else if (
      !jsonObject(parent) ||
      typeof parent.id !== "string" ||
      !/^[1-9][0-9]{0,19}$/.test(parent.id) ||
      typeof parent.key !== "string" ||
      !isIssueKey(parent.key, config.projectKeyPattern)
    )
      snapshot.coverage.parent = {
        state: "unavailable",
        retrieved: 0,
        total: null,
        reason: "parent_missing_or_invalid",
      };
    else {
      const result = await getRelated(parent.id);
      snapshot.parent = { pointer: "/fields/parent", result };
      snapshot.coverage.parent =
        result.state === "captured"
          ? { state: "complete", retrieved: 1, total: 1 }
          : {
              state: "unavailable",
              retrieved: 0,
              total: 1,
              reason: result.state,
            };
    }
  }
  if (options.related) {
    if (!Array.isArray(f.issuelinks))
      snapshot.coverage.related = {
        state: "unavailable",
        retrieved: 0,
        total: null,
        reason: "related_field_missing",
      };
    else {
      const refs = new Map<
        string,
        Omit<JiraIssueSnapshot["related"][number], "result">
      >();
      let invalid = false;
      f.issuelinks.forEach((link, i) => {
        if (!jsonObject(link)) {
          invalid = true;
          return;
        }
        let found = false;
        for (const direction of ["inward", "outward"] as const) {
          const field = `${direction}Issue`,
            ref = link[field];
          if (ref === undefined) continue;
          found = true;
          if (
            !jsonObject(ref) ||
            typeof ref.id !== "string" ||
            !/^[1-9][0-9]{0,19}$/.test(ref.id) ||
            typeof ref.key !== "string" ||
            !isIssueKey(ref.key, config.projectKeyPattern)
          ) {
            invalid = true;
            continue;
          }
          const item = refs.get(ref.id) ?? {
            issueId: ref.id,
            issueKey: ref.key,
            references: [],
          };
          item.references.push({
            pointer: `/fields/issuelinks/${i}/${field}`,
            direction,
            linkType:
              jsonObject(link.type) && typeof link.type.name === "string"
                ? link.type.name
                : null,
          });
          refs.set(ref.id, item);
        }
        if (!found) invalid = true;
      });
      for (const ref of [...refs.values()].slice(0, options.related.maxIssues))
        snapshot.related.push({
          ...ref,
          result: await getRelated(ref.issueId),
        });
      const retrieved = snapshot.related.filter(
        (r) => r.result.state === "captured",
      ).length;
      const complete = !invalid && retrieved === refs.size;
      snapshot.coverage.related = {
        state: complete ? "complete" : retrieved ? "partial" : "unavailable",
        retrieved,
        total: invalid ? null : refs.size,
        ...(complete
          ? {}
          : {
              reason: invalid
                ? "invalid_related_reference"
                : snapshot.related.length < refs.size
                  ? "issue_limit"
                  : "related_unavailable",
            }),
      };
    }
  }
  if (options.comments) {
    let startAt = 0,
      total: number | null = null;
    const seen = new Set<string>();
    const coverage: JiraCoverage = {
      state: "partial",
      retrieved: 0,
      total: null,
      reason: "page_or_comment_limit",
    };
    snapshot.coverage.comments = coverage;
    try {
      for (
        let page = 0;
        page < (options.comments.maxPages ?? 3) &&
        snapshot.comments.length < options.comments.maxComments;
        page++
      ) {
        const remaining =
          options.comments.maxComments - snapshot.comments.length;
        const url = new URL(
          `${config.apiBaseUrl}/rest/api/${config.deployment === "cloud" ? "3" : "2"}/issue/${snapshot.identity.issueId}/comment`,
        );
        url.searchParams.set("startAt", String(startAt));
        url.searchParams.set("maxResults", String(remaining));
        url.searchParams.set("orderBy", "created");
        const source = await session.get(url),
          raw = source.raw;
        const comments = raw.comments;
        if (
          !Array.isArray(comments) ||
          raw.startAt !== startAt ||
          typeof raw.total !== "number" ||
          !Number.isSafeInteger(raw.total) ||
          raw.total < startAt + comments.length ||
          comments.length > remaining ||
          (total !== null && total !== raw.total)
        )
          throw new JiraReadError(
            "communication_error",
            "invalid_or_changed_pagination",
          );
        total = raw.total;
        coverage.total = total;
        // Validate the entire page before appending; no phantom partial page counts.
        const pageSeen = new Set<string>();
        for (const comment of comments) {
          if (
            !jsonObject(comment) ||
            typeof comment.id !== "string" ||
            !/^[1-9][0-9]{0,19}$/.test(comment.id) ||
            seen.has(comment.id) ||
            pageSeen.has(comment.id)
          )
            throw new JiraReadError(
              "communication_error",
              "invalid_comment_page",
            );
          pageSeen.add(comment.id);
        }
        const pageIndex = snapshot.commentPages.length;
        snapshot.commentPages.push(source);
        comments.forEach((comment, i) => {
          if (!jsonObject(comment)) return;
          const id = String(comment.id);
          seen.add(id);
          snapshot.comments.push({
            id,
            raw: structuredClone(comment),
            body: normalizeJiraDocument(comment.body, `/comments/${i}/body`),
            updatedAt:
              typeof comment.updated === "string" ? comment.updated : null,
            sourceHash: source.sourceHash,
            pageIndex,
          });
        });
        startAt += comments.length;
        coverage.retrieved = snapshot.comments.length;
        if (startAt === total) {
          coverage.state = "complete";
          delete coverage.reason;
          break;
        }
        if (!comments.length)
          throw new JiraReadError("communication_error", "pagination_stalled");
      }
    } catch (error) {
      coverage.state = coverage.retrieved ? "partial" : "unavailable";
      const failure = readFailure(error);
      coverage.reason =
        failure.state === "unknown_or_forbidden"
          ? failure.state
          : failure.reason;
    }
  }
}
