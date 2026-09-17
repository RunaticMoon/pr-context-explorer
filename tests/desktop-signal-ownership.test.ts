import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Portable composition probe: execute the actual compiled signal callback
// from main.ts with controlled lifecycle bindings. Not native Electron proof.
function signalCallback(quitting: boolean, calls: string[], closed = false) {
  const file = ts.createSourceFile("main.ts", readFileSync(new URL("../desktop/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const callbacks: ts.ArrowFunction[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(file) === "process" && node.expression.name.text === "on"
      && node.arguments[0]?.getText(file) === "signal" && node.arguments[1] && ts.isArrowFunction(node.arguments[1])) callbacks.push(node.arguments[1]);
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.equal(callbacks.length, 1);
  const js = ts.transpileModule(`(${callbacks[0].getText(file)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(js, {
    quitting, signal: "SIGTERM",
    quitCtl: { closed: () => closed, handleSignal: async (s: string) => { calls.push(s); } },
  }) as () => void;
}

test("observed signal cannot start competing cleanup once updater owns shutdown", async () => {
  const calls: string[] = [];
  signalCallback(true, calls)();
  await Promise.resolve();
  assert.deepEqual(calls, [], "must not cancel prepared updater or redispatch quit during existing shutdown");
});
test("observed signal retains base shutdown authority before cleanup ownership", async () => {
  const calls: string[] = [];
  signalCallback(false, calls)();
  await Promise.resolve();
  assert.deepEqual(calls, ["SIGTERM"]);
  signalCallback(false, calls, true)();
  assert.deepEqual(calls, ["SIGTERM"]);
});
