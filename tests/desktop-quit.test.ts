import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as lifecycle from "../desktop/lifecycle.ts";
import {
  createQuitController,
  createBeforeQuitHandler,
  INSTALL_OWNED_PHASES,
  type QuitStage,
} from "../desktop/quit.ts";
import type { Phase } from "../desktop/public-update/index.ts";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Captures unhandled rejections so a test can prove the controller never
// leaks one — a failed quit must stay a visible fail-closed state.
function watchRejections() {
  const seen: unknown[] = [];
  const on = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", on);
  return () => {
    process.off("unhandledRejection", on);
    return seen;
  };
}

function fixture() {
  const events: string[] = [];
  const stages: QuitStage[] = [];
  const state = {
    statusValue: "idle" as "idle" | "active" | "unavailable",
    statusDelay: 0,
    statusFailures: 0,
    dialogRejects: 0,
    // Each named hook fails once while present, then succeeds — proving a
    // failed close re-arms instead of latching a rejected promise.
    hookFailures: new Set<string>(),
    holdStop: false,
    stageCbFails: false,
    // Optional behavior appended to the appQuit hook — the real app
    // authorizes the quit and re-dispatches app.quit() there.
    onAppQuit: undefined as (() => void) | undefined,
  };
  let stopRelease: (() => void) | null = null;
  const dialog = {
    calls: 0,
    resolvers: [] as ((consent: boolean) => void)[],
    confirm() {
      this.calls++;
      if (state.dialogRejects > 0) {
        state.dialogRejects--;
        return Promise.reject(Error("dialog unavailable"));
      }
      return new Promise<boolean>((r) => this.resolvers.push(r));
    },
  };
  const hook = (name: string, run: () => Promise<void>) => async () => {
    if (state.hookFailures.delete(name)) throw Error(`${name} failed`);
    await run();
  };
  const ctl = createQuitController({
    backend: {
      status: async () => {
        if (state.statusDelay) await pause(state.statusDelay);
        if (state.statusFailures > 0) {
          state.statusFailures--;
          throw Error("status unavailable");
        }
        return state.statusValue;
      },
    },
    dialog,
    hooks: {
      closeUpdates: hook("closeUpdates", async () => {
        events.push("updates");
      }),
      stopBackend: hook("stopBackend", async () => {
        if (state.holdStop) await new Promise<void>((r) => (stopRelease = r));
        events.push("backend");
      }),
      releaseProcess: hook("releaseProcess", async () => {
        events.push("release");
      }),
      appQuit: () => {
        if (state.hookFailures.delete("appQuit")) throw Error("appQuit failed");
        events.push("quit");
        state.onAppQuit?.();
      },
    },
    stageCb: (s) => {
      if (state.stageCbFails) throw Error("stage callback failed");
      stages.push(s);
    },
  });
  return {
    state,
    ctl,
    dialog,
    events,
    stages,
    releaseStop: () => stopRelease?.(),
  };
}

test("idle backend quits without a confirmation dialog", async () => {
  const f = fixture();
  let prevented = false;
  f.ctl.handleBeforeQuit(() => (prevented = true));
  assert.equal(prevented, true);
  await pause(20);
  assert.equal(f.dialog.calls, 0);
  assert.deepEqual(f.events, ["updates", "backend", "release", "quit"]);
  assert.equal(f.ctl.closed(), true);
  assert.deepEqual(f.stages, [
    "backend-status",
    "updates-closing",
    "backend-stopping",
    "quit-dispatch",
  ]);
});

test("active backend requires consent, then closes in order", async () => {
  const f = fixture();
  f.state.statusValue = "active";
  f.ctl.handleBeforeQuit(() => {});
  await pause(20);
  assert.equal(f.dialog.calls, 1);
  assert.deepEqual(f.events, []);
  f.dialog.resolvers[0](true);
  await pause(20);
  assert.deepEqual(f.events, ["updates", "backend", "release", "quit"]);
  assert.equal(f.ctl.closed(), true);
});

test("cancelled quit returns to normal and re-prompts on the next request", async () => {
  const f = fixture();
  f.state.statusValue = "active";
  f.ctl.handleBeforeQuit(() => {});
  await pause(20);
  f.dialog.resolvers[0](false);
  await pause(20);
  assert.deepEqual(f.events, []);
  assert.equal(f.ctl.closed(), false);
  assert.equal(f.ctl.stage(), "quit-blocked");
  assert.equal(f.ctl.quitRequested(), false);
  // A second quit request must re-run the confirmation, not stay latched.
  f.ctl.handleBeforeQuit(() => {});
  await pause(20);
  assert.equal(f.dialog.calls, 2);
  f.dialog.resolvers[1](true);
  await pause(20);
  assert.equal(f.ctl.closed(), true);
});

