import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, symlink, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
for (const name of ['package.json', 'runtime-dependencies.json']) {
  test(`manifest ${name} symlink refuses before copying and preserves foreign contents`, async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'prce-manifest-link-')));
    try {
      const runtime = path.join(dir, 'runtime'); await mkdir(runtime);
      const sentinel = path.join(dir, 'foreign'); await writeFile(sentinel, 'FOREIGN-SENTINEL');
      await symlink(sentinel, path.join(runtime, name));
      const { copyRuntimeDependencies } = await import(pathToFileURL(path.resolve('desktop/runtime-dependencies.mjs')).href);
      await assert.rejects(copyRuntimeDependencies(process.cwd(), runtime));
      assert.equal(await readFile(sentinel, 'utf8'), 'FOREIGN-SENTINEL');
      await assert.rejects(access(path.join(runtime, 'node_modules')), {code:'ENOENT'});
    } finally { await rm(dir, {recursive:true, force:true}); }
  });
}
