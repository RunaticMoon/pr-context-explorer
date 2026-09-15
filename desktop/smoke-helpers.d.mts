export interface ProcessIdentity {
  pid: number;
  parent: number;
  group: number;
  uid: number;
  started: string;
  command: string;
}
export function bounded<T>(
  stage: string,
  operation: () => T | Promise<T>,
  ms: number,
): Promise<T>;
export function failureCleanup(
  app: { close(): Promise<unknown> } | undefined,
  killOwned: () => void | Promise<void>,
  ms?: number,
): Promise<void>;
export function identity(pid: number): ProcessIdentity | null;
export function sameIdentity(
  a: ProcessIdentity | null,
  b: ProcessIdentity | null,
): boolean;
export function killIdentity(observed: ProcessIdentity | null): boolean;
export function stderrCategory(text: string): string | null;