test("unavailable status fails closed into the confirmation path", async () => {
  const f = fixture();
  f.state.statusValue = "unavailable";
  f.ctl.handleBeforeQuit(() => {});
  await pause(20);
  assert.equal(f.dialog.calls, 1);
  assert.equal(f.ctl.stage(), "confirm-open");
});

test("repeated quit requests while consent is pending deduplicate — no stop or quit before an affirmative answer", async () => {
  // Ordinary repeats (a double Cmd-Q or duplicate Electron before-quit) are
  // neither consent nor proof of a signal: each is prevented, none may start
  // cleanup or stack a second dialog.
  const f = fixture();
  f.state.statusValue = "active";
  let prevented = 0;
  f.ctl.handleBeforeQuit(() => prevented++);
  await pause(20);
  assert.equal(f.ctl.stage(), "confirm-open");
  assert.equal(f.dialog.calls, 1);
  f.ctl.handleBeforeQuit(() => prevented++);
  f.ctl.handleBeforeQuit(() => prevented++);
  await pause(20);
  assert.equal(prevented, 3);
  assert.equal(f.dialog.calls, 1, "no stacked confirmation");
  assert.deepEqual(f.events, [], "no stop/quit without explicit consent");
  assert.equal(f.ctl.closed(), false);
  assert.equal(f.ctl.stage(), "confirm-open");
  // The original pending dialog still owns the decision.
  f.dialog.resolvers[0](true);
  await pause(20);
  assert.deepEqual(f.events, ["updates", "backend", "release", "quit"]);
  assert.equal(f.ctl.closed(), true);
});

test("a quit event during serialized cleanup stays held — cleanup finishes once, then quit", async () => {
  const f = fixture();
  f.state.holdStop = true;
  f.ctl.handleBeforeQuit(() => {});
  await pause(20);
  assert.deepEqual(f.events, ["updates"]);
  assert.equal(f.ctl.stage(), "backend-stopping");
  let preventedAgain = 0;
  f.ctl.handleBeforeQuit(() => preventedAgain++);
  f.ctl.handleBeforeQuit(() => preventedAgain++);
  await pause(20);
  assert.equal(
    preventedAgain,
    2,
    "mid-cleanup quit events are still prevented",
  );
  assert.deepEqual(
    f.events,
    ["updates"],
    "no re-entry and no early quit dispatch",
  );
  f.releaseStop();
  await pause(20);
  assert.deepEqual(f.events, ["updates", "backend", "release", "quit"]);
  assert.equal(f.ctl.closed(), true);
});

test("SIGTERM during a pending confirmation grants quit once; a late answer cannot overwrite terminal state", async () => {
  const f = fixture();
  f.state.statusValue = "active";
  f.ctl.handleBeforeQuit(() => {});
  await pause(20);
  assert.equal(f.dialog.calls, 1);
  assert.equal(f.ctl.stage(), "confirm-open");
  await f.ctl.handleSignal("SIGTERM");
  assert.deepEqual(f.events, ["updates", "backend", "release", "quit"]);
  assert.equal(f.ctl.closed(), true);
  assert.equal(f.ctl.stage(), "quit-dispatch");
  // The pending dialog resolves late — the user answered "Keep Working"
  // after the trusted close already ran. That must not block the completed
  // quit, rewrite the terminal stage, or run the close twice.
  f.dialog.resolvers[0](false);
  await pause(20);
  assert.equal(f.ctl.stage(), "quit-dispatch");
  assert.equal(f.ctl.closed(), true);
  assert.deepEqual(f.events, ["updates", "backend", "release", "quit"]);
});

test("a trusted signal with no prior quit request closes without any dialog", async () => {
  const f = fixture();
  f.state.statusValue = "active";
  await f.ctl.handleSignal("SIGINT");
  assert.equal(f.dialog.calls, 0, "the signal path never opens a confirmation");
  assert.deepEqual(f.events, ["updates", "backend", "release", "quit"]);
  assert.equal(f.ctl.closed(), true);
});

