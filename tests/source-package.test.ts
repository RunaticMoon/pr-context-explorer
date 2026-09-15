import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.resolve('scripts/package-source.py');
test('source packaging refuses symlink source escapes before creating an archive', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'prce-release-link-'));
  try {
    const root = path.join(dir, 'app');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{}');
    const outside = path.join(dir, 'outside.ts');
    writeFileSync(outside, 'SYNTHETIC_PRIVATE_CONTENT');
    symlinkSync(outside, path.join(root, 'src', 'escape.ts'));
    const out = path.join(dir, 'release.zip');
    const packed = spawnSync('python3', [script, '--root', root, '--output', out], { encoding: 'utf8' });
    assert.notEqual(packed.status, 0, 'symlink source must be refused');
    assert.equal(existsSync(out), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('source archive uses an explicit allowlist and verified content manifest, not runtime/auth/cache directories', () => {
  assert.ok(existsSync(script), 'source packaging implementation is required');
  const dir = mkdtempSync(path.join(tmpdir(), 'prce-release-test-'));
  try {
    const root = path.join(dir, 'app');
    mkdirSync(root);
    for (const [file, content] of Object.entries({
      'package.json': '{"name":"pr-context-explorer","version":"test"}',
      'package-lock.json': '{}',
      'README.md': 'SOURCE DOCUMENTATION',
      '.gitignore': '.data/',
      '.env': 'SYNTHETIC_SECRET_NOT_TO_PACKAGE',
      'src/main.ts': 'export const source = true;',
      'docs/guide.md': 'guide',
      'scripts/setup.py': 'print("setup")',
      'tests/app.test.ts': '// application test',
      'src/.env': 'SYNTHETIC_SECRET_NOT_TO_PACKAGE',
      '.tools/engine': 'BINARY_NOT_TO_PACKAGE',
      '.data/fixture/source.ts': 'TARGET_SOURCE_NOT_TO_PACKAGE',
      'node_modules/x/package.json': '{}',
      'artifacts/auth.json': 'SYNTHETIC_SECRET_NOT_TO_PACKAGE',
      'artifacts/ai-cli-verification.json': '[]',
      'artifacts/jira-integration-example.ts': '// reviewed executable integration fixture',
      'dist/index.html': 'GENERATED_NOT_TO_PACKAGE',
    })) {
      const filePath = path.join(root, file);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
    }
    const out = path.join(dir, 'release.zip');
    const packed = spawnSync('python3', [script, '--root', root, '--output', out], { encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    const check = spawnSync('python3', ['-c',
      'import sys,zipfile,json,hashlib; z=zipfile.ZipFile(sys.argv[1]); m=json.loads(z.read("pr-context-explorer/SOURCE-MANIFEST.json")); assert z.testzip() is None; assert all(hashlib.sha256(z.read("pr-context-explorer/"+r["path"])).hexdigest()==r["sha256"] for r in m["files"]); print(json.dumps({"names":z.namelist(),"count":len(m["files"])}))', out], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    const result = JSON.parse(check.stdout);
    assert.equal(result.count, 10);
    assert.deepEqual(result.names.sort(), [
      'artifacts/ai-cli-verification.json', 'artifacts/jira-integration-example.ts',
      '.gitignore', 'README.md', 'SOURCE-MANIFEST.json', 'docs/guide.md', 'package-lock.json',
      'package.json', 'scripts/setup.py', 'src/main.ts', 'tests/app.test.ts',
    ].map(x => 'pr-context-explorer/' + x).sort());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
