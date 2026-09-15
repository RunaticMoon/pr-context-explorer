import { execFileSync } from "node:child_process";

export async function bounded(stage, operation, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`${stage} deadline`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// A failed assertion is conclusive even if Playwright retains inspector sockets.
// Success still requires process exit; the caller separately requires the full
// success marker. Never treat IPC disconnect or attempted teardown as success.
export function driverResult(worker) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off("message", message);
      worker.off("error", error);
      worker.off("exit", exit);
    };
    const message = (value) => {
      if (
        value?.type === "stage" &&
        /^failed-[a-z-]{1,53}$/.test(value.stage)
      ) {
        cleanup();
        reject(Error(`driver failed at ${value.stage}`));
      }
    };
    const error = () => {
      cleanup();
      reject(Error("driver-spawn-failed"));
    };
    const exit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    worker.on("message", message);
    worker.once("error", error);
    worker.once("exit", exit);
  });
}

// Failure-only: a graceful attempt is not evidence of a passing normal quit.
export async function failureCleanup(app, killOwned, ms = 3000) {
  try {
    if (app) await bounded("failure-close", () => app.close(), ms);
  } catch {
    /* The original failing stage remains the failure. */
  } finally {
    await killOwned();
  }
}

// No process-table/environment dump. Inspect only the exact candidate PID.
export function identity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid)
    return null;
  try {
    const value = execFileSync(
      "/bin/ps",
      [
        "-ww",
        "-p",
        String(pid),
        "-o",
        "pid=,ppid=,pgid=,uid=,lstart=,command=",
      ],
      {
        encoding: "utf8",
        timeout: 500,
        maxBuffer: 16384,
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    const m = value.match(
      /^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/,
    );
    return m
      ? {
          pid: +m[1],
          parent: +m[2],
          group: +m[3],
          uid: +m[4],
          started: m[5],
          command: m[6],
        }
      : null;
  } catch {
    return null;
  }
}
export function sameIdentity(a, b) {
  return (
    !!a &&
    !!b &&
    a.pid === b.pid &&
    a.group === b.group &&
    a.uid === b.uid &&
    a.started === b.started &&
    a.command === b.command
  );
}
export function killIdentity(observed) {
  if (
    !observed ||
    observed.uid !== process.getuid() ||
    observed.group !== observed.pid ||
    !sameIdentity(observed, identity(observed.pid))
  )
    return false;
  try {
    process.kill(-observed.pid, "SIGKILL");
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
}

// Whitelist categories, never raw Chromium stderr, inspector URLs or protocol payloads.
export function stderrCategory(text) {
  const stage = text.match(
    /\[prce-smoke\] (app-ready|backend-start|backend-ready|window-load|window-shown|startup-error-dialog|backend-stopped-dialog|active-work-confirmation|normal-quit-backend-stop|normal-quit-backend-stopped)\s*$/,
  );
  if (stage) return `app-${stage[1]}`;
  if (/Debugger listening on ws:\/\//.test(text))
    return "node-inspector-listening";
  if (/DevTools listening on ws:\/\//.test(text))
    return "chromium-devtools-listening";
  if (/Waiting for the debugger to disconnect/.test(text))
    return "node-waiting-for-debugger-disconnect";
  if (
    /SUID sandbox|No usable sandbox|Running as root without --no-sandbox/.test(
      text,
    )
  )
    return "sandbox-unavailable";
  if (/Unable to open X display|Missing X server/.test(text))
    return "display-unavailable";
  if (/Operation not permitted|Permission denied|not authorized/i.test(text))
    return "os-permission-denied";
  return null;
}