test("SIGTERM while the status probe is in flight skips the dialog", async () => {
  const f = fixture();
  f.state.statusValue = "active";
  f.state.statusDelay = 200;
  f.ctl.handleBeforeQuit(() => {});
  await pause(20);
  assert.equal(f.ctl.stage(), "backend-status");
  await f.ctl.handleSignal("SIGTERM");
  assert.equal(f.ctl.closed(), true);
  // The late status resolution must not open a dialog or re-enter the close.
  await pause(300);
  assert.equal(f.dialog.calls, 0);
  assert.equal(f.events.filter((e) => e === "quit").length, 1);
});

test("signals and quit events during closing never run cleanup twice", async () => {
  const f = fixture();
  f.state.holdStop = true;
  f.ctl.handleBeforeQuit(() => {});
  await pause(20);
  const s1 = f.ctl.handleSignal("SIGTERM");
  const s2 = f.ctl.handleSignal("SIGINT");
  f.ctl.handleBeforeQuit(() => {});
  await pause(20);
  assert.deepEqual(f.events, ["updates"]);
  f.releaseStop();
  await Promise.all([s1, s2]);
  await pause(20);
  assert.deepEqual(f.events, ["updates", "backend", "release", "quit"]);
});

test("a status() failure fails closed, stays live, and re-arms without an unhandled rejection", async () => {
  const rejections = watchRejections();
  try {
    const f = fixture();
    f.state.statusFailures = 1;
    f.ctl.handleBeforeQuit(() => {});
    await pause(20);
    assert.equal(f.ctl.stage(), "quit-blocked");
    assert.equal(f.ctl.closed(), false);
    assert.equal(f.dialog.calls, 0);
    assert.deepEqual(f.events, []);
    f.ctl.handleBeforeQuit(() => {});
    await pause(20);
    assert.equal(f.ctl.closed(), true);
    assert.deepEqual(f.events, ["updates", "backend", "release", "quit"]);
  } finally {
    await pause(20);
    assert.deepEqual(rejections(), []);
  }
});

test("a dialog rejection fails closed, stays live, and re-arms", async () => {
  const rejections = watchRejections();
  try {
    const f = fixture();
    f.state.statusValue = "active";
    f.state.dialogRejects = 1;
    f.ctl.handleBeforeQuit(() => {});
    await pause(20);
    assert.equal(f.dialog.calls, 1);
    assert.equal(f.ctl.stage(), "quit-blocked");
    assert.equal(f.ctl.closed(), false);
    assert.deepEqual(f.events, []);
    f.ctl.handleBeforeQuit(() => {});
    await pause(20);
    assert.equal(f.dialog.calls, 2);
    f.dialog.resolvers[0](true);
    await pause(20);
    assert.equal(f.ctl.closed(), true);
  } finally {
    await pause(20);
    assert.deepEqual(rejections(), []);
  }
});

for (const failing of [
  "closeUpdates",
  "stopBackend",
  "releaseProcess",
  "appQuit",
] as const) {
  test(`a ${failing} failure fails closed, stays retryable, and never rejects unhandled`, async () => {
    const rejections = watchRejections();
    try {
      const f = fixture();
      f.state.hookFailures.add(failing);
      f.ctl.handleBeforeQuit(() => {});
      await pause(20);
      assert.equal(f.ctl.closed(), false);
      assert.equal(f.ctl.stage(), "quit-blocked");
      assert.equal(
        f.events.includes("quit"),
        false,
        "a failed close never dispatches quit",
      );
      // No stale confirm/closing latch: the next request retries the whole
      // serialized close and succeeds once the hook recovers.
      f.ctl.handleBeforeQuit(() => {});
      await pause(20);
      assert.equal(f.ctl.closed(), true);
      assert.equal(f.events.at(-1), "quit");
    } finally {
      await pause(20);
      assert.deepEqual(rejections(), []);
    }
  });
}

test("a throwing stage callback is best-effort and never aborts the close", async () => {
  const f = fixture();
  f.state.stageCbFails = true;
  f.ctl.handleBeforeQuit(() => {});
  await pause(20);
  assert.equal(f.ctl.closed(), true);
  assert.equal(f.ctl.stage(), "quit-dispatch");
  assert.deepEqual(f.events, ["updates", "backend", "release", "quit"]);
});

