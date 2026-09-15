import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  renameSync,
  unlinkSync,
  chmodSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
export const dataDir = path.resolve(".data");
export const repo = path.join(dataDir, "fixture");
export function git(...args: string[]) {
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "diff.external=",
      "-C",
      repo,
      ...args,
    ],
    {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: dataDir,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Demo Author",
        GIT_AUTHOR_EMAIL: "demo@example.invalid",
        GIT_COMMITTER_NAME: "Demo Author",
        GIT_COMMITTER_EMAIL: "demo@example.invalid",
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      },
    },
  );
}
function put(p: string, c: string) {
  mkdirSync(path.dirname(path.join(repo, p)), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(repo, p), c, { mode: 0o600 });
}
export function ensureFixture() {
  mkdirSync(repo, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  if (existsSync(path.join(repo, ".git"))) return;
  git("init", "--initial-branch=demo");
  put("src/types.ts", "export type Result = { ok: boolean; value: string };\n");
  put("src/config.ts", "export const DEBUG = false;\n");
  put(
    "src/legacy.ts",
    "export function format(value: string): string {\n  return value.toUpperCase();\n}\n",
  );
  put("src/obsolete.ts", "export const unused = true;\n");
  put(
    "src/process.ts",
    "import { format } from './legacy';\nimport type { Result } from './types';\nexport function processInput(value: string): Result {\n  return { ok: true, value: format(value) };\n}\n",
  );
  put(
    "src/main.ts",
    "import { processInput } from './process';\nexport const run = (value: string) => processInput(value);\n",
  );
  put(
    "tests/input.test.ts",
    "import { processInput } from '../src/process';\n// Fixture source only: never executed by the explorer.\nimport { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('valid input', () => {\n  assert.deepEqual(processInput('hello'), { ok: true, value: 'HELLO' });\n});\n",
  );
  put("README.md", "# Input demo\nDo not execute this target repository.\n");
  git("add", ".");
  git("commit", "-m", "baseline: accept all input");
  git("tag", "baseline");
  put(
    "src/rules.ts",
    "export function normalize(value: string): string {\n  const clean = value.trim();\n  if (!clean) throw new Error('empty input');\n  return clean;\n}\n",
  );
  put("src/config.ts", "export const DEBUG = true;\n");
  git("add", ".");
  git("commit", "-m", "DEMO-1 feat: define input rules");
  renameSync(
    path.join(repo, "src/legacy.ts"),
    path.join(repo, "src/format.ts"),
  );
  unlinkSync(path.join(repo, "src/obsolete.ts"));
  put(
    "src/process.ts",
    "import { format } from './format';\nimport { normalize } from './rules';\nimport type { Result } from './types';\nexport function processInput(value: string): Result {\n  try {\n    return { ok: true, value: format(normalize(value)) };\n  } catch {\n    return { ok: false, value: '' };\n  }\n}\n",
  );
  git("add", ".");
  git(
    "commit",
    "-m",
    "DEMO-1 feat: connect processing",
    "-m",
    "Normalize before formatting; preserve errors as Result.",
  );
  put(
    "tests/input.test.ts",
    "import { processInput } from '../src/process';\n// Fixture source only: never executed by the explorer.\nexport const cases = [\n  { input: ' hello ', expected: { ok: true, value: 'HELLO' } },\n  { input: '   ', expected: { ok: false, value: '' } },\n];\nimport { test } from 'node:test';\nimport assert from 'node:assert/strict';\nfor (const c of cases) {\n  test('input boundary: ' + JSON.stringify(c.input), () => {\n    assert.deepEqual(processInput(c.input), c.expected);\n  });\n}\n",
  );
  put("src/config.ts", "export const DEBUG = false;\n");
  git("add", ".");
  git("commit", "-m", "DEMO-1 test: cover boundaries and revert debug");
  const secure = (dir: string) => {
    chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) secure(p);
      else chmodSync(p, 0o600);
    }
  };
  secure(repo);
}
if (process.argv[1]?.endsWith("/fixture.ts")) {
  ensureFixture();
  console.log(repo, git("rev-list", "--count", "HEAD").trim());
}
