import path from "node:path";
import { bindNativeACL } from "./acl.ts";
import { lstat } from "node:fs/promises";
import {
  APP_NAME,
  errorCode,
  fail,
  keys,
  record,
  version,
  validateManifest,
  compareVersions,
  type Manifest,
} from "./policy.ts";
import {
  privateDirectory,
  ancestors,
  readPrivate,
  writePrivate,
  hashFile,
  uid,
} from "./files.ts";
import { systemCommand, validateApp } from "./validate-app.ts";
import { acquireLock, replaceTransaction } from "./transaction.ts";
export interface InstallPlan {
  schemaVersion: 1;
  nonce: string;
  appPath: string;
  workDir: string;
  oldVersion: string;
  manifest: Manifest;
  oldPid: number;
  oldIdentity: string;
  deadline: number;
  nodeHash: string;
  helperHash: string;
}
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export function validatePlan(input: unknown, planPath: string): InstallPlan {
  const x = record(input);
  keys(x, [
    "schemaVersion",
    "nonce",
    "appPath",
    "workDir",
    "oldVersion",
    "manifest",
    "oldPid",
    "oldIdentity",
    "deadline",
    "nodeHash",
    "helperHash",
  ]);
  if (
    x.schemaVersion !== 1 ||
    typeof x.nonce !== "string" ||
    !/^[a-f0-9]{64}$/.test(x.nonce) ||
    typeof x.appPath !== "string" ||
    typeof x.workDir !== "string" ||
    !path.isAbsolute(x.appPath) ||
    path.normalize(x.appPath) !== x.appPath ||
    path.basename(x.appPath) !== APP_NAME ||
    x.workDir !==
      path.join(path.dirname(x.appPath), `.prce-update-${x.nonce}`) ||
    planPath !== path.join(x.workDir, "plan.json") ||
    !Number.isSafeInteger(x.oldPid) ||
    (x.oldPid as number) < 2 ||
    typeof x.oldIdentity !== "string" ||
    x.oldIdentity.length > 4096 ||
    !Number.isSafeInteger(x.deadline) ||
    typeof x.nodeHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(x.nodeHash) ||
    typeof x.helperHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(x.helperHash)
  )
    fail("UNSAFE_PLAN");
  const m = record(x.manifest);
  const manifest = validateManifest(m, String(m.tag));
  if (compareVersions(manifest.version, version(x.oldVersion)) <= 0)
    fail("INVALID_VERSION");
  return { ...x, manifest } as unknown as InstallPlan;
}
/**
 * Verified-terminal process states. Z (zombie — terminated, awaiting reap)
 * is the only `stat` letter that proves a process has finished userland
 * permanently on the supported platforms: Apple's ps.1 calls Z "a dead
 * process", while E is a secondary modifier appended after the primary
 * letter (print.c, suppressed for SZOMB) on a still-live process that is
 * "trying to exit" — blocked, not dead — and its X marks a traced process.
 * Secondary flags and unrecognized letters are never a primary dead status.
 */
const DEAD_STATES = new Set(["Z"]);
const KNOWN_STATES = new Set([
  "R",
  "S",
  "T",
  "Z",
  "I",
  "U",
  "D",
  "X",
  "x",
  "E",
  "H",
  "W",
  "K",
  "P",
  "L",
  "O",
  "N",
  "?",
]);
/** Fresh kill(pid,0): false only on ESRCH-verified absence; a non-ESRCH failure still fails closed. */
function processPresent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    fail("PROCESS_IDENTITY");
  }
}
/**
 * The bounded `processState` decision over two fresh facts: the trimmed
 * `ps -o stat=` line and a rechecked kill(pid,0). ESRCH-verified absence is
 * the only null; an empty line on a still-present process is a read gap
 * reported as OTHER, never absence; a known primary letter reports itself;
 * anything else is OTHER.
 */
export function stateFromRead(text: string, present: boolean): string | null {
  if (!present) return null;
  if (!text) return "OTHER";
  const letter = text[0];
  return KNOWN_STATES.has(letter) ? letter : "OTHER";
}
/**
 * The bounded `processIdentity` decision over the same two facts: the
 * `uid + lstart + comm` string returns unchanged; ESRCH-verified absence is
 * the only null; an empty line on a still-present process fails closed —
 * never permission to proceed.
 */
export function identityFromRead(
  text: string,
  present: boolean,
): string | null {
  if (!present) return null;
  if (!text) return fail("PROCESS_IDENTITY");
  return text;
}
/**
 * Whether a bounded state read is the verified-gone answer: ESRCH-verified
 * absence (null) or the sole verified-terminal letter Z. Exiting (E), traced
 * (X/x), and unrecognized or ambiguous reads all keep the process present —
 * never gone.
 */
