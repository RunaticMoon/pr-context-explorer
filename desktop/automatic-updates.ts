import type { Preferences } from "./preferences.ts";
import type { Phase } from "./public-update/index.ts";

export const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000;
export function canCheckForUpdate(phase: Phase): boolean {
  return ![
    "checking",
    "downloading",
    "downloaded",
    "preparing",
    "ready",
  ].includes(phase);
}

/** One main-process timer; automatic work never installs or interrupts analysis. */
export class AutomaticUpdates {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private running = false;
  private requested = false;
  constructor(
    private readonly hooks: {
      active: () => boolean;
      preferences: () => Preferences;
      phase: () => Phase;
      command: (action: "check" | "download") => Promise<unknown>;
    },
  ) {}

  start() {
    if (this.hooks.preferences().autoCheck) this.schedule(30_000);
  }
  preferencesChanged(previous: Preferences) {
    if (this.stopped) return;
    const next = this.hooks.preferences();
    clearTimeout(this.timer);
    if (
      (!previous.autoCheck && next.autoCheck) ||
      (!previous.autoDownload &&
        next.autoDownload &&
        this.hooks.phase() === "available")
    ) {
      if (this.running) this.requested = true;
      else this.schedule(0);
    } else if (next.autoCheck && !this.running)
      this.schedule(UPDATE_CHECK_INTERVAL);
  }
  stop() {
    this.stopped = true;
    this.requested = false;
    clearTimeout(this.timer);
  }
  private schedule(delay: number) {
    clearTimeout(this.timer);
    if (!this.stopped) this.timer = setTimeout(() => void this.tick(), delay);
  }
  private async tick() {
    if (this.stopped || !this.hooks.active() || this.running) return;
    this.running = true;
    try {
      const preferences = this.hooks.preferences(),
        phase = this.hooks.phase();
      if (preferences.autoDownload && phase === "available")
        await this.hooks.command("download");
      else if (preferences.autoCheck && canCheckForUpdate(phase))
        await this.hooks.command("check");
    } catch {
      // Command owns the bounded user-facing error; a network failure must not
      // permanently disable future checks or turn into an unhandled rejection.
    } finally {
      this.running = false;
      if (!this.stopped && this.hooks.active()) {
        if (this.requested) {
          this.requested = false;
          this.schedule(0);
        } else if (this.hooks.preferences().autoCheck)
          this.schedule(UPDATE_CHECK_INTERVAL);
      }
    }
  }
}
