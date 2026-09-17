// Portable tests for the CI-only fixture consent shim. The shim lives ONLY
// inside the repacked/resigned fixture app (never the shipped bundle) and
// simulates a single user answer — the affirmative response to the exact
// exit-work confirmation — while a quit request validated against the
// fixture's own private quit file, per-launch token, and pid is in flight.
// Everything else must delegate to the real dialog unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import {
  writeFixtureShim,
  FIXTURE_CONSENT_MODULE,
  FIXTURE_QUIT_STATE,
} from "../scripts/public-update-fixture.mjs";

const require = createRequire(import.meta.url);
const consent = require("../scripts/public-update-fixture-consent.cjs");

const IDENTITY = { token: "a".repeat(32), pid: 4242 };
const exactOptions = () => ({
  ...consent.EXIT_WORK_CONFIRMATION,
  buttons: [...consent.EXIT_WORK_CONFIRMATION.buttons],
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function pollJson(file: string, pred: (v: any) => boolean, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const v = JSON.parse(await readFile(file, "utf8"));
      if (pred(v)) return v;
    } catch {}
    if (Date.now() >= deadline)
      throw new Error(`timed out waiting for ${path.basename(file)}`);
    await pause(50);
  }
}

test("exit-work confirmation matches only the exact production dialog shape", () => {
  assert.ok(consent.isExitWorkConfirmation(exactOptions()));
  assert.ok(
    consent.isExitWorkConfirmation({
      ...exactOptions(),
      title: "extra fields are ignored",
    }),
  );
  const drifts: unknown[] = [
    null,
    "Cancel active work and quit?",
    { ...exactOptions(), message: "Quit anyway?" },
    { ...exactOptions(), type: "question" },
    { ...exactOptions(), buttons: ["Cancel Work and Quit", "Keep Working"] },
    { ...exactOptions(), buttons: ["Keep Working"] },
    { ...exactOptions(), detail: "Different detail." },
    { ...exactOptions(), defaultId: 1 },
    { ...exactOptions(), cancelId: 1 },
    { ...exactOptions(), noLink: false },
  ];
  for (const options of drifts)
    assert.equal(
      consent.isExitWorkConfirmation(options),
      false,
      JSON.stringify(options),
    );
});

test("private quit request binds to the fixture token and pid only", () => {
  const content = consent.fixtureQuitRequest(IDENTITY.token, IDENTITY.pid);
  assert.ok(consent.validateQuitRequest(content, IDENTITY));
  for (const wrong of [
    consent.fixtureQuitRequest("b".repeat(32), IDENTITY.pid),
    consent.fixtureQuitRequest(IDENTITY.token, IDENTITY.pid + 1),
    "quit",
    "quit fixture through Electron app.quit()",
    "not json",
    "{}",
    JSON.stringify({ request: "other", token: IDENTITY.token, pid: 4242 }),
    JSON.stringify({ request: "fixture-quit", pid: 4242 }),
  ])
    assert.equal(
      consent.validateQuitRequest(wrong, IDENTITY),
      false,
      String(wrong),
    );
  assert.equal(consent.validateQuitRequest(null, IDENTITY), false);
  assert.throws(() => consent.fixtureQuitRequest("not-a-token", 1));
  assert.throws(() => consent.fixtureQuitRequest(IDENTITY.token, -1));
});

test("explicit consent requires a validated in-flight request and the exact dialog", async () => {
  let marks = 0;
  const realCalls: unknown[][] = [];
  const shim = consent.createFixtureConsent({
    ...IDENTITY,
    onConsent: () => marks++,
  });
  const wrapped = shim.showMessageBox(async (...args: unknown[]) => {
    realCalls.push(args);
    return { response: 0, canceled: false };
  });
  const win = { window: true };

  // No request consumed: the exact dialog delegates unchanged.
  assert.equal((await wrapped(win, exactOptions())).response, 0);
  assert.equal(realCalls.length, 1);

  // Wrong identity is not a request: still delegates.
  assert.equal(shim.consume(consent.fixtureQuitRequest("c".repeat(32), 4242)), false);
  assert.equal((await wrapped(win, exactOptions())).response, 0);
  assert.equal(realCalls.length, 2);

  // Validated request but quit cycle not yet entered: still delegates.
  assert.ok(
    shim.consume(consent.fixtureQuitRequest(IDENTITY.token, IDENTITY.pid)),
  );
  assert.ok(shim.requested());
  assert.equal((await wrapped(win, exactOptions())).response, 0);
  assert.equal(realCalls.length, 3);

  // Inside the quit cycle the validated request started: explicit consent.
  shim.beforeQuit();
  const answer = await wrapped(win, exactOptions());
  assert.equal(answer.response, 1);
  assert.equal(answer.canceled, false);
  assert.equal(realCalls.length, 3);
  assert.equal(marks, 1);
  assert.ok(shim.consented());

  // After the quit completed nothing stays armed: delegates again.
  shim.quit();
  assert.equal((await wrapped(win, exactOptions())).response, 0);
  assert.equal(realCalls.length, 4);
});