export function stateIsGone(state: string | null): boolean {
  return state === null || DEAD_STATES.has(state);
}
/** Bounded OS process state for diagnostics: a fixed letter, null when absent, OTHER when unreadable or unrecognized. Never raw ps output. */
export async function processState(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid < 2) fail("PROCESS_IDENTITY");
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return null;
    fail("PROCESS_IDENTITY");
  }
  try {
    // The rechecked kill0 — not the ps line alone — is what may answer
    // absence; empty output on a still-present process is a read gap → OTHER.
    return stateFromRead(
      await systemCommand("/bin/ps", [
        "-ww",
        "-p",
        String(pid),
        "-o",
        "stat=",
      ]),
      processPresent(pid),
    );
  } catch {
    // kill0 proved the process exists; an unreadable state is never absence.
    return "OTHER";
  }
}
export async function processIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid < 2) fail("PROCESS_IDENTITY");
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return null;
    fail("PROCESS_IDENTITY");
  }
  try {
    const identity = identityFromRead(
      await systemCommand("/bin/ps", [
        "-ww",
        "-p",
        String(pid),
        "-o",
        "uid=",
        "-o",
        "lstart=",
        "-o",
        "comm=",
      ]),
      processPresent(pid),
    );
    if (identity === null) return null;
    // The identity string is intentionally unchanged (uid + start + command).
    // Only a verified-terminal state — or a process that exited between the
    // two reads — turns a lingering process-table row into the honest "gone"
    // answer; an exiting or unreadable state never manufactures absence.
    if (stateIsGone(await processState(pid).catch(() => "OTHER")))
      return null;
    return identity;
  } catch {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return null;
    }
    return fail("PROCESS_IDENTITY");
  }
}
export function ownedAppIdentity(identity: string, appPath: string): boolean {
  return (
    Number(identity.trim().split(/\s+/)[0]) === uid() &&
    identity.endsWith(path.join(appPath, "Contents/MacOS/PR Context Explorer"))
  );
}
/** Whether this process was launched by the update helper with the fixed plan argument. */
export function updatePlanRequested(
  argv: readonly string[] = process.argv,
): boolean {
  return argv.some((a) => a.startsWith("--prce-update-plan="));
}
/** Bounded code for diagnostics: update/errno codes survive, arbitrary text never does. */
export function helperFailureCode(error: unknown): string {
  return errorCode(error, "WORKER_ERROR");
}
/**
 * Record a bounded helper failure receipt beside the plan. Never overwrites a
 * durable transaction result, never alters the worker exit contract, and never
 * leaks error text, paths, environment or output. Returns the bounded code.
 */
export async function reportHelperFailure(
  planPath: string,
  error: unknown,
): Promise<string> {
  const code = helperFailureCode(error);
  try {
    const dir = path.dirname(planPath);
    // Failure receipts live only inside an owned transaction-shaped workDir.
    if (
      !path.isAbsolute(planPath) ||
      path.basename(planPath) !== "plan.json" ||
      !/^\.prce-update-[0-9a-f]{64}$/.test(path.basename(dir))
    )
      return code;
    // A durable transaction outcome is authoritative; never mask it.
    if (await lstat(path.join(dir, "result.json")).catch(() => null))
      return code;
    await writePrivate(path.join(dir, "failure.json"), {
      phase: "failed",
      code,
      at: Date.now(),
    });
  } catch {
    /* diagnostics never change the worker exit contract */
  }
  return code;
}
/**
 * Single-write fixed-label phase markers inside the private work directory.
 * Diagnostic only: not a receipt. A malformed programmer-supplied label still
 * fails loudly, but marker persistence itself is best-effort — an I/O failure
 * here must never abort the update, stop, restore or relaunch it only observes.
 */
export function phaseMarker(
  workDir: string,
): (step: string) => Promise<void> {
  return async (step: string) => {
    if (!/^[a-z][a-z-]{1,31}$/.test(step)) fail("UNSAFE_PLAN");
    await writePrivate(path.join(workDir, `phase.${step}`), {
      phase: step,
      at: Date.now(),
    }).catch(() => {});
  };
}
/**
 * Whether a plan-launched instance is still an uncommitted startup probe.
 * User-facing failure reporting is suppressed only inside this window; once
 * startup commits, the instance is the user's ordinary session — irreversibly,
 * even after backend death resets startup readiness.
 */
export function updateProbeActive(
  updateLaunch: boolean,
  committed: boolean,
): boolean {
  return updateLaunch && !committed;
}
/**
 * Best-effort bounded IPC announcement on a possibly-closing channel.
 * Asynchronous send errors are delivered to the callback and discarded; the
 * durable file receipts remain authoritative. Never throws.
 */
