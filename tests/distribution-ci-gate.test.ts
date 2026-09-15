import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
test('Mac CI may collect independent diagnostics but artifacts require every actual gate success', () => {
  const script = 'distribution/ci-gate.sh';
  assert.ok(existsSync(script), 'CI outcome gate implementation required');
  const run = (values: string[]) => spawnSync('bash', [script, ...values], { encoding: 'utf8' });
  assert.equal(run(['success', 'success', 'success']).status, 0);
  for (let position = 0; position < 3; position++) {
    for (const outcome of ['failure', 'cancelled', 'skipped', '', 'success; true']) {
      const values = ['success', 'success', 'success']; values[position] = outcome;
      assert.notEqual(run(values).status, 0);
    }
  }
  assert.notEqual(run([]).status, 0);
});
