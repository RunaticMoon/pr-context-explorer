/** Mac-only installed-app review driver. No production flags or auth overrides. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, existsSync, readFileSync, writeFileSync, lstatSync, openSync, closeSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

assert.equal(process.platform, 'darwin', 'Actual macOS is required');
assert.equal(process.arch, 'arm64', 'Apple Silicon is required');
process.umask(0o077);
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const stateDir = path.join(root, '.review');
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const stateFile = path.join(stateDir, 'state.json');
const after = path.join(root, 'after');
const require = createRequire(path.join(after, 'package.json'));
const { chromium } = require('playwright');
const { identity, sameIdentity } = await import(pathToFileURL(path.join(after, 'desktop/smoke-helpers.mjs')));
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile)) : { root };
assert.equal(state.root, root, 'Review state belongs to another run');
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
const [action, argument, extra] = process.argv.slice(2);
const appFor = phase => path.join(root, 'Applications', phase, 'PR Context Explorer.app');
const accountHome = execFileSync('/usr/bin/python3', ['-c', 'import os,pwd;print(pwd.getpwuid(os.getuid()).pw_dir)'], { encoding: 'utf8', timeout: 5000 }).trim();
const reviewHome = path.join(stateDir, 'home');
const env = { HOME: reviewHome, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
const dataPaths = [...new Set([accountHome, reviewHome])].map(home => path.join(home, 'Library/Application Support/PR Context Explorer'));
function verifyData() {
  assert.ok(state.data, 'Fresh-account fixture preparation must complete');
  for (const p of dataPaths) {
    const st = lstatSync(p), owned = state.data[p];
    assert.ok(owned && st.isDirectory() && !st.isSymbolicLink() && st.ino === owned.ino && st.dev === owned.dev && st.uid === process.getuid(), 'App data changed identity; preserved');
  }
}
async function initializeData() {
  if (state.data) { verifyData(); return; }
  for (const p of dataPaths) assert.ok(!existsSync(p), 'Fresh Mac account required; existing PRCE app data is preserved');
  mkdirSync(reviewHome, { recursive: true, mode: 0o700 });
  state.data = {};
  // Electron may resolve appData using the account database instead of HOME.
  // Both destinations must be absent. Each becomes this disposable run's data.
  for (const p of dataPaths) {
    mkdirSync(p, { recursive: true, mode: 0o700 });
    const st = lstatSync(p);
    state.data[p] = { ino: st.ino, dev: st.dev };
    writeFileSync(path.join(p, 'preferences.json'), JSON.stringify({ autoCheck: false, autoDownload: false }), { mode: 0o600 });
  }
  save();
  for (const p of dataPaths) {
    const output = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/ux-fixture.ts', path.join(p, 'live')], { cwd: after, env: { ...env, PATH: `${path.dirname(process.execPath)}:${env.PATH}` }, encoding: 'utf8', timeout: 90000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] });
    const fixtures = JSON.parse(output);
    state.fixtures = fixtures;
  }
  state.fixtureReady = true;
  save();
}
function ownedApp() {
  assert.ok(state.app && sameIdentity(state.app, identity(state.app.pid)), 'Owned review process is absent or changed');
  return state.app;
}
async function connect() {
  ownedApp();
  const browser = await chromium.connectOverCDP(state.endpoint, { timeout: 15000 });
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 15000 });
  await page.waitForFunction(() => typeof window.prceDesktop?.status === 'function', undefined, { timeout: 30000 });
  return { browser, page };
}
async function start(phase) {
  assert.ok(['before', 'after'].includes(phase), 'Expected before or after');
  if (state.app && identity(state.app.pid)) throw Error('Stop the owned app before switching versions');
  await initializeData();
  assert.equal(state.fixtureReady, true, 'Fixture preparation incomplete; preserve data and inspect');
  const executable = path.join(appFor(phase), 'Contents/MacOS/PR Context Explorer');
  assert.ok(existsSync(executable), 'Build and install this phase first');
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appFor(phase)], { timeout: 30000, stdio: 'pipe' });
  const logPath = path.join(stateDir, `${phase}-launch.log`);
  const log = openSync(logPath, 'w', 0o600);
  const child = spawn(executable, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], { cwd: root, env, detached: true, stdio: ['ignore', log, log] });
  closeSync(log);
  child.unref();
  for (let i = 0; i < 100; i++) {
    state.app = identity(child.pid);
    if (state.app) break;
    await pause(50);
  }
  assert.ok(state.app && state.app.command.startsWith(executable), 'Installed executable identity not established');
  state.phase = phase;
  state.executable = executable;
  save();
  for (let i = 0; i < 200; i++) {
    ownedApp();
    const match = readFileSync(logPath, 'utf8').match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
    if (match) { state.endpoint = match[1]; save(); break; }
    await pause(150);
  }
  assert.ok(state.endpoint, 'No local inspector endpoint; inspect the run instead of relaunching');
  const { page } = await connect();
  // This fresh run owns all browser data. Avoid a baseline reading position
  // making the after app reopen the final commit instead of its entry screen.
  await page.evaluate(() => localStorage.clear());
  await page.getByRole('button', { name: '내 PR / URL 열기', exact: true }).click();
  await page.getByText('ux-fixture/small', { exact: false }).first().waitFor({ timeout: 20000 });
  for (const p of dataPaths) {
    const marker = path.join(p, 'desktop-runtime.json');
    if (!existsSync(marker)) continue;
    const m = JSON.parse(readFileSync(marker));
    assert.equal(m.pid, state.app.pid);
    assert.equal(m.executable, executable);
    state.backend = identity(m.backendPid);
    assert.ok(state.backend && state.backend.parent === state.app.pid && state.backend.command.startsWith(path.join(appFor(phase), 'Contents/Resources/node/bin/node')), 'Bundled backend identity not established');
    state.activeData = p;
  }
  assert.ok(state.activeData && state.backend, 'Installed runtime provenance missing');
  save();
  console.log(JSON.stringify({ installedApp: phase, appPid: state.app.pid, backendPid: state.backend.pid, fixture: 'synthetic only', route: 'saved PR list', sourceManifest: 'source-manifest.json' }));
}
async function stop() {
  ownedApp();
  execFileSync('/usr/bin/osascript', ['-e', `tell application ${JSON.stringify(appFor(state.phase))} to quit`], { timeout: 20000, stdio: 'pipe' });
  for (let i = 0; i < 150; i++) {
    if (!identity(state.app.pid) && !identity(state.backend?.pid)) {
      delete state.app; delete state.backend; delete state.endpoint; delete state.activeData; save();
      console.log(JSON.stringify({ stopped: state.phase, appData: 'preserved for comparison' })); return;
    }
    await pause(100);
  }
  throw Error('Owned app/backend did not quit; no forced deletion or replacement performed');
}
if (action === 'start') await start(argument);
else if (action === 'stop') await stop();
else {
  const { page } = await connect();
  if (action === 'open') {
    assert.ok(['small', 'long'].includes(argument));
    await page.getByRole('button', { name: '내 PR / URL 열기', exact: true }).click();
    await page.locator('.pr-card').filter({ hasText: `ux-fixture/${argument}` }).getByRole('button', { name: '고정 버전 열기 / 이어보기', exact: true }).click();
    // Both versions render the commit rail; after keeps it hidden during overview.
    await page.locator('.commit-flow').waitFor();
    await page.waitForFunction(() => !!document.querySelector('[data-testid="pr-overview"], [data-testid="commit-review"]'));
    const overviewReturn = page.getByRole('button', { name: 'PR 전체 맥락으로 돌아가기', exact: true });
    if (await overviewReturn.isVisible()) await overviewReturn.click();
  } else if (action === 'phase') {
    assert.match(argument || '', /^\d+$/);
    const overview = page.locator('.overview-commits');
    if (await overview.isVisible()) await overview.locator('button').nth(Number(argument) - 1).click();
    else await page.locator('.commit-timeline').getByRole('button', { name: `Phase ${argument}`, exact: true }).click();
  } else if (action === 'resize') {
    const width = Number(argument), height = Number(extra);
    assert.ok(width >= 960 && width <= 1800 && height >= 640 && height <= 1100);
    execFileSync('/usr/bin/osascript', ['-e', `tell application "System Events"\nset p to first process whose unix id is ${ownedApp().pid}\nset frontmost of p to true\nset position of window 1 of p to {0, 25}\nset size of window 1 of p to {${width}, ${height}}\nreturn size of window 1 of p\nend tell`], { timeout: 15000, stdio: 'pipe' });
  } else if (action !== 'inspect') throw Error('Expected start|stop|open|phase|resize|inspect');
  await pause(300);
  console.log(JSON.stringify({ phase: state.phase, action, fixture: 'synthetic only', route: new URL(page.url()).search, viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth })), selected: await page.locator('[aria-pressed="true"]').allTextContents() }));
}
// Disconnect this short-lived inspector client. The separately owned installed
// app remains available for Maclab screenshots and manual pointer/key actions.
process.exit(0);
