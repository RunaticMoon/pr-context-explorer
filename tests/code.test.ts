import { test } from "node:test";
import assert from "node:assert/strict";
import { collect } from "../src/server/git.ts";
import { MockProvider } from "../src/server/provider.ts";
test("코드 역할/입출력/오류 설명은 정확한 side 근거에 고정", async () => {
  const s = collect();
  const a: any = await new MockProvider().analyze(s);
  assert.ok(a.codeExplanations, "파일 설명 필요");
  const importOnly = s.evidence
    .filter(
      (e) =>
        e.path === "src/process.ts" && e.lineStart === 1 && e.lineEnd === 1,
    )
    .map((e) => e.id);
  assert.ok(
    a.codeExplanations.every((x: any) => !importOnly.includes(x.evidenceId)),
    "함수 전체 설명을 import 한 줄에 인용하면 안 됨",
  );
  const e = s.evidence.find(
    (e) =>
      e.commitSha === s.phases[1].sha &&
      e.path === "src/process.ts" &&
      e.side === "old",
  )!;
  const x = a.codeExplanations.find((x: any) => x.evidenceId === e.id);
  assert.match(x.inputsOutputs, /string/);
  assert.match(x.behavior, /정규화 없이/);
  assert.match(x.errors, /catch 없음/);
  const n = s.evidence.find(
    (e) =>
      e.commitSha === s.phases[1].sha &&
      e.path === "src/process.ts" &&
      e.side === "new" &&
      e.lineEnd > 1,
  )!;
  assert.match(
    a.codeExplanations.find((x: any) => x.evidenceId === n.id).errors,
    /ok:false/,
  );
});
