import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, lstat, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const inside = (parent, child) =>
  child === parent || child.startsWith(parent + path.sep);
export function isolatedEnvironment(home) {
  // No NODE_PATH, NODE_OPTIONS, Electron overrides, developer PATH or test-data escape hatch.
  return {
    HOME: home,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
  };
}
export async function assertIsolated(directory, checkout) {
  const actual = await realpath(directory);
  const repo = await realpath(checkout);
  assert.ok(!inside(repo, actual), "installation must be outside checkout");
  for (let current = actual; ; current = path.dirname(current)) {
    const modules = await lstat(path.join(current, "node_modules")).catch(
      (error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    assert.equal(
      modules,
      null,
      `ancestor node_modules would mask packaging defects: ${current}`,
    );
    if (path.dirname(current) === current) break;
  }
  return actual;
}
export async function createIsolatedInstall(checkout) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "prce-isolated-install-")),
  );
  try {
    await assertIsolated(root, checkout);
    const home = path.join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const owned = await stat(root);
    return {
      root,
      home,
      async cleanup() {
        const now = await lstat(root);
        assert.ok(
          !now.isSymbolicLink() &&
            now.ino === owned.ino &&
            now.dev === owned.dev,
          "temporary installation identity changed",
        );
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
export async function extractDistributable(zip, install, checkout) {
  assert.ok(
    zip.endsWith(".zip"),
    "packaged smoke requires the final ZIP, not a build directory",
  );
  const archive = await stat(zip);
  assert.ok(
    archive.isFile() && archive.size > 0 && archive.size < 2 * 1024 ** 3,
    "invalid ZIP size",
  );
  await assertIsolated(install.root, checkout);
  // Reuse the production external installer's bounded, traversal/link-safe ZIP extraction.
  // No build tree copying, dependency repairs, or signature mutations after extraction.
  const script = `import runpy,sys\nfrom pathlib import Path\nm=runpy.run_path(sys.argv[1])\nprint(m['extract_app'](Path(sys.argv[2]),Path(sys.argv[3])))\n`;
  return execFileSync(
    "/usr/bin/python3",
    [
      "-c",
      script,
      path.join(checkout, "distribution/prce"),
      path.resolve(zip),
      path.join(install.root, "installed"),
    ],
    {
      cwd: install.root,
      env: isolatedEnvironment(install.home),
      encoding: "utf8",
      stdio: "pipe",
      timeout: 120000,
      maxBuffer: 65536,
    },
  ).trim();
}
export function probeRuntime({ node, runtime, cwd, home }) {
  // Resolve every declared runtime dependency and its transitive closure using the
  // actual bundled Node resolver, not a host import or a filename-only assertion.
  const script = `
    import { createRequire } from 'node:module';
    import { realpathSync, readFileSync } from 'node:fs';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    const root = realpathSync(${JSON.stringify(runtime)});
    const within = p => p.startsWith(root + path.sep);
    const queue = [path.join(root, 'package.json')], seen = new Set(), resolved = {};
    // Baseline imports are independently required even if a broken build drops its manifest.
    const baseline = ['typescript', 'ajv', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'require-from-string'];
    while (queue.length) {
      const manifest = queue.shift();
      if (seen.has(manifest)) continue;
      seen.add(manifest);
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      const require = createRequire(manifest);
      const names = new Set([...Object.keys(pkg.dependencies || {}), ...(manifest === path.join(root, 'package.json') ? baseline : [])]);
      for (const name of names) {
        const entry = realpathSync(require.resolve(name));
        if (!within(entry)) throw Error('Dependency escaped installed runtime: ' + name);
        resolved[name] = entry;
        let dir = path.dirname(entry), next;
        for (;;) {
          try { const candidate = path.join(dir, 'package.json'); if (JSON.parse(readFileSync(candidate, 'utf8')).name === name) { next = candidate; break; } } catch {}
          if (dir === root || !within(dir)) throw Error('Missing dependency manifest: ' + name);
          dir = path.dirname(dir);
        }
        queue.push(next);
      }
    }
    await import(pathToFileURL(path.join(root, 'desktop/backend.js')).href);
    process.stdout.write(JSON.stringify({ backendImported: true, resolved }));
  `;
  return JSON.parse(
    execFileSync(node, ["--input-type=module", "-e", script], {
      cwd,
      env: isolatedEnvironment(home),
      encoding: "utf8",
      stdio: "pipe",
      timeout: 20000,
      maxBuffer: 65536,
    }),
  );
}
