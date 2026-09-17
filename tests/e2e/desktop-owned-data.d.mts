import type { ProcessIdentity } from "../../desktop/smoke-helpers.mjs";
export function assertProcessGone(pid: number): void;
export interface OwnedAppData {
  capture(input: {
    app: ProcessIdentity | null;
    executable: string;
    node: string;
  }): { marker: string; backend: ProcessIdentity }[];
  cleanup(): void;
}
export function createOwnedAppData(
  paths: string[],
  options?: {
    ci?: string;
    identity?: (pid: number) => ProcessIdentity | null;
    assertGone?: (pid: number) => void;
  },
): OwnedAppData;
