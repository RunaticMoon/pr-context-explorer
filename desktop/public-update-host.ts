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
  if (!target) throw Error("NOT_DOWNLOADED");
  if (!(await hooks.confirm(target))) return "DECLINED";
  let handed = false;
  try {
    // Lock and active test are a single synchronous operation in the backend.
    // Even a lost reply may have locked it; always unlock on failed admission.
    if (!(await hooks.lock())) return "BUSY";
    if (hooks.version() !== target) throw Error("UPDATE_CHANGED");
    await hooks.prepare();
    handed = true;
    await hooks.quit();
    return "READY";
  } finally {
    if (!handed) await hooks.unlock();
  }
}
