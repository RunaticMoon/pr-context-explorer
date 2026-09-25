import React from "react";
import type { EngineBlocker } from "./commit-review";
import type { EngineSetupEntry } from "./server/engine-setup";
import type { ProviderId } from "./server/ai/events";

// CONTRACT (conductor-owned): implement body only; keep the exported names and prop shapes.
export type TransmissionPlan = {
  snapshotId: string;
  plannedChunks: number;
  maxProviderCalls: number;
  auditCalls: number;
  serializedChunkBytes: number;
  scope: unknown;
  note: string;
};
export type LiveAnalysisControlsProps = {
  providerId: ProviderId;
  onProviderChange: (id: ProviderId) => void;
  /** Entry for providerId from the single existing EngineSetupPanel status (undefined = not yet known). */
  engine?: EngineSetupEntry;
  blockers: EngineBlocker[];
  model: string;
  onModelChange: (value: string) => void;
  consent: boolean;
  onConsentChange: (value: boolean) => void;
  audit: boolean;
  onAuditChange: (value: boolean) => void;
  historical: boolean;
  onHistoricalChange: (value: boolean) => void;
  freshRun: boolean;
  onFreshRunChange: (value: boolean) => void;
  /** Empty = run enabled. */
  runDisabledReasons: string[];
  onRun: () => void;
  /** undefined when no snapshot is open. */
  onPlan?: () => void;
  plan?: TransmissionPlan;
  onOpenEngineSettings: () => void;
  /** Existing job progress/cancel section rendered by the parent, shown inside this area. */
  jobStatus?: React.ReactNode;
};
export function LiveAnalysisControls(
  _props: LiveAnalysisControlsProps,
): React.ReactElement {
  throw new Error("not implemented");
}
