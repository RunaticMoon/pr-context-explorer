import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const script = 'distribution/release.py';
test('personal Mac CI prepares pinned native engines and exercises actual Electron launches', () => {
  for (const name of ['macos-unsigned.yml', 'macos-personal-release.yml']) {
    const workflow = readFileSync('.github/workflows/' + name, 'utf8');
    assert.match(workflow, /@openai\/codex@0\.154\.0/);
    assert.match(workflow, /@anthropic-ai\/claude-code@2\.1\.270/);
    assert.match(workflow, /npm run desktop:prepare/);
    assert.match(workflow, /npm run desktop:smoke\s/);
    assert.match(workflow, /npm run desktop:smoke:packaged/);
    assert.ok(workflow.indexOf('@openai/codex@') < workflow.indexOf('npm test'));
  }
});
test('platform guards reject Linux before calling Apple tools', () => {
  if (process.platform === 'darwin') return;
  assert.notEqual(spawnSync('bash', ['distribution/verify-macos.sh', '/tmp/Fake.app', 'ABCDEFGHIJ']).status, 0);
  const checked = spawnSync('python3', ['distribution/check-unsigned.py', '/tmp'], { encoding: 'utf8' });
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr, /Apple Silicon macOS required/);
});
test('workflow secret and publishing boundaries remain explicit', () => {
  const signed = readFileSync('.github/workflows/macos-release.yml', 'utf8');
  const unsigned = readFileSync('.github/workflows/macos-unsigned.yml', 'utf8');
  assert.match(signed, /environment: macos-release/);
  assert.match(signed, /ref: \$\{\{ github.sha \}\}/);
  assert.match(signed, /github.ref == 'refs\/heads\/main'/);
  assert.match(signed, /--publish never/);
  assert.match(unsigned, /--publish never/);
  assert.doesNotMatch(unsigned, /secrets\.|contents: write|publish-release.sh/);
  const personal = readFileSync('.github/workflows/macos-personal-release.yml', 'utf8');
  assert.match(personal, /environment: personal-release/);
  assert.match(personal, /github.repository == 'RunaticMoon\/pr-context-explorer'/);
  assert.match(personal, /ref: \$\{\{ github.sha \}\}/);
  assert.doesNotMatch(personal, /secrets\./);
  assert.match(readFileSync('distribution/publish-personal.sh', 'utf8'), /--latest=false/);
  assert.doesNotMatch(readFileSync('distribution/publish-personal.sh', 'utf8'), /latest-mac\.yml|--clobber/);
  for (const workflow of [signed, unsigned, personal]) {
    assert.doesNotMatch(workflow, /pull_request_target/);
    for (const line of workflow.split('\n').filter(x => x.includes('uses:'))) assert.match(line, /@[a-f0-9]{40} /);
    assert.match(workflow, /runs-on: macos-15/);
  }
});
test('asset manifest selects exact arm64 pair and detects tampering, extras and unsafe names', () => {
  const d = mkdtempSync(join(tmpdir(), 'release-assets-'));
  const zip = 'PR-Context-Explorer-1.2.3-arm64.zip';
  const dmg = 'PR-Context-Explorer-1.2.3-arm64.dmg';
  try {
    writeFileSync(join(d, zip), 'test zip bytes');
    writeFileSync(join(d, dmg), 'test dmg bytes');
    assert.equal(run('manifest', 'v1.2.3', d).status, 0);
    assert.equal(run('verify', 'v1.2.3', d).status, 0);
    const metadata = JSON.parse(readFileSync(join(d, 'latest-mac.yml'), 'utf8'));
    assert.equal(metadata.path, zip);
    writeFileSync(join(d, zip), 'tampered');
    assert.notEqual(run('verify', 'v1.2.3', d).status, 0);
    writeFileSync(join(d, 'other-1.2.3-arm64.zip'), 'duplicate');
    assert.notEqual(run('manifest', 'v1.2.3', d).status, 0);
    rmSync(join(d, 'other-1.2.3-arm64.zip'));
    assert.notEqual(run('manifest', 'v2.0.0', d).status, 0);
    const manifest = JSON.parse(readFileSync(join(d, 'release-manifest.json'), 'utf8'));
    manifest.assets[0].name = '../escape.zip';
    writeFileSync(join(d, 'release-manifest.json'), JSON.stringify(manifest));
    assert.notEqual(run('verify', 'v1.2.3', d).status, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
function run(...args: string[]) { return spawnSync('python3', [script, ...args], { encoding: 'utf8' }); }
test('release gate accepts stable matching version and rejects unsafe tags', () => {
  const d = mkdtempSync(join(tmpdir(), 'release-test-'));
  try {
    writeFileSync(join(d, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    assert.equal(run('version', 'v1.2.3', join(d, 'package.json')).status, 0);
    for (const tag of ['v1.2.4', 'v01.2.3', 'v1.2.3-beta', '../v1.2.3', 'v1.2.3;id']) {
      assert.notEqual(run('version', tag, join(d, 'package.json')).status, 0);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});