test("backend IPC status reports idle/active/unavailable over a real child", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "prce-quitstatus-"));
  const entry = path.join(root, "worker.cjs");
  writeFileSync(
    entry,
    `const fs=require('node:fs');process.on('message',m=>{if(m.type==='start')process.send({type:'ready',origin:'http://127.0.0.1:12345'});if(m.type==='status')process.send({type:'status',id:m.id,active:fs.existsSync(${JSON.stringify(path.join(root, "busy"))})});if(m.type==='shutdown')process.exit(0)});`,
  );
  const backend = new lifecycle.BackendProcess({
    node: process.execPath,
    entry,
    runtime: root,
    data: root,
    dist: root,
  });
  try {
    assert.equal(await backend.start(), "http://127.0.0.1:12345");
    assert.equal(await backend.status(), "idle");
    assert.equal(await backend.active(), false);
    writeFileSync(path.join(root, "busy"), "1");
    assert.equal(await backend.status(), "active");
    assert.equal(await backend.active(), true);
    await backend.stop();
    assert.equal(await backend.status(), "unavailable");
    assert.equal(await backend.active(), true);
  } finally {
    await backend.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller drives a real IPC backend through the full close path", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "prce-quitctl-"));
  const entry = path.join(root, "worker.cjs");
  writeFileSync(
    entry,
    `process.on('message',m=>{if(m.type==='start')process.send({type:'ready',origin:'http://127.0.0.1:12345'});if(m.type==='status')process.send({type:'status',id:m.id,active:true});if(m.type==='shutdown')process.exit(0)});`,
  );
  const backend = new lifecycle.BackendProcess({
    node: process.execPath,
    entry,
    runtime: root,
    data: root,
    dist: root,
  });
  try {
    await backend.start();
    const dialog = {
      calls: 0,
      confirm() {
        this.calls++;
        return Promise.resolve(true);
      },
    };
    const events: string[] = [];
    const ctl = createQuitController({
      backend,
      dialog,
      hooks: {
        closeUpdates: async () => {
          events.push("updates");
        },
        stopBackend: () => backend.stop(),
        releaseProcess: async () => {
          events.push("release");
        },
        appQuit: () => {
          events.push("quit");
        },
      },
    });
    let prevented = false;
    ctl.handleBeforeQuit(() => (prevented = true));
    assert.equal(prevented, true);
    for (let i = 0; i < 100 && !ctl.closed(); i++) await pause(20);
    assert.equal(ctl.closed(), true);
    assert.equal(dialog.calls, 1);
    assert.deepEqual(events, ["updates", "release", "quit"]);
    assert.throws(() => process.kill(backend.pid!, 0));
  } finally {
    await backend.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

// An honest miniature of the Electron quit contract main.ts is wired
// against: app.quit() synchronously raises "before-quit" on every listener
// and the process exits only when no listener prevented the event. The
// confirmed "Quit for External Update…" menu item ends in exactly this
// call, so the real before-quit handler, controller and hooks run inside
// the model — only the event dispatch itself is re-created, never the
// admission logic.
function electronApp() {
  const listeners: ((event: { preventDefault(): void }) => void)[] = [];
  let exits = 0;
  return {
    on(
      _event: "before-quit",
      listener: (event: { preventDefault(): void }) => void,
    ) {
      listeners.push(listener);
    },
    quit() {
      let prevented = false;
      const event = {
        preventDefault: () => {
          prevented = true;
        },
      };
      for (const listener of [...listeners]) listener(event);
      if (!prevented) exits++;
    },
    exits: () => exits,
  };
}

// Wires the REAL admission seam the app registers: the exported
// createBeforeQuitHandler over a fake public-update state, whose phases are
// driven by name through the same INSTALL_OWNED_PHASES set the app consults.
// The appQuit hook mirrors main.ts: controller.closed() authorizes re-dispatch.
function admissionFixture() {
  const f = fixture();
  const app = electronApp();
  const update: { operation: boolean; phase: Phase } = {
    operation: false,
    phase: "idle",
  };
  app.on(
    "before-quit",
    createBeforeQuitHandler({
      authorized: () => false,
      handoffInFlight: () =>
        update.operation && INSTALL_OWNED_PHASES.has(update.phase),
      controller: f.ctl,
    }),
  );
  f.state.onAppQuit = () => {
    app.quit();
  };
  return { f, app, update };
}

test("failed final app.quit does not authorize a later active-session quit", async () => {
  const { f, app } = admissionFixture();
  const requestQuit = app.quit.bind(app);
  app.quit = () => { throw Error("simulated final dispatch failure"); };
  requestQuit();
  for (let i = 0; i < 100 && f.ctl.stage() !== "quit-blocked"; i++) await pause(10);
  assert.equal(f.ctl.stage(), "quit-blocked");
  assert.equal(f.ctl.closed(), false);
  app.quit = requestQuit;
  f.state.statusValue = "active";
  requestQuit();
  for (let i = 0; i < 100 && f.dialog.calls === 0 && app.exits() === 0; i++) await pause(10);
  assert.equal(app.exits(), 0, "failed dispatch must not leave quit authorization latched");
  assert.equal(f.dialog.calls, 1);
  f.dialog.resolvers.shift()!(false);
  await pause(20);
  assert.equal(app.exits(), 0);
});

test("a menu-routed quit is ignored entirely while an install transaction owns admission", async () => {
  // L1 regression: "Quit for External Update…" used to call the controller
  // directly, so a user-confirmed quit during an install-owned phase tore
  // down the prepared transaction. Routed through app.quit(), the same
  // request must be dropped before the controller ever sees it.
  const { f, app, update } = admissionFixture();
  update.operation = true;
  for (const phase of ["downloaded", "preparing", "ready"] as const) {
    update.phase = phase;
    app.quit();
    await pause(20);
    assert.equal(app.exits(), 0, `quit during ${phase} must not exit`);
    assert.equal(
      f.ctl.quitRequested(),
      false,
      `${phase}: the controller must never see the request`,
    );
    assert.equal(f.dialog.calls, 0, `${phase}: no dialog opens`);
    assert.deepEqual(f.events, [], `${phase}: no cleanup runs`);
    assert.equal(f.ctl.stage(), "before-quit");
  }
});

test("a menu-routed quit is still admitted during update network phases", async () => {
  // Only install-owned phases hold admission: an in-flight download is
  // cancellable work, so the quit runs the normal guarded path to exit.
  const { f, app, update } = admissionFixture();
  update.operation = true;
  update.phase = "downloading";
  app.quit();
  for (let i = 0; i < 100 && app.exits() === 0; i++) await pause(10);
  assert.equal(f.ctl.closed(), true);
  assert.equal(app.exits(), 1);
  assert.deepEqual(f.events, ["updates", "backend", "release", "quit"]);
});

test("once the install transaction ends, the same menu-routed quit runs the guarded path and exits", async () => {
  const { f, app, update } = admissionFixture();
  update.operation = true;
  update.phase = "preparing";
  app.quit();
  await pause(20);
  assert.equal(f.ctl.quitRequested(), false, "the handoff-phase quit was dropped");
  assert.equal(app.exits(), 0);
  // The transaction completing re-admits ordinary quits with no stale latch.
  update.operation = false;
  update.phase = "idle";
  app.quit();
  for (let i = 0; i < 100 && app.exits() === 0; i++) await pause(10);
  assert.equal(f.ctl.closed(), true);
  assert.equal(app.exits(), 1, "only the authorized re-dispatch may exit");
  assert.equal(f.dialog.calls, 0, "idle status needs no confirmation");
  assert.deepEqual(f.events, ["updates", "backend", "release", "quit"]);
});

test("a menu-routed quit in a normal idle session is admitted and exits once", async () => {
  const { f, app } = admissionFixture();
  app.quit();
  for (let i = 0; i < 100 && app.exits() === 0; i++) await pause(10);
  assert.equal(f.ctl.closed(), true);
  assert.equal(app.exits(), 1);
  assert.equal(f.dialog.calls, 0);
  assert.deepEqual(f.events, ["updates", "backend", "release", "quit"]);
});

test("repeated menu-routed quits during the serialized close stay held — a single exit", async () => {
  const { f, app } = admissionFixture();
  f.state.holdStop = true;
  app.quit();
  await pause(20);
  assert.deepEqual(f.events, ["updates"]);
  assert.equal(f.ctl.stage(), "backend-stopping");
  app.quit();
  app.quit();
  await pause(20);
  assert.equal(app.exits(), 0, "mid-close quits must stay prevented");
  assert.deepEqual(f.events, ["updates"], "no re-entry into the close");
  f.releaseStop();
  for (let i = 0; i < 100 && app.exits() === 0; i++) await pause(10);
  assert.equal(app.exits(), 1);
  assert.deepEqual(f.events, ["updates", "backend", "release", "quit"]);
});
