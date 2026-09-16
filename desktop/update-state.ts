export type UpdateStatus = {
  phase:
    | "external"
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "ready"
    | "error"
    | "installing";
  version?: string;
  percent?: number;
  message?: string;
};
export class UpdateState {
  status: UpdateStatus;
  constructor(
    readonly enabled: boolean,
    private changed: () => void = () => {},
  ) {
    this.status = enabled
      ? { phase: "idle" }
      : {
          phase: "external",
          message:
            "Signed private updates disabled. Personal public updates use their own anonymous channel in Settings → 업데이트.",
        };
  }
  private set(status: UpdateStatus) {
    this.status = status;
    this.changed();
  }
  beginCheck() {
    if (!this.enabled) throw Error("Signed updates disabled");
    if (
      ["checking", "downloading", "ready", "installing"].includes(
        this.status.phase,
      )
    )
      return false;
    this.set({ phase: "checking" });
    return true;
  }
  available(version: string) {
    if (this.status.phase === "checking" && /^\d+\.\d+\.\d+$/.test(version))
      this.set({ phase: "available", version });
    else this.fail();
  }
  current() {
    if (this.enabled)
      this.set({ phase: "idle", message: "No newer stable release" });
  }
  beginDownload() {
    if (!this.enabled || this.status.phase !== "available") return false;
    this.set({ ...this.status, phase: "downloading", percent: 0 });
    return true;
  }
  progress(percent: number) {
    if (this.status.phase === "downloading" && Number.isFinite(percent))
      this.set({
        ...this.status,
        percent: Math.max(0, Math.min(100, Math.round(percent))),
      });
  }
  downloaded() {
    if (this.status.phase === "downloading")
      this.set({ ...this.status, phase: "ready", percent: 100 });
  }
  fail() {
    if (this.enabled)
      this.set({
        phase: "error",
        message:
          "Update unavailable. Check release access, network and signing; credentials and server responses are not logged.",
      });
  }
  cancel() {
    if (this.enabled && this.status.phase !== "installing")
      this.set({ phase: "idle", message: "Update cancelled" });
  }
  async install(
    active: () => Promise<boolean>,
    consent: () => Promise<boolean>,
    install: () => void,
  ) {
    if (
      !this.enabled ||
      this.status.phase !== "ready" ||
      (await active()) ||
      !(await consent()) ||
      (await active())
    )
      return false;
    if (this.status.phase !== "ready") return false;
    this.set({ ...this.status, phase: "installing" });
    install();
    return true;
  }
}
