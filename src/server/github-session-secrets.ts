import { randomBytes } from "node:crypto";
// Process memory only. References are not credentials and are safe in metadata.
const secrets = new Map<string, string>();
const sessionReference = /^[a-f0-9]{48}$/;
function validPat(token: unknown): token is string {
  return (
    typeof token === "string" &&
    token.length > 0 &&
    token.length <= 8192 &&
    !/[\s\x00-\x1f\x7f]/.test(token)
  );
}
export function createGitHubSession(token: unknown): string {
  if (!validPat(token)) throw Error("invalid PAT");
  const ref = randomBytes(24).toString("hex");
  secrets.set(ref, token);
  return ref;
}
/** Re-binds a persisted PAT to its stored session reference at startup. */
export function restoreGitHubSession(ref: string, token: unknown): void {
  if (!sessionReference.test(ref)) throw Error("invalid session reference");
  if (!validPat(token)) throw Error("invalid PAT");
  secrets.set(ref, token);
}
export function githubSessionAvailable(ref: string) {
  return secrets.has(ref);
}
export function githubSessionToken(ref: string): string {
  const token = secrets.get(ref);
  if (!token)
    throw Error("authentication_required: re-enter PAT (session ended)");
  return token;
}
export function deleteGitHubSession(ref: string) {
  secrets.delete(ref);
}
export function replaceGitHubSession(source: string, target: string) {
  if (!/^[a-f0-9]{48}$/.test(target)) throw Error("invalid session reference");
  const token = githubSessionToken(source);
  secrets.set(target, token);
  if (source !== target) secrets.delete(source);
}
