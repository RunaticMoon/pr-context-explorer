import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { backendEnvironment } from "./security.ts";
export class BackendProcess {
  private child?: ChildProcess;
  private stopped?: Promise<void>;
  private sequence = 0;
  readonly key = randomBytes(32).toString("hex");
  constructor(
    private config: {
      node: string;
      entry: string;
      runtime: string;
      data: string;
      dist: string;
      admissionClosed?: boolean;
    },
    private failed: () => void = () => {},
  ) {}
  get pid() {
    return this.child?.pid;
  }
  async start(): Promise<string> {
    if (this.child || this.stopped) throw Error("Backend already started");
    for (const dir of ["home", "tmp", "live", "demo"])
      mkdirSync(path.join(this.config.data, dir), {
        recursive: true,
        mode: 0o700,
      });
    const env = backendEnvironment(
      this.config.data,
      path.dirname(this.config.node),
    );
    const ai = path.join(this.config.data, "ai-config.json");
    // This fixed app-owned file is explicitly selected/copied by the owner, never source config.
    if (existsSync(ai)) env.PRCE_AI_CONFIG = ai;
    const child = (this.child = spawn(this.config.node, [this.config.entry], {
      cwd: this.config.runtime,
      env,
      detached: true,
      shell: false,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    }));
    child.on("error", () => this.failed());
    child.once("exit", () => {
      if (!this.stopped) this.failed();
    });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        void this.stop();
        reject(Error("Backend startup timed out"));
      }, 30000);
      const error = () => {
        cleanup();
        reject(
          Error(
            "Backend unavailable: check Git installation and app resources",
          ),
        );
      };
      const message = (m: any) => {
        if (
          m?.type === "ready" &&
          /^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(m.origin) &&
          Number(new URL(m.origin).port) > 0
        ) {
          cleanup();
          resolve(m.origin);
        } else if (m?.type === "failed") error();
      };
      const cleanup = () => {
        clearTimeout(timeout);
        child.off("message", message);
        child.off("error", error);
        child.off("exit", error);
      };
      child.on("message", message);
      child.once("error", error);
      child.once("exit", error);
      child.send(
        {
          type: "start",
          key: this.key,
          dist: this.config.dist,
          admissionClosed: this.config.admissionClosed === true,
        },
        (e) => {
          if (e) error();
        },
      );
    });
  }
  // Tri-state probe: "idle" only on an explicit active===false reply; any
  // missing channel, exit, send failure, or timeout reports "unavailable" so
  // callers can fail closed without conflating unknown with active work.
  async status(): Promise<"idle" | "active" | "unavailable"> {
    const child = this.child;
    if (!child?.connected || this.stopped) return "unavailable";
    const id = ++this.sequence;
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish("unavailable"), 2000);
      const message = (m: any) => {
        if (m?.type === "status" && m.id === id)
          finish(m.active === false ? "idle" : "active");
      };
      const finish = (status: "idle" | "active" | "unavailable") => {
        clearTimeout(timer);
        child.off("message", message);
        child.off("exit", dead);
        child.off("disconnect", dead);
        resolve(status);
      };
      const dead = () => finish("unavailable");
      child.on("message", message);
      child.once("exit", dead);
      child.once("disconnect", dead);
      child.send({ type: "status", id }, (e) => {
        if (e) finish("unavailable");
      });
    });
  }
  async active(): Promise<boolean> {
    return (await this.status()) !== "idle";
  }
  async admission(locked: boolean): Promise<boolean> {
    const child = this.child;
    if (!child?.connected || this.stopped) return false;
    const id = ++this.sequence;
    return new Promise((resolve) => {
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        child.off("message", message);
        child.off("exit", failed);
        child.off("disconnect", failed);
        resolve(ok);
      };
      const failed = () => finish(false);
      const timer = setTimeout(failed, 2000);
      const message = (m: any) => {
        if (m?.type === "admission" && m.id === id) finish(m.ok === true);
      };
      child.on("message", message);
      child.once("exit", failed);
      child.once("disconnect", failed);
      child.send({ type: "admission", id, locked }, (e) => {
        if (e) failed();
      });
    });
  }
  stop(): Promise<void> {
    if (this.stopped) return this.stopped;
    const child = this.child;
    this.stopped = new Promise((resolve) => {
      if (!child || child.exitCode !== null || child.signalCode !== null)
        return resolve();
      const killGroup = () => {
        if (child.pid)
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* already gone */
          }
      };
      const timer = setTimeout(killGroup, 8000);
      child.once("exit", () => {
        clearTimeout(timer);
        killGroup();
        resolve();
      });
      if (child.connected) child.send({ type: "shutdown" }, () => {});
      else child.kill("SIGTERM");
    });
    return this.stopped;
  }
}
