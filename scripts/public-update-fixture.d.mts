// Declarations for scripts/public-update-fixture.mjs (CI-only fixture
// construction; never part of the shipped application).
export const FIXTURE_QUIT_STATE: string;
export const FIXTURE_CONSENT_MODULE: string;
export function fixtureQuitRequest(token: string, pid: number): string;
export function writeFixtureShim(options: {
  directory: string;
  readyFile: string;
  quitFile: string;
  original: string;
}): Promise<string>;
export function makeFixture(options: {
  source: string;
  destination: string;
  version: string;
  scratch: string;
  readyFile: string;
  quitFile: string;
  brokenBackend?: boolean;
}): Promise<string>;
