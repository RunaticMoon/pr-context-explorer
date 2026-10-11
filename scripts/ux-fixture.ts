/** Explicit synthetic PRs for browser/Mac UI verification. No model or network calls. */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectGit } from "../src/server/live-git.ts";
import { LocalStore, cacheKey } from "../src/server/store.ts";
import { bareCachePath } from "../src/server/ingest.ts";
import type { Connection } from "../src/server/github.ts";

export async function seedUxFixtures(dataDir: string) {
  const store = new LocalStore(dataDir);
  const connection: Connection = {
    id: "ux-fixture",
    type: "github",
    webUrl: "https://github.com",
    apiUrl: "https://api.github.com",
    apiVersion: "2022-11-28",
    account: "FIXTURE-NO-ACCOUNT",
    auth: { kind: "public" },
  };
  store.put("config", cacheKey({ connection: connection.id }), connection);
  const snapshots = [];
  for (const scenario of ["small", "long"] as const) {
    const work = mkdtempSync(path.join(tmpdir(), "prce-ux-fixture-"));
    const repo = `ux-fixture/${scenario}`;
    const bare = bareCachePath(connection, repo, store.root);
    if (existsSync(bare))
      throw Error(
        "Fixture destination already exists; choose a fresh data directory",
      );
    const env = {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "UX Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "UX Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    };
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd: work,
        env,
        encoding: "utf8",
      }).trim();
    const put = (file: string, contents: string) => {
      mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
      writeFileSync(path.join(work, file), contents);
    };
    const commit = (message: string) => {
      git("add", "--all");
      git("commit", "-qm", message);
      return git("rev-parse", "HEAD");
    };
    try {
      git("init", "--template=", "-q");
      put(
        "src/input.ts",
        "export function normalize(input: string) {\n  return input;\n}\n",
      );
      put("src/legacy.ts", "export const legacy = true;\n");
      const base = commit("FIXTURE baseline");
      put(
        "src/input.ts",
        "export function normalize(input: string) {\n  return input.trim();\n}\n",
      );
      commit(
        "입력 공백 제거 · FIXTURE\n\nPR 목표: 빈 입력과 앞뒤 공백을 정규화한다. 첫 단계에서 공백을 제거한다.",
      );
      put(
        "src/process.ts",
        'import { normalize } from "./input";\nexport function process(input: string) {\n  return normalize(input).toUpperCase();\n}\n',
      );
      commit("정규화 함수를 처리 흐름에 연결 · FIXTURE");
      put(
        "src/input.ts",
        'export function normalize(input: string) {\n  const trimmed = input.trim();\n  if (!trimmed) throw new Error("empty input");\n  return trimmed;\n}\n',
      );
      rmSync(path.join(work, "src/legacy.ts"));
      let head = commit("빈 입력 처리 보강과 legacy 제거 · FIXTURE");
      if (scenario === "long") {
        git("mv", "src/input.ts", "src/normalize.ts");
        head = commit("입력 모듈 이름 정리 · 정확한 rename FIXTURE");
        put(
          "src/process.ts",
          'import { normalize } from "./normalize";\nexport function process(input: string) {\n  return normalize(input).toUpperCase();\n}\n',
        );
        head = commit("rename된 import 경로 후속 수정 · FIXTURE");
        for (let i = 6; i <= 18; i++) {
          put(
            `tests/input-contract-${i}.test.ts`,
            `import { normalize } from "../src/normalize";\nexport const case${i} = normalize(" fixture ${i} ");\n`,
          );
          if (i === 12)
            put(
              "src/normalize.ts",
              'export function normalize(input: string) {\n  const trimmed = input.trim();\n  if (!trimmed) throw new Error("input must not be blank");\n  return trimmed;\n}\n',
            );
          if (i === 18)
            put(
              "tests/very-long-directory-for-narrow-window-regression/input-normalization-contract-with-long-descriptive-name.test.ts",
              Array.from(
                { length: 180 },
                (_, line) =>
                  `export const fixtureRow${line} = "explicit UI fixture line ${line}: ${"long horizontal scrolling evidence ".repeat(7)}";`,
              ).join("\n") + "\n",
            );
          head = commit(
            `입력 계약 확인 ${i} · FIXTURE${i === 18 ? " · 긴 메시지와 탐색 위치가 작은 창에서도 유지되는지 확인하는 마지막 커밋" : ""}`,
          );
        }
      }
      mkdirSync(path.dirname(bare), { recursive: true });
      git("clone", "--bare", "--quiet", work, bare);
      const snapshot = await collectGit({
        barePath: bare,
        baseSha: base,
        headSha: head,
        identity: {
          connectionId: connection.id,
          accountContextId: "public:FIXTURE-NO-ACCOUNT",
          repository: repo,
          number: scenario === "small" ? 1 : 2,
        },
        pr: {
          title: `[TEST FIXTURE] 입력 정규화 ${scenario === "small" ? "작은 PR" : "긴 PR · rename과 반복 수정"}`,
          body: "입력의 앞뒤 공백과 빈 문자열 때문에 처리 결과가 달라지는 문제를 줄입니다. 정규화 함수를 처리 흐름에 연결하고, 빈 입력은 명시적으로 거부합니다.\n\n명시적인 UI 테스트 fixture입니다. 실제 GitHub PR 또는 AI 분석 결과가 아니며, 테스트 코드를 실행한 결과도 아닙니다.",
          author: "UX-FIXTURE",
          url: `https://github.com/${repo}/pull/${scenario === "small" ? 1 : 2}`,
        },
      });
      store.put("snapshot", snapshot.snapshotId, { snapshot, stale: false });
      snapshots.push({ scenario, snapshot });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  return snapshots;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  if (!process.argv[2] || !path.isAbsolute(process.argv[2]))
    throw Error("Pass an absolute, fresh fixture data directory");
  const fixtures = await seedUxFixtures(process.argv[2]);
  console.log(
    JSON.stringify(
      fixtures.map(({ scenario, snapshot }) => ({
        scenario,
        snapshotId: snapshot.snapshotId,
        headSha: snapshot.headSha,
        phases: snapshot.phases.map((p) => p.sha),
      })),
      null,
      2,
    ),
  );
}
