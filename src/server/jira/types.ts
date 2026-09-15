import type { JiraSite } from "./discovery.ts";
import type { JsonValue, JiraDocument } from "./normalize.ts";
export type JiraCredential =
  | {
      kind: "callback";
      resolve: (context: {
        connectionId: string;
        apiOrigin: string;
        signal: AbortSignal;
      }) =>
        Record<string, string> | null | Promise<Record<string, string> | null>;
    }
  | { kind: "env"; variable: string; scheme: "Bearer" | "Basic" };
/** Server-owned configuration. Never accept this structure from PR/Jira source or expose credentials to UI. */
export interface JiraConnection extends JiraSite {
  accountContextId: string;
  credential?: JiraCredential;
  acceptanceCriteriaFields?: readonly { id: string; label?: string }[];
  projectKeyPattern?: string;
  customCaPem?: string;
  limits?: {
    timeoutMs?: number;
    maxResponseBytes?: number;
    maxTotalBytes?: number;
  };
}
export interface JiraTransportRequest {
  url: string;
  method: "GET";
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
  customCaPem?: string;
}
export interface JiraTransportResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: AsyncIterable<Uint8Array>;
}
/** Trusted dependency injection for tests/server transports, not a browser-configurable override. */
export type JiraTransport = (
  request: JiraTransportRequest,
) => Promise<JiraTransportResponse>;
export interface JiraAdapterDependencies {
  transport?: JiraTransport;
  now?: () => Date;
}
export interface JiraCoverage {
  state: "not_requested" | "complete" | "partial" | "unavailable";
  retrieved: number;
  total: number | null;
  reason?: string;
}
export interface JiraSourceCapture {
  rawResponse: string;
  raw: Record<string, JsonValue>;
  sourceHash: string;
  fetchedAt: string;
  requestPath: string;
}
export interface JiraIssueSnapshot {
  schemaVersion: "jira-snapshot-v1";
  normalizerVersion: string;
  deployment: "cloud" | "data_center";
  identity: {
    connectionId: string;
    accountContextId: string;
    host: string;
    issueId: string;
    issueKey: string;
  };
  webUrl: string;
  fetchedAt: string;
  updatedAt: string | null;
  sourceHash: string;
  /** Includes source hashes, normalization/mapping version and optional scope/results, not local capture time. */
  captureHash: string;
  source: JiraSourceCapture;
  title: JiraDocument;
  description: JiraDocument;
  status: JiraDocument;
  issueType: JiraDocument;
  acceptanceCriteria: {
    fieldId: string;
    label: string | null;
    document: JiraDocument;
  }[];
  comments: JiraCommentCapture[];
  commentPages: JiraSourceCapture[];
  parent: { pointer: string; result: JiraCaptureResult } | null;
  related: {
    issueId: string;
    issueKey: string;
    references: {
      pointer: string;
      direction: "inward" | "outward";
      linkType: string | null;
    }[];
    result: JiraCaptureResult;
  }[];
  coverage: {
    comments: JiraCoverage;
    parent: JiraCoverage;
    related: JiraCoverage;
  };
}
export interface JiraCommentCapture {
  id: string;
  raw: Record<string, JsonValue>;
  body: JiraDocument;
  updatedAt: string | null;
  sourceHash: string;
  pageIndex: number;
}
export interface JiraCaptureOptions {
  signal?: AbortSignal;
  comments?: { maxComments: number; maxPages?: number };
  parent?: boolean;
  related?: { maxIssues: number };
}
export type JiraFailureState =
  "unconnected" | "unknown_or_forbidden" | "communication_error";
export type JiraCaptureResult =
  | { state: "captured"; snapshot: JiraIssueSnapshot }
  | { state: JiraFailureState; reason: string };
export interface JiraReadAdapter {
  readonly site: JiraSite;
  capture(
    issueKeyOrId: string,
    options?: JiraCaptureOptions,
  ): Promise<JiraCaptureResult>;
}
