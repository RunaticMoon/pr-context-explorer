import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

test("native update navigation exposes only a removable notification, never the IPC event", () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let bridge: any;
  const electron = {
    contextBridge: {
      exposeInMainWorld: (_: string, value: unknown) => {
        bridge = value;
      },
    },
    ipcRenderer: {
      on: (name: string, fn: (...args: unknown[]) => void) =>
        listeners.set(name, fn),
      removeListener: (name: string, fn: unknown) => {
        if (listeners.get(name) === fn) listeners.delete(name);
      },
    },
  };
  const compiled = transformSync(readFileSync("desktop/preload.ts", "utf8"), {
    loader: "ts",
    format: "cjs",
  }).code;
  runInNewContext(compiled, { require: () => electron });
  const received: unknown[][] = [];
  const unsubscribe = bridge.onOpenUpdates((...args: unknown[]) =>
    received.push(args),
  );
  assert.equal(typeof bridge.send, "undefined");
  assert.equal(typeof bridge.invoke, "undefined");
  listeners.get("prce:open-updates")!(
    { sender: "PRIVATE ELECTRON EVENT" },
    "UNTRUSTED PAYLOAD",
  );
  assert.deepEqual(received, [[]]);
  unsubscribe();
  assert.equal(listeners.size, 0);
  assert.throws(() => bridge.onOpenUpdates("not a function"));
});