test("an unrelated dialog never receives the simulated answer, even armed", async () => {
  const realCalls: unknown[][] = [];
  const shim = consent.createFixtureConsent({ ...IDENTITY });
  const wrapped = shim.showMessageBox(async (...args: unknown[]) => {
    realCalls.push(args);
    return { response: 0, canceled: false };
  });
  assert.ok(
    shim.consume(consent.fixtureQuitRequest(IDENTITY.token, IDENTITY.pid)),
  );
  shim.beforeQuit();
  for (const options of [
    { type: "info", message: "Unable to Start", buttons: ["OK"] },
    { type: "question", message: "버전 설치 후 재시작할까요?", buttons: ["나중에", "설치 및 재시작"] },
    { ...exactOptions(), message: "Cancel active work and quit? " },
  ]) {
    assert.equal((await wrapped(options)).response, 0);
  }
  assert.equal(realCalls.length, 3);
  assert.equal(shim.consented(), false);
});

// The real generated fixture main, loaded with a stub Electron and a stub
// production main that reproduces the quit contract: prevent the first
// before-quit and open the exit-work confirmation; an affirmative answer
// re-dispatches app.quit() through the authorized path.
async function stagedFixture(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fixture-consent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const userData = path.join(dir, "userData");
  await mkdir(userData, { recursive: true });
  const readyFile = path.join(dir, "fixture-window-ready.json");
  const quitFile = path.join(dir, "fixture-quit");
  await writeFixtureShim({
    directory: dir,
    readyFile,
    quitFile,
    original: "./stub-main.cjs",
  });
  assert.ok(
    existsSync(path.join(dir, FIXTURE_CONSENT_MODULE)),
    "repacked fixture must bundle the consent module",
  );
  const electronDir = path.join(dir, "node_modules", "electron");
  await mkdir(electronDir, { recursive: true });
  await writeFile(
    path.join(electronDir, "package.json"),
    JSON.stringify({ name: "electron", version: "0.0.0", main: "index.js" }),
  );
  await writeFile(
    path.join(electronDir, "index.js"),
    `const calls=[];const listeners={};const state={exited:false};
const app={
  on:(e,cb)=>{(listeners[e]||(listeners[e]=[])).push(cb)},
  emit:(e,...a)=>{for(const cb of listeners[e]||[])cb(...a)},
  getPath:()=>${JSON.stringify(userData)},
  getVersion:()=>"0.5.99",
  isPackaged:true,
  quit(){
    const ev={defaultPrevented:false,preventDefault(){this.defaultPrevented=true}};
    for(const cb of listeners['before-quit']||[])cb(ev);
    if(ev.defaultPrevented)return;
    for(const cb of listeners['will-quit']||[])cb(ev);
    state.exited=true;
    for(const cb of listeners['quit']||[])cb();
  },
};
const dialog={showMessageBox:(...args)=>{calls.push(args);return Promise.resolve({response:0,canceled:false})}};
module.exports={app,dialog,__calls:calls,__state:state};
`,
  );
  // The options below intentionally duplicate the production literals from
  // desktop/main.ts confirmActiveWork — not the helper constant — so drift on
  // either side fails closed instead of silently agreeing.
  await writeFile(
    path.join(dir, "stub-main.cjs"),
    `const {app,dialog}=require('electron');
const OPTIONS={type:'warning',message:'Cancel active work and quit?',detail:'Collection or analysis is active (or its state is unavailable). Cancellation stops child processes; saved data is preserved.',buttons:['Keep Working','Cancel Work and Quit'],defaultId:0,cancelId:0,noLink:true};
let closed=false;
app.on('before-quit',(event)=>{
  if(closed)return;
  event.preventDefault();
  void dialog.showMessageBox({window:true},OPTIONS).then((answer)=>{
    if(answer.response===1){closed=true;app.quit()}
  });
});
`,
  );
  const req = createRequire(path.join(dir, "ci-fixture-main.cjs"));
  const electron = req("electron");
  req("./ci-fixture-main.cjs");
  return {
    dir,
    userData,
    readyFile,
    quitFile,
    electron,
    stateFile: path.join(dir, FIXTURE_QUIT_STATE),
  };
}

