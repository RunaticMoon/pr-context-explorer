// Dedicated-CI fixture lifecycle, not a production app-data deletion API.
import assert from "node:assert/strict";
import { lstatSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { identity, sameIdentity } from "../../desktop/smoke-helpers.mjs";

function optionalStat(file) {
  try {
    return lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function chain(file) {
  const entries = [];
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    const st = optionalStat(current);
    if (st) {
      assert.ok(
        st.isDirectory() && !st.isSymbolicLink(),
        "app data path must contain only real directories",
      );
      entries.push([current, st]);
    }
    if (path.dirname(current) === current) return entries;
  }
}
function sameDirectory(file, expected) {
  const now = lstatSync(file);
  assert.ok(
    now.isDirectory() &&
      !now.isSymbolicLink() &&
      now.ino === expected.ino &&
      now.dev === expected.dev &&
      now.uid === expected.uid,
    "app data directory identity changed; preserve it",
  );
}
export function assertProcessGone(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw error; // EPERM or inspection failure is not evidence of exit.
  }
  throw Error("owned process still present; preserve app data");
}
export function createOwnedAppData(
  paths,
  {
    ci = process.env.PRCE_PACKAGED_CI,
    identity: inspect = identity,
    assertGone = assertProcessGone,
  } = {},
) {
  assert.equal(ci, "1", "dedicated packaged CI required");
  const roots = [...new Set(paths.map((p) => path.resolve(p)))];
  const parents = new Map();
  for (const data of roots) {
    assert.equal(
      optionalStat(data),
      null,
      "dedicated CI account must have no existing app data; preserve it",
    );
    parents.set(data, chain(data));
  }
  const captured = new Map();
  return {
    capture({ app, executable, node }) {
      assert.ok(
        app &&
          app.uid === process.getuid() &&
          (app.command === executable ||
            app.command.startsWith(executable + " ")) &&
          sameIdentity(app, inspect(app.pid)),
        "owned app identity not verified",
      );
      for (const data of roots) {
        if (captured.has(data) || !optionalStat(data)) continue;
        for (const [file, st] of parents.get(data)) sameDirectory(file, st);
        const dirs = chain(data);
        const st = dirs[0][1];
        assert.equal(st.uid, process.getuid());
        const marker = path.join(data, "desktop-runtime.json");
        const leaseStat = optionalStat(marker);
        if (!leaseStat) continue;
        assert.ok(
          leaseStat.isFile() &&
            !leaseStat.isSymbolicLink() &&
            leaseStat.uid === st.uid,
          "unsafe runtime lease",
        );
        const lease = JSON.parse(readFileSync(marker, "utf8"));
        assert.equal(lease.pid, app.pid);
        assert.equal(lease.executable, executable);
        const backend = inspect(lease.backendPid);
        assert.ok(
          backend &&
            backend.uid === app.uid &&
            backend.parent === app.pid &&
            (backend.command === node ||
              backend.command.startsWith(node + " ")),
          "owned backend identity not verified",
        );
        assert.ok(
          sameIdentity(app, inspect(app.pid)) &&
            sameIdentity(backend, inspect(backend.pid)),
        );
        for (const [file, expected] of dirs) sameDirectory(file, expected);
        captured.set(data, { dirs, app, backend });
      }
      return [...captured].map(([data, owned]) => ({
        marker: path.join(data, "desktop-runtime.json"),
        backend: owned.backend,
      }));
    },
    cleanup() {
      // Validate ALL roots before deleting any. Unknown or replaced data is retained.
      for (const data of roots) {
        if (!optionalStat(data) && !captured.has(data)) continue;
        const owned = captured.get(data);
        assert.ok(owned, "unverified app data; preserve it");
        assertGone(owned.app.pid);
        assertGone(owned.backend.pid);
        for (const [file, st] of owned.dirs) sameDirectory(file, st);
      }
      for (const data of captured.keys()) rmSync(data, { recursive: true });
    },
  };
}
