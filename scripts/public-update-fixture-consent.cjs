"use strict";
// CI-only fixture consent shim. Copied into the repacked/resigned fixture
// app's asar by scripts/public-update-fixture.mjs and loaded by the generated
// ci-fixture-main.cjs. Never part of the shipped application: the production
// bundle does not contain this file.
//
// The update-transaction gate drives a real packaged fixture through quit via
// a private quit file. A restored fixture's bootstrap can hold backend status
// active/unavailable when the quit lands, so the production quit controller
// correctly opens its "Cancel active work and quit?" confirmation and waits
// for a human answer. CI has no human: this module simulates exactly one user
// answer — the affirmative response — and only while a quit request consumed
// from this fixture's private quit file (validated against this instance's
// per-launch token and this process's pid) is being handled. Every other
// dialog, and any confirmation outside a validated in-flight request,
// delegates to the real implementation unchanged and stalls the gate if
// nobody answers it.

const FIXTURE_QUIT_REQUEST = "fixture-quit";
// The "Cancel Work and Quit" button index of the production confirmation.
const AFFIRMATIVE_RESPONSE = 1;

// The exact exit-work confirmation the production quit controller opens
// (desktop/main.ts confirmActiveWork). Identity is the full option shape:
// drift in any field stops the match, the dialog delegates, and the gate
// stalls rather than silently consenting to something it never verified.
const EXIT_WORK_CONFIRMATION = Object.freeze({
  type: "warning",
  message: "Cancel active work and quit?",
  detail:
    "Collection or analysis is active (or its state is unavailable). Cancellation stops child processes; saved data is preserved.",
  buttons: Object.freeze(["Keep Working", "Cancel Work and Quit"]),
  defaultId: 0,
  cancelId: 0,
  noLink: true,
});

function isExitWorkConfirmation(options) {
  return (
    options !== null &&
    typeof options === "object" &&
    options.type === EXIT_WORK_CONFIRMATION.type &&
    options.message === EXIT_WORK_CONFIRMATION.message &&
    options.detail === EXIT_WORK_CONFIRMATION.detail &&
    Array.isArray(options.buttons) &&
    options.buttons.length === 2 &&
    options.buttons[0] === EXIT_WORK_CONFIRMATION.buttons[0] &&
    options.buttons[1] === EXIT_WORK_CONFIRMATION.buttons[1] &&
    options.defaultId === EXIT_WORK_CONFIRMATION.defaultId &&
    options.cancelId === EXIT_WORK_CONFIRMATION.cancelId &&
    options.noLink === true
  );
}

// A private quit request binds to one fixture instance: the fixed request
// label, the per-launch token this process advertised through its ready
// handshake, and this process's pid. Malformed content, another launch's
// token, or another pid is not a request this fixture may act on.
function validateQuitRequest(content, identity) {
  if (typeof content !== "string") return false;
  let request;
  try {
    request = JSON.parse(content);
  } catch {
    return false;
  }
  return (
    request !== null &&
    typeof request === "object" &&
    request.request === FIXTURE_QUIT_REQUEST &&
    request.token === identity.token &&
    request.pid === identity.pid
  );
}

// Canonical request the gate writes into the private quit file. Token and pid
// come from the fixture's own ready handshake, so a request can only target
// the exact running instance that advertised them.
function fixtureQuitRequest(token, pid) {
  if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token))
    throw new Error("fixture quit request requires a per-launch token");
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("fixture quit request requires a fixture pid");
  return JSON.stringify({ request: FIXTURE_QUIT_REQUEST, token, pid });
}

// One shim instance per fixture process. `onConsent` is a best-effort bounded
// marker hook (fixture-quit-state.json); it must never throw into the dialog
// path.
function createFixtureConsent({ token, pid, onConsent }) {
  let requested = false;
  let quitStarted = false;
  let quitDone = false;
  let consented = false;
  // The consent window: a validated private request was consumed AND the quit
  // cycle it started is in flight (before-quit observed, quit not yet
  // emitted). A confirmed quit or any state outside that window reverts to
  // the real dialog.
  const armed = () => requested && quitStarted && !quitDone;
  return {
    // Returns true only for a validated private quit request.
    consume(content) {
      if (!validateQuitRequest(content, { token, pid })) return false;
      requested = true;
      return true;
    },
    beforeQuit() {
      quitStarted = true;
    },
    quit() {
      quitDone = true;
    },
    requested: () => requested,
    consented: () => consented,
    // Wraps Electron's bound dialog.showMessageBox. The single simulated
    // answer: affirmative, only for the exact exit-work confirmation while a
    // validated private quit request is in flight.
    showMessageBox(real) {
      return (...args) => {
        const options = args.length > 1 ? args[1] : args[0];
        if (armed() && isExitWorkConfirmation(options)) {
          consented = true;
          try {
            onConsent?.();
          } catch {}
          return Promise.resolve({
            response: AFFIRMATIVE_RESPONSE,
            canceled: false,
          });
        }
        return real(...args);
      };
    },
  };
}

module.exports = {
  AFFIRMATIVE_RESPONSE,
  EXIT_WORK_CONFIRMATION,
  FIXTURE_QUIT_REQUEST,
  createFixtureConsent,
  fixtureQuitRequest,
  isExitWorkConfirmation,
  validateQuitRequest,
};
