import {
  UpdateError,
  errorCode,
  type UpdateErrorStage,
} from "./public-update/policy.ts";

/**
 * Safe failure description for the renderer snapshot. An UpdateError carries
 * its own code and stage; anything else is reduced to a bounded code and the
 * command's fallback stage. Arbitrary messages never become codes and a
 * previous failure can never leak into a new one.
 */
export function describeUpdateFailure(
  error: unknown,
  fallbackStage: UpdateErrorStage,
): { code: string; stage: UpdateErrorStage } {
  const stage =
    error instanceof UpdateError && error.errorStage
      ? error.errorStage
      : fallbackStage;
  return { code: errorCode(error, "UPDATE_FAILED"), stage };
}
