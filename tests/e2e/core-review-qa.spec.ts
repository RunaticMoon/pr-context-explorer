import { test, expect } from "@playwright/test";
import { objectFixture } from "../core-review-helpers";
import {
  buildContext,
  validateLiveOutput,
} from "../../src/server/live-analysis";

for (const completion of ["cached", "async"] as const)
  test(`Guided Flow Q&A keeps PR tour separate (${completion}, intercepted provider result, not inference)`, async ({
    page,
  }) => {
    const cleanup: (() => void)[] = [];
    const f = objectFixture({ after: (fn) => cleanup.push(fn) });
    try {
      const base = f.commit({ "a.ts": "export const value=1;\n" });
      const head = f.commit(
        {
          "a.ts": "export const value=1;\n",
          "b.ts": 'import { value } from "./a";\nexport const result=value;\n',
        },
        [base],
      );
      const s = await f.collect(base, head),
        e = s.evidence.find(
          (e) =>
            e.commitSha === head &&
            e.path === "b.ts" &&
            e.side === "new" &&
            e.lineEnd === 2,
        )!;
      const output = {
        schemaVersion: "2",
        snapshotId: s.snapshotId,
        analysisStatus: "complete",
        limitations: [],
        missingContext: [],
        statements: [
          {
            text: "PR OVERVIEW RETAINED",
            kind: "observed",
            evidenceIds: [e.id],
            confidence: "high",
            limitation: "",
            commitSha: head,
          },
        ],
        steps: [
          {
            id: "read-import",
            title: "REVIEW: read import",
            why: "Inspect import",
            previous: "",
            next: "",
            question: "Why?",
            beforeAfter: "Added import",
            revisionSha: head,
            comparisonFromSha: e.comparisonFromSha,
            fileIds: [e.fileId],
            evidenceIds: [e.id],
            prerequisites: [],
            requirementIds: [],
          },
        ],
        codeExplanations: [],
        requirementMappings: [],
      };
      validateLiveOutput(output, s);
      const prResult = {
        output,
        metadata: { harness: "INTERCEPTED, NOT INFERENCE" },
        scope: { kind: "pr" },
        cacheKey: "c".repeat(64),
        contextCoverage: buildContext(s, { kind: "pr" }).coverage,
      };
      let codeResult: any,
        runs = 0;
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.route("**/api/live/snapshot?*", (r) =>
        r.fulfill({ json: { snapshot: s, stale: false } }),
      );
      await page.route("**/api/live/analysis?*", (r) =>
        r.fulfill({
          json: {
            result:
              new URL(r.request().url()).searchParams.get("key") ===
              prResult.cacheKey
                ? prResult
                : codeResult,
          },
        }),
      );
      await page.route("**/api/live/run", async (r) => {
        runs++;
        const scope = r.request().postDataJSON().scope;
        const context = buildContext(s, scope),
          selection = context.evidence[0];
        const codeOutput = {
          ...output,
          analysisStatus: "partial",
          steps: [],
          statements: [
            {
              ...output.statements[0],
              text: "SELECTED CODE ANSWER",
              evidenceIds: [selection.id],
            },
          ],
        };
        validateLiveOutput(
          codeOutput,
          { ...s, evidence: [...s.evidence, selection] },
          context,
        );
        codeResult = {
          output: codeOutput,
          metadata: { harness: "INTERCEPTED, NOT INFERENCE" },
          scope,
          selectionEvidence: [selection],
          cacheKey: "d".repeat(64),
          contextCoverage: context.coverage,
        };
        await r.fulfill({
          json:
            completion === "cached"
              ? { cached: true, result: codeResult }
              : {
                  id: "qa-job",
                  kind: "analysis",
                  status: "running",
                  events: [],
                },
        });
      });
      await page.route("**/api/live/job?*", (r) =>
        r.fulfill({
          json: {
            id: "qa-job",
            kind: "analysis",
            status: "partial",
            events: [],
            result: codeResult,
          },
        }),
      );
      await page.goto(
        "/?" +
          new URLSearchParams({
            page: "live-workspace",
            snapshot: s.snapshotId,
            analysis: prResult.cacheKey,
            commit: head,
            comparison: e.comparisonFromSha!,
            file: e.fileId,
            side: "new",
            start: "1",
            end: "2",
            step: "read-import",
            mode: "Guided Flow",
          }),
      );
      await expect(page.getByTestId("live-tour")).toBeVisible();
      await page
        .locator("summary")
        .filter({ hasText: "모델 선택 / 전송 동의 / 분석 실행" })
        .click();
      await page.getByLabel("모델 식별자").fill("fixture-model");
      await page
        .getByLabel(
          "선택 범위의 PR/코드/Jira를 선택 모델 제공자에게 전송하는 데 동의합니다.",
        )
        .check();
      await page
        .getByRole("button", { name: "선택 범위 설명 실행", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Code Explorer", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(
        page.getByText("SELECTED CODE ANSWER", { exact: true }),
      ).toBeVisible();
      expect(new URL(page.url()).searchParams.get("analysis")).toBe(
        prResult.cacheKey,
      );
      expect(new URL(page.url()).searchParams.get("step")).toBe("");
      expect(new URL(page.url()).searchParams.get("codeAnalysis")).toBe(
        codeResult.cacheKey,
      );
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.getByTestId("live-context-coverage")).toContainText(
        "Code Q&A",
      );
      const codeURL = page.url();
      await page.reload();
      await expect(
        page.getByText("SELECTED CODE ANSWER", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Guided Flow", exact: true })
        .click();
      await expect(page.getByTestId("live-tour")).toContainText(
        "REVIEW: read import",
      );
      await expect(
        page.getByText("PR OVERVIEW RETAINED", { exact: true }),
      ).toBeVisible();
      await page.goBack();
      await expect(
        page.getByText("SELECTED CODE ANSWER", { exact: true }),
      ).toBeVisible();
      expect(page.url()).toBe(codeURL);
      expect(runs).toBe(1);
      expect(errors).toEqual([]);
      await page.screenshot({
        path: `artifacts/review-core/qa-${completion}-fixed.png`,
        fullPage: true,
      });
    } finally {
      cleanup.forEach((fn) => fn());
    }
  });
