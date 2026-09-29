import {
  UpdateError,
  errorCode,
  type UpdateErrorStage,
} from "./public-update/policy.ts";

/** Whether a thrown value already carries a usable error stage. */
function staged(error: unknown, stage: UpdateErrorStage): UpdateError {
  if (error instanceof UpdateError && error.errorStage) return error;
  // Untrusted messages never survive: only a bounded code is kept.
  return new UpdateError(errorCode(error, "UPDATE_FAILED"), stage);
}

/** Main-only lifecycle orchestration. No paths, versions or consent from IPC. */
export async function installPublicUpdate(hooks: {
  version: () => string | undefined;
  confirm: (version: string) => Promise<boolean>;
  lock: () => Promise<boolean>;
  unlock: () => Promise<unknown>;
  prepare: () => Promise<unknown>;
  quit: () => Promise<unknown>;
}): Promise<"DECLINED" | "BUSY" | "READY"> {
  const target = hooks.version();
  if (!target) throw new UpdateError("NOT_DOWNLOADED", "install");
  let confirmed: boolean;
  try {
    confirmed = await hooks.confirm(target);
  } catch (error) {
    throw staged(error, "install");
  }
  if (!confirmed) return "DECLINED";
  let handed = false,
    failed = false;
  try {
    // Lock and active test are a single synchronous operation in the backend.
    // Even a lost reply may have locked it; always unlock on failed admission.
    let locked: boolean;
    try {
      locked = await hooks.lock();
    } catch (error) {
      throw staged(error, "install");
    }
    if (!locked) return "BUSY";
    if (hooks.version() !== target)
      throw new UpdateError("UPDATE_CHANGED", "install");
    await hooks.prepare().catch((error) => {
      throw staged(error, "prepare");
    });
    handed = true;
    await hooks.quit().catch((error) => {
      throw staged(error, "install");
    });
    return "READY";
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // A primary failure wins: a failing unlock must never mask it. With no
    // primary failure, unlock still surfaces its own error as before.
    if (!handed && failed) await hooks.unlock().catch(() => {});
    else if (!handed) await hooks.unlock();
  }
}
