// Quit controller for the desktop app.
//
// The user-facing quit path fails closed: if the sidecar reports active work
// (or cannot be reached, which is reported as unavailable), the app asks the
// user whether to cancel that work and quit. The confirmation is attached to
// the visible window so it renders as a sheet instead of a blocking modal
// alert: on macOS a windowless showMessageBox uses [NSAlert runModal], which
// wedges the main loop and prevents SIGTERM/IPC handling while the alert is
// up.
//
// Repeated ordinary quit requests deduplicate: a second before-quit while the
// confirmation is pending keeps waiting for the user's explicit answer — it
// is neither consent nor proof of an OS signal, and must never cancel active
// work by itself. Only the trusted signal path (handleSignal, driven by an
// observed process.on("SIGTERM"/"SIGINT")) bypasses the confirmation; it
// reuses the same serialized close path so a signal during a pending
// confirmation still closes updates, stops the sidecar, releases the runtime
// marker, and re-dispatches app.quit(). A dialog resolving after that
// authorized close cannot overwrite terminal state or run the close twice.

import type { Phase } from "./public-update/index.ts";

export interface BackendStatusProbe {
  status(): Promise<"idle" | "active" | "unavailable">;
}

export interface QuitDialogHost {
  confirm(): Promise<boolean>;
}

export interface QuitHooks {
  closeUpdates(): Promise<void>;
  stopBackend(): Promise<void>;
  releaseProcess(): Promise<void>;
  appQuit(): void;
}

export type QuitStage =
  | "before-quit"
  | "backend-status"
  | "confirm-open"
  | "confirm-resolved"
  | "updates-closing"
  | "backend-stopping"
  | "quit-dispatch"
  | "quit-blocked";

export interface QuitController {
  handleBeforeQuit(prevent: () => void): void;
  handleSignal(sig: string): Promise<void>;
  stage(): QuitStage;
  quitRequested(): boolean;
  confirming(): boolean;
  closed(): boolean;
}

// Public-update status phases in which an in-flight install transaction
// owns process admission: an ordinary quit arriving during one is ignored
// entirely. Network work can still be cancelled by an ordinary quit; a quit
// must never interrupt an install.
export const INSTALL_OWNED_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  "downloaded",
  "preparing",
  "ready",
]);

export function createQuitController(deps: {
  backend: BackendStatusProbe;
  dialog: QuitDialogHost;
  hooks: QuitHooks;
  stageCb?: (stage: QuitStage) => void;
}): QuitController {
  let stage: QuitStage = "before-quit";
  let requested = false;
  let confirmPromise: Promise<void> | null = null;
  let closingPromise: Promise<void> | null = null;
  let closed = false;

  const setStage = (s: QuitStage) => {
    stage = s;
    try {
      deps.stageCb?.(s);
    } catch {
      /* best-effort diagnostics never abort the quit path */
    }
  };

  // A declined consent or a failed close fails closed: the app keeps running,
  // the stage names the blocking seam, and every latch re-arms so the next
  // quit request runs a fresh attempt instead of waiting on a stale promise.
  const blockQuit = () => {
    closingPromise = null;
    confirmPromise = null;
    requested = false;
    setStage("quit-blocked");
  };

  const grantQuit = () => {
    if (!closingPromise) {
      closingPromise = (async () => {
        try {
          setStage("updates-closing");
          await deps.hooks.closeUpdates();
          setStage("backend-stopping");
          await deps.hooks.stopBackend();
          await deps.hooks.releaseProcess();
          closed = true;
          setStage("quit-dispatch");
          deps.hooks.appQuit();
        } catch {
          closed = false;
          blockQuit();
        }
      })();
    }
    return closingPromise;
  };

  const confirm = () => {
    if (!confirmPromise) {
      confirmPromise = (async () => {
        try {
          // A signal-authorized close may already be running or done: never
          // restart the probe or touch terminal state.
          if (closingPromise || closed) return;
          setStage("backend-status");
          const status = await deps.backend.status();
          // A signal-authorized close may already be running or done: a late
          // probe answer must not open a dialog or touch terminal state.
          if (closingPromise || closed) return;
          if (status !== "idle") {
            setStage("confirm-open");
            const consent = await deps.dialog.confirm();
            // Same guard for a close that landed while the dialog was open:
            // a late answer must not overwrite terminal state or re-enter
            // the close path.
            if (closingPromise || closed) return;
            setStage("confirm-resolved");
            if (!consent) {
              blockQuit();
              return;
            }
          }
        } catch {
          // Fail closed: a status/dialog error leaves the app running and
          // names the blocking seam — unless a trusted close already ran.
          if (closingPromise || closed) return;
          blockQuit();
          return;
        }
        await grantQuit();
      })();
    }
    return confirmPromise;
  };

  return {
    handleBeforeQuit(prevent) {
      if (closed) return;
      requested = true;
      prevent();
      // Deduplicate: a repeated quit while consent is pending returns the
      // same in-flight confirmation, and one arriving mid-close waits on it
      // — the app stays live until the user answers or the close completes.
      if (!closingPromise) void confirm();
    },
    async handleSignal() {
      requested = true;
      // The trusted signal path never opens a new confirmation: it grants
      // shutdown through the serialized close path directly.
      await grantQuit();
    },
    stage: () => stage,
    quitRequested: () => requested,
    confirming: () => confirmPromise !== null,
    closed: () => closed,
  };
}

// The single admission seam for ordinary quits. Every user-facing quit
// entry point — the app menu, Cmd-Q, the dock, or a user-confirmed dialog
// that ends in app.quit() — reaches the controller only through Electron's
// before-quit event, so admission is decided exactly here and never inside
// a menu item or dialog callback.
export function createBeforeQuitHandler(deps: {
  // A quit that may legitimately proceed: the controller's completed
  // serialized cleanup re-dispatching app.quit(), or an explicit
  // startup-fatal/updater handoff. A duplicate before-quit while cleanup
  // runs must stay prevented or it would exit halfway through backend
  // cleanup.
  authorized(): boolean;
  // A handoff/consent transaction owns admission (see INSTALL_OWNED_PHASES):
  // the request is dropped, not queued — the controller never sees it.
  handoffInFlight(): boolean;
  controller: QuitController;
}): (event: { preventDefault(): void }) => void {
  return (event) => {
    if (deps.authorized() || deps.controller.closed()) return;
    event.preventDefault();
    if (deps.handoffInFlight()) return;
    deps.controller.handleBeforeQuit(() => {});
  };
}