test("generated fixture shim: a bound private quit request gets explicit consent", async (t) => {
  const f = await stagedFixture(t);
  await writeFile(
    path.join(f.userData, "desktop-runtime.json"),
    JSON.stringify({ pid: process.pid, ready: true }),
    { mode: 0o600 },
  );
  const win = {
    isDestroyed: () => false,
    isVisible: () => true,
    webContents: {
      isLoading: () => false,
      getURL: () => "http://127.0.0.1:4173/",
    },
  };
  f.electron.app.emit("browser-window-created", {}, win);
  const ready = await pollJson(f.readyFile, (v) => v?.ready === true);
  assert.equal(ready.pid, process.pid);
  assert.equal(ready.version, "0.5.99");
  assert.match(ready.quitToken, /^[0-9a-f]{32}$/);

  // An unrelated dialog before any request delegates to the real impl.
  const early = await f.electron.dialog.showMessageBox({
    type: "info",
    message: "Other",
  });
  assert.equal(early.response, 0);
  assert.equal(f.electron.__calls.length, 1);

  await writeFile(
    f.quitFile,
    consent.fixtureQuitRequest(ready.quitToken, ready.pid),
    { mode: 0o600 },
  );
  const state = await pollJson(f.stateFile, (v) => v?.quit === true);
  assert.deepEqual(
    {
      consumed: state.consumed,
      requested: state.requested,
      called: state.called,
      beforeQuit: state.beforeQuit,
      willQuit: state.willQuit,
      quit: state.quit,
      consent: state.consent,
    },
    {
      consumed: true,
      requested: true,
      called: true,
      beforeQuit: true,
      willQuit: true,
      quit: true,
      consent: true,
    },
  );
  assert.equal(f.electron.__state.exited, true);
  // The simulated answer never reached the real dialog implementation.
  assert.equal(f.electron.__calls.length, 1);
});

test("generated fixture shim: no private request, no consent", async (t) => {
  const f = await stagedFixture(t);
  // A quit that did not come through the fixture quit file must not be
  // consented: the exact dialog reaches the real implementation and a
  // decline keeps the app live.
  f.electron.app.quit();
  await pause(150);
  assert.equal(f.electron.__calls.length, 1);
  assert.equal(f.electron.__state.exited, false);
  const state = await pollJson(f.stateFile, (v) => v?.beforeQuit === true);
  assert.equal(state.requested, false);
  assert.equal(state.consent, false);
  assert.equal(state.willQuit, false);
  assert.equal(state.quit, false);
});

test("generated fixture shim: a quit file bound to another identity is inert", async (t) => {
  const f = await stagedFixture(t);
  // Same request shape, wrong token — consumed but never acted on.
  await writeFile(
    f.quitFile,
    consent.fixtureQuitRequest("f".repeat(32), process.pid),
    { mode: 0o600 },
  );
  const consumed = await pollJson(f.stateFile, (v) => v?.consumed === true);
  assert.equal(consumed.requested, false);
  assert.equal(consumed.called, false);
  assert.equal(f.electron.__state.exited, false);
  // And nothing armed: a following ordinary quit still delegates.
  f.electron.app.quit();
  await pause(150);
  assert.equal(f.electron.__calls.length, 1);
  assert.equal(f.electron.__state.exited, false);
  const state = await pollJson(f.stateFile, (v) => v?.beforeQuit === true);
  assert.equal(state.consent, false);
});

test("the consent contract stays pinned to production and out of shipped code", () => {
  const main = readFileSync("desktop/main.ts", "utf8").replace(/\s/g, "");
  for (const needle of [
    '"Cancel active work and quit?"',
    '"Keep Working", "Cancel Work and Quit"',
    "answer.response === 1",
    "dialog.showMessageBox(win, options)",
  ])
    assert.ok(
      main.includes(needle.replace(/\s/g, "")),
      `production exit-work dialog drifted: ${needle}`,
    );
  // Production code must never reference the fixture-only module; the shim
  // exists only inside the repacked fixture asar.
  for (const shipped of ["desktop/main.ts", "desktop/quit.ts"])
    assert.ok(!readFileSync(shipped, "utf8").includes(FIXTURE_CONSENT_MODULE));
  const fixtureSource = readFileSync(
    "scripts/public-update-fixture.mjs",
    "utf8",
  );
  assert.ok(fixtureSource.includes(FIXTURE_CONSENT_MODULE));
});
