import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { AIError } from "./errors.ts";

export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  deadlineMs: number;
  inactivityMs?: number;
  signal?: AbortSignal;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxTotalBytes?: number;
  onStdout?: (chunk: Buffer) => void;
}
export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  terminationSignal?: NodeJS.Signals;
  stdoutBytes: number;
  stderrBytes: number;
}

/** Internal primitive, NOT an OS sandbox. runAnalysis always uses the sandbox gate.
 * POSIX groups clean ordinary descendants; the PID namespace additionally contains
 * processes that call setsid. Output caps count bytes, not JS string characters.
 */
export async function runBoundedProcess(
  r: ProcessRequest,
): Promise<ProcessResult> {
  if (r.signal?.aborted) throw new AIError("cancelled");
  const outCap = r.maxStdoutBytes ?? 4 * 1024 * 1024,
    errCap = r.maxStderrBytes ?? 256 * 1024;
  const totalCap = r.maxTotalBytes ?? outCap + errCap;
  if (
    !isAbsolute(r.executable) ||
    !isAbsolute(r.cwd) ||
    process.platform === "win32" ||
    [
      r.deadlineMs,
      outCap,
      errCap,
      totalCap,
      ...(r.inactivityMs === undefined ? [] : [r.inactivityMs]),
    ].some((n) => !Number.isSafeInteger(n) || n <= 0 || n > 2_147_483_647)
  )
    throw new AIError("invalid_request");
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(r.executable, r.args, {
        cwd: r.cwd,
        env: r.env,
        shell: false,
        stdio: "pipe",
        detached: true,
      });
    } catch {
      reject(new AIError("spawn_failed"));
      return;
    }
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let stdoutBytes = 0,
      stderrBytes = 0,
      failure: AIError | undefined,
      done = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const killGroup = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already reaped */
        }
      }
    };
    const fail = (e: AIError) => {
      failure ??= e;
      killGroup();
    };
    const cancel = () => fail(new AIError("cancelled"));
    const deadline = setTimeout(
      () => fail(new AIError("timeout")),
      r.deadlineMs,
    );
    const touch = () => {
      if (idle) clearTimeout(idle);
      if (r.inactivityMs)
        idle = setTimeout(
          () => fail(new AIError("inactivity_timeout")),
          r.inactivityMs,
        );
    };
    const finish = (
      exitCode: number | null,
      terminationSignal?: NodeJS.Signals | null,
    ) => {
      if (done) return;
      done = true;
      killGroup();
      clearTimeout(deadline);
      if (idle) clearTimeout(idle);
      r.signal?.removeEventListener("abort", cancel);
      if (failure) reject(failure);
      else
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode,
          ...(terminationSignal ? { terminationSignal } : {}),
          stdoutBytes,
          stderrBytes,
        });
    };
    const receive = (chunk: Buffer, isOut: boolean) => {
      if (failure || done) return;
      touch();
      if (isOut) stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (
        stdoutBytes > outCap ||
        stderrBytes > errCap ||
        stdoutBytes + stderrBytes > totalCap
      ) {
        fail(new AIError("output_limit"));
        return;
      }
      (isOut ? stdout : stderr).push(chunk);
      if (isOut && r.onStdout) {
        try {
          r.onStdout(chunk);
        } catch (e) {
          fail(e instanceof AIError ? e : new AIError("callback_failed"));
        }
      }
    };
    child.stdout!.on("data", (chunk: Buffer) => receive(chunk, true));
    child.stderr!.on("data", (chunk: Buffer) => receive(chunk, false));
    child.once("error", () => {
      failure ??= new AIError("spawn_failed");
      finish(null);
    });
    // Kill lingering group children as soon as the parent exits, before waiting
    // for inherited stdout/stderr pipes to close.
    child.once("exit", killGroup);
    child.once("close", finish);
    child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED")
        fail(new AIError("spawn_failed"));
    });
    r.signal?.addEventListener("abort", cancel, { once: true });
    if (r.signal?.aborted) cancel();
    touch();
    child.stdin!.end(r.stdin ?? "");
  });
}