export function sendHelperMessage(message: {
  type: string;
  nonce?: string;
  code?: string;
}): void {
  try {
    process.send?.(message, () => {});
  } catch {
    /* closed IPC channel */
  }
}
export interface BootReceipt {
  pid: number;
  identity: string;
  nonce: string;
  version: string;
}
/**
 * Stop a boot-identified failed new instance. Only the exact receipt-verified
 * PID may be signalled; an unconfirmed or unstoppable launch fails so the
 * transaction preserves backup + lock for manual recovery.
 */
export async function stopFailedBoot(
  readBoot: () => Promise<BootReceipt | null>,
): Promise<void> {
  const boot = await readBoot();
  // Without a trustworthy early receipt we cannot safely signal a process.
  // Preserve backup + lock for manual recovery rather than killing unrelated work.
  if (!boot) fail("STARTUP_UNCONFIRMED");
  const identity = await processIdentity(boot.pid);
  if (identity === null) return;
  if (identity !== boot.identity) fail("PROCESS_IDENTITY");
  process.kill(boot.pid, "SIGTERM");
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    if ((await processIdentity(boot.pid)) === null) return;
    await pause(100);
  }
  fail("STARTUP_STOP_TIMEOUT");
}
async function optionalPrivate(file: string): Promise<unknown | null> {
  if (
    !(await lstat(file).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    }))
  )
    return null;
  return readPrivate(file);
}
async function planFromStartup(
  appPath: string,
  currentVersion: string,
): Promise<{ plan: InstallPlan; planPath: string } | null> {
  bindNativeACL(
    path.join(appPath, "Contents/Resources/runtime/native/prce-macos-acl"),
  );
  const args = process.argv.filter((a) => a.startsWith("--prce-update-plan="));
  if (!args.length) return null;
  if (args.length !== 1) fail("UNSAFE_PLAN");
  const planPath = args[0].slice("--prce-update-plan=".length),
    plan = validatePlan(await readPrivate(planPath), planPath);
  if (plan.appPath !== appPath || plan.manifest.version !== currentVersion)
    fail("UNSAFE_PLAN");
  await privateDirectory(plan.workDir);
  const launch = record(
    await readPrivate(path.join(plan.workDir, "launch.json")),
  );
  if (
    launch.nonce !== plan.nonce ||
    typeof launch.time !== "number" ||
    Date.now() - launch.time > 120000 ||
    launch.time > Date.now() + 5000
  )
    fail("UNSAFE_PLAN");
  return { plan, planPath };
}
/** Call at process startup before admitting analysis. Returns whether this is an update launch. */
export async function registerStartup(
  appPath: string,
  currentVersion: string,
): Promise<boolean> {
  const context = await planFromStartup(appPath, currentVersion);
  if (!context) return false;
  const identity = await processIdentity(process.pid);
  if (!identity || !ownedAppIdentity(identity, appPath))
    fail("PROCESS_IDENTITY");
  await writePrivate(path.join(context.plan.workDir, "boot.json"), {
    nonce: context.plan.nonce,
    pid: process.pid,
    identity,
    version: currentVersion,
  });
  return true;
}
/** Call only when backend AND window ready; host must not start analysis before this. */
export async function acknowledgeStartup(
  appPath: string,
  currentVersion: string,
): Promise<void> {
  const context = await planFromStartup(appPath, currentVersion);
  if (!context) return;
  const boot = record(
    await readPrivate(path.join(context.plan.workDir, "boot.json")),
  );
  if (
    boot.pid !== process.pid ||
    boot.identity !== (await processIdentity(process.pid)) ||
    boot.nonce !== context.plan.nonce
  )
    fail("PROCESS_IDENTITY");
  await writePrivate(path.join(context.plan.workDir, "startup.json"), boot);
  // Do not admit analysis until the helper has durably accepted readiness.
  // A late startup receipt racing the helper's timeout is not a commit.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const raw = await optionalPrivate(
      path.join(context.plan.workDir, "commit.json"),
    );
    if (raw) {
      const committed = record(raw);
      if (
        committed.nonce !== context.plan.nonce ||
        committed.pid !== process.pid
      )
        fail("STARTUP_RECEIPT");
      return;
    }
    await pause(100);
  }
  fail("STARTUP_COMMIT_TIMEOUT");
}
export async function runHelper(
  planPath: string,
  ready: (nonce: string) => void,
): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    fail("UNSUPPORTED_PLATFORM");
  bindNativeACL(path.join(path.dirname(process.execPath), "prce-macos-acl"));
  const p = validatePlan(await readPrivate(planPath), planPath);
  await privateDirectory(p.workDir);
  const mark = phaseMarker(p.workDir);
  await ancestors(path.dirname(p.appPath));
  if (
    p.deadline < Date.now() ||
    p.deadline > Date.now() + 180000 ||
    p.oldPid === process.pid
  )
    fail("EXPIRED_PLAN");
  if (
    !ownedAppIdentity(p.oldIdentity, p.appPath) ||
    (await processIdentity(p.oldPid)) !== p.oldIdentity
  )
    fail("PROCESS_IDENTITY");
  if (
    process.execPath !== path.join(p.workDir, "node") ||
    process.argv[1] !== path.join(p.workDir, "helper.cjs")
  )
    fail("UNSAFE_HELPER");
  for (const [name, hash] of [
    ["node", p.nodeHash],
    ["helper.cjs", p.helperHash],
  ] as const)
    if ((await hashFile(path.join(p.workDir, name))).sha256 !== hash)
      fail("HELPER_HASH");
  const zip = await hashFile(path.join(p.workDir, "update.zip"));
  if (
    zip.sha256 !== p.manifest.asset.sha256 ||
    zip.size !== p.manifest.asset.size
  )
    fail("HASH_MISMATCH");
  const stagedApp = path.join(p.workDir, "stage", APP_NAME);
  await validateApp(stagedApp, p.manifest.version);
  await validateApp(p.appPath, p.oldVersion);
  const lock = await acquireLock(p.appPath);
  let handed = false;
  try {
    if (await optionalPrivate(path.join(p.workDir, "cancel.json")))
      fail("CANCELLED");
    ready(p.nonce);
    for (;;) {
      if (await optionalPrivate(path.join(p.workDir, "cancel.json")))
        fail("CANCELLED");
      if (Date.now() > p.deadline) fail("EXIT_TIMEOUT");
      const identity = await processIdentity(p.oldPid);
      if (identity === null) break;
      if (identity !== p.oldIdentity) fail("PROCESS_IDENTITY");
      await pause(150);
    }
    await mark("old-exited");
    // Old process is never signalled or killed. Exact process exit is mandatory.
    let launched = false;
    const readBoot = async () => {
      const raw = await optionalPrivate(path.join(p.workDir, "boot.json"));
      if (!raw) return null;
      const b = record(raw);
      if (
        b.nonce !== p.nonce ||
        b.version !== p.manifest.version ||
        !Number.isSafeInteger(b.pid) ||
        typeof b.identity !== "string" ||
        !ownedAppIdentity(b.identity, p.appPath) ||
        b.pid === p.oldPid
      )
        fail("PROCESS_IDENTITY");
      return b as {
        pid: number;
        identity: string;
        nonce: string;
        version: string;
      };
    };
    handed = true;
    await replaceTransaction(
      {
        appPath: p.appPath,
        stagedApp,
        workDir: p.workDir,
        version: p.manifest.version,
        oldVersion: p.oldVersion,
      },
      {
        validate: validateApp,
        checkpoint: mark,
        launch: async (app) => {
          await writePrivate(path.join(p.workDir, "launch.json"), {
            nonce: p.nonce,
            time: Date.now(),
          });
          launched = true;
          await systemCommand("/usr/bin/open", [
            "-n",
            app,
            "--args",
            `--prce-update-plan=${planPath}`,
          ]);
          await mark("launched");
          let bootSeen = false;
          const until = Date.now() + 90000;
          while (Date.now() < until) {
            const boot = await readBoot(),
              raw = await optionalPrivate(path.join(p.workDir, "startup.json"));
            if (boot) {
              if (!bootSeen) {
                bootSeen = true;
                await mark("boot-observed");
              }
              const identity = await processIdentity(boot.pid);
              if (identity !== boot.identity) fail("STARTUP_FAILED");
              if (raw) {
                const receipt = record(raw);
                if (
                  receipt.nonce !== p.nonce ||
                  receipt.pid !== boot.pid ||
                  receipt.identity !== boot.identity ||
                  receipt.version !== p.manifest.version
                )
                  fail("STARTUP_RECEIPT");
                await writePrivate(path.join(p.workDir, "commit.json"), {
                  nonce: p.nonce,
                  pid: boot.pid,
                });
                return;
              }
            }
            await pause(250);
          }
          fail("STARTUP_TIMEOUT");
        },
        stopFailedLaunch: async () => {
          if (!launched) return;
          await mark("stopping-failed");
          await stopFailedBoot(readBoot);
          await mark("failed-stopped");
        },
        rollbackLaunch: async (app) => {
          await systemCommand("/usr/bin/open", ["-n", app]);
        },
      },
      lock,
    );
  } finally {
    if (!handed) await lock.release();
  }
}
