/** Explicit synthetic Git fixture: UI correctness, not an AI/user-comprehension test. */
import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { seedUxFixtures } from "../../scripts/ux-fixture";
import { createApp } from "../../src/server/http";
import { fakeEngineSetup } from "../fake-engine-setup";

test.describe("PR understanding journey · explicit Git fixture", () => {
  test.describe.configure({ mode: "serial" });
  let root: string, origin: string, server: Server;
  let fixtures: Awaited<ReturnType<typeof seedUxFixtures>>;
  test.beforeAll(async () => {
    test.setTimeout(120000);
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "prce-ux-journey-")));
    fixtures = await seedUxFixtures(root);
    server = await createApp(0, {
      dataDir: root,
      engineSetup: fakeEngineSetup(),
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("No fixture server port");
    origin = `http://127.0.0.1:${address.port}`;
  });
  test.afterAll(async () => {
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    if (root) rmSync(root, { recursive: true, force: true });
  });
  const param = (page: Page, key: string) =>
    new URL(page.url()).searchParams.get(key);
  const open = async (page: Page, scenario: "small" | "long") => {
    const snapshot = fixtures.find((f) => f.scenario === scenario)!.snapshot;
    await page.goto(
      `${origin}/?${new URLSearchParams({ page: "live-workspace", snapshot: snapshot.snapshotId })}`,
    );
    return snapshot;
  };
  const noHorizontalPageOverflow = async (page: Page) => {
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  };

  test("small PR: overview → actual phase → exact old gutter → recurring file → final diff → return", async ({
    page,
  }, info) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width: 1280, height: 800 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const s = await open(page, "small");
    const overview = page.getByTestId("pr-overview");
    await expect(
      overview.getByRole("heading", { name: "왜 필요한 PR인가" }),
    ).toBeVisible({ timeout: 30000 });
    await expect(overview).toContainText("입력의 앞뒤 공백과 빈 문자열");
    await expect(overview).toContainText("실제 커밋 흐름 · 3개");
    await noHorizontalPageOverflow(page);
    await page.screenshot({ path: info.outputPath("small-overview-1280.png") });
    await overview.getByRole("button", { name: "처음부터 따라 읽기" }).click();
    await expect.poll(() => param(page, "commit")).toBe(s.phases[0].sha);
    const rail = page.getByRole("navigation", {
      name: "커밋 흐름",
      exact: true,
    });
    await expect(rail).toContainText("커밋 1 / 3");
    const reader = page.getByTestId("commit-file-reader");
    await expect(reader).toContainText("input.ts");
    await expect(reader.getByTestId("reader-comparison")).toContainText(
      s.baseline.sha.slice(0, 10),
    );
    // Context exists on both sides, with separate evidence selection semantics.
    await reader
      .getByRole("button", { name: "변경 전 1번 줄", exact: true })
      .click();
    await expect.poll(() => param(page, "side")).toBe("old");
    await expect.poll(() => param(page, "start")).toBe("1");
    await reader
      .getByRole("button", { name: "변경 후 1번 줄", exact: true })
      .click();
    await expect.poll(() => param(page, "side")).toBe("new");
    await reader
      .getByRole("navigation", { name: "이 파일의 변경 이력" })
      .getByRole("button", { name: "Phase 3", exact: true })
      .click();
    await expect.poll(() => param(page, "commit")).toBe(s.phases[2].sha);
    await expect(reader).toContainText("input.ts");
    await expect(reader).toContainText("empty input");
    await rail.getByRole("button", { name: /deleted.*legacy\.ts/ }).click();
    await expect(reader).toContainText("deleted");
    await expect(reader).toContainText("legacy = true");
    await expect.poll(() => param(page, "side")).toBe("old");
    // Summary round-trip keeps the phase/file, rather than silently moving to head's first file.
    const selectedFile = param(page, "file");
    await overview
      .getByRole("button", { name: "PR 전체 맥락으로 돌아가기" })
      .click();
    await expect(
      overview.getByRole("heading", { name: "왜 필요한 PR인가" }),
    ).toBeVisible();
    await overview.getByRole("button", { name: "전체 맥락 접기" }).click();
    expect(param(page, "file")).toBe(selectedFile);
    expect(param(page, "commit")).toBe(s.phases[2].sha);
    await expect(reader).toContainText("legacy.ts");
    await page
      .getByRole("button", { name: "최종 PR 변경", exact: true })
      .click();
    await expect(page.getByTestId("comparison-location")).toContainText(
      "최종 PR 변경",
    );
    await expect(page.getByTestId("comparison-location")).toContainText(
      s.baseline.sha.slice(0, 12),
    );
    await expect(page.getByTestId("comparison-location")).toContainText(
      s.headSha.slice(0, 12),
    );
    await noHorizontalPageOverflow(page);
    await page.screenshot({ path: info.outputPath("small-final-1280.png") });
    expect(errors).toEqual([]);
  });

  test("narrow layout: opening a panel reveals it once without snapping on commit navigation", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const s = await open(page, "long");
    await page.getByRole("button", { name: "처음부터 따라 읽기" }).click();
    const opener = page.getByRole("button", {
      name: "Code Explorer · 관계",
      exact: true,
    });
    await opener.click();
    const panel = page.getByRole("complementary", {
      name: "Code Explorer · AST import",
      exact: true,
    });
    await expect(panel).toBeFocused();
    await expect
      .poll(() =>
        panel.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return rect.top >= 0 && rect.top < innerHeight - 120;
        }),
      )
      .toBe(true);
    // Commit navigation deliberately returns to the rail. The mounted graph
    // must not pull the viewport back down when its revision changes.
    await page.evaluate(() => window.scrollTo(0, 0));
    const rail = page.getByRole("navigation", {
      name: "커밋 흐름",
      exact: true,
    });
    await rail.getByLabel("Phase 바로 이동").focus();
    await rail.getByLabel("Phase 바로 이동").selectOption(s.phases[1].sha);
    await expect.poll(() => param(page, "commit")).toBe(s.phases[1].sha);
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeLessThan(300);
    await expect(panel).not.toBeFocused();
    await opener.click();
    await expect(panel).toBeFocused();
    await panel.locator(".react-flow__node").first().click();
    const reader = page.getByTestId("commit-file-reader");
    await expect(reader).toBeFocused();
    await expect
      .poll(() =>
        reader.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return rect.top >= 0 && rect.top < innerHeight - 120;
        }),
      )
      .toBe(true);
    await opener.click();
    await expect(panel).toBeFocused();
    await panel.getByRole("button", { name: "닫기", exact: true }).click();
    await expect(opener).toBeFocused();
    await expect(panel).toHaveCount(0);
    await expect
      .poll(() =>
        opener.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.top >= 90 && r.bottom <= innerHeight;
        }),
      )
      .toBe(true);
  });

  test("long PR graph opens with readable nodes and preserves manual viewport across phases and reopening", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 757 });
    const s = await open(page, "long");
    await page.getByRole("button", { name: "처음부터 따라 읽기" }).click();
    const rail = page.getByRole("navigation", {
      name: "커밋 흐름",
      exact: true,
    });
    await rail.getByLabel("Phase 바로 이동").selectOption(s.phases[1].sha);
    const opener = page.getByRole("button", {
      name: "Code Explorer · 관계",
      exact: true,
    });
    await opener.click();
    const graph = page.locator(".graph");
    const nodes = graph.locator(".react-flow__node");
    await expect(nodes).toHaveCount(2);
    // Bounding-box assertions catch off-canvas cards even if their DOM nodes exist.
    await expect
      .poll(() =>
        graph.evaluate((el) => {
          const canvas = el.getBoundingClientRect();
          return [...el.querySelectorAll(".react-flow__node")].every((node) => {
            const rect = node.getBoundingClientRect();
            return (
              rect.width >= 150 &&
              rect.left >= canvas.left &&
              rect.right <= canvas.right &&
              rect.top >= canvas.top &&
              rect.bottom <= canvas.bottom
            );
          });
        }),
      )
      .toBe(true);
    const inputNode = nodes.filter({ hasText: "src/input.ts" });
    const position = await inputNode.evaluate(
      (el) => (el as HTMLElement).style.transform,
    );
    const viewport = graph.locator(".react-flow__viewport");
    const originalViewport = await viewport.getAttribute("style");
    const box = (await graph.boundingBox())!;
    await page.mouse.move(box.x + box.width - 100, box.y + box.height - 50);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 60, box.y + box.height - 20, {
      steps: 4,
    });
    await page.mouse.up();
    await expect(viewport).not.toHaveAttribute("style", originalViewport!);
    const manualViewport = await viewport.getAttribute("style");
    await rail.getByLabel("Phase 바로 이동").selectOption(s.phases[2].sha);
    await expect(inputNode).toHaveCount(1);
    expect(
      await inputNode.evaluate((el) => (el as HTMLElement).style.transform),
    ).toBe(position);
    await expect(viewport).toHaveAttribute("style", manualViewport!);
    await page
      .getByRole("button", { name: "Guided Flow", exact: true })
      .click();
    await expect(graph).toHaveCount(0);
    await opener.click();
    await expect(viewport).toHaveAttribute("style", manualViewport!);
    await rail.getByLabel("Phase 바로 이동").selectOption(s.headSha);
    await expect(nodes.filter({ hasText: "very-long-directory" })).toHaveCount(
      1,
    );
    const rectangles = await nodes.evaluateAll((elements) =>
      elements.map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }),
    );
    for (let i = 0; i < rectangles.length; i++)
      for (let j = i + 1; j < rectangles.length; j++) {
        const a = rectangles[i],
          b = rectangles[j];
        expect(
          a.left < b.right &&
            a.right > b.left &&
            a.top < b.bottom &&
            a.bottom > b.top,
        ).toBe(false);
      }
    await expect(
      nodes.filter({ hasText: "very-long-directory" }).locator("b"),
    ).toHaveAttribute("title", /very-long-directory/);
  });

  test("long PR: direct jump, rename lineage, repeated changes and keyboard at narrow/wide sizes", async ({
    page,
  }, info) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const s = await open(page, "long");
    await page.getByRole("button", { name: "처음부터 따라 읽기" }).click();
    const rail = page.getByRole("navigation", {
      name: "커밋 흐름",
      exact: true,
    });
    await rail.getByLabel("Phase 바로 이동").selectOption(s.phases[3].sha);
    await expect(rail).toContainText("커밋 4 / 18");
    const reader = page.getByTestId("commit-file-reader");
    await expect(reader).toContainText("src/input.ts → src/normalize.ts");
    await expect(reader).toContainText("renamed");
    const history = reader.getByRole("navigation", {
      name: "이 파일의 변경 이력",
    });
    await expect(history).toContainText("Phase 1");
    await expect(history).toContainText("Phase 3");
    await expect(history).toContainText("Phase 4");
    await expect(history).toContainText("Phase 12");
    await history
      .getByRole("button", { name: "Phase 12", exact: true })
      .click();
    await expect.poll(() => param(page, "commit")).toBe(s.phases[11].sha);
    await expect(reader).toContainText("input must not be blank");
    await page.screenshot({ path: info.outputPath("long-history-1440.png") });
    await rail.getByLabel("Phase 바로 이동").selectOption(s.headSha);
    await expect(rail).toContainText("커밋 18 / 18");
    await expect(
      rail.getByRole("button", { name: "다음 커밋", exact: true }),
    ).toBeDisabled();
    await page.setViewportSize({ width: 1280, height: 800 });
    await noHorizontalPageOverflow(page);
    await rail.getByRole("button", { name: "이전 커밋", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => param(page, "commit")).toBe(s.phases[16].sha);
    await expect(rail).toContainText("커밋 17 / 18");
    await rail.getByLabel("Phase 바로 이동").selectOption(s.headSha);
    // Last phase contains explicit long-path/long-code fixture content when available.
    const longFile = s.phases
      .at(-1)!
      .files.find(
        (f) => f.content.split("\n").length > 100 && f.status !== "unchanged",
      );
    expect(
      longFile,
      "long-code fixture is required for scroll verification",
    ).toBeTruthy();
    if (longFile) {
      await rail
        .locator(".commit-timeline-file")
        .filter({ hasText: longFile.path.split("/").at(-1)! })
        .click();
      const scroll = reader.getByTestId("commit-file-reader-scroll");
      await expect
        .poll(() => scroll.evaluate((el) => el.scrollHeight > el.clientHeight))
        .toBe(true);
      await scroll.evaluate((el) => {
        el.scrollTop = 650;
        el.scrollLeft = 80;
      });
      await expect
        .poll(() => scroll.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(600);
      await page
        .getByRole("button", { name: "PR 전체 맥락으로 돌아가기" })
        .click();
      await page.getByRole("button", { name: "전체 맥락 접기" }).click();
      await expect
        .poll(() => scroll.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(600);
      await reader
        .getByRole("button", { name: "전체 원문", exact: true })
        .click();
      await reader
        .getByRole("button", { name: "변경 구간", exact: true })
        .click();
      await expect
        .poll(() => scroll.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(600);
    }
    await noHorizontalPageOverflow(page);
    await page.screenshot({ path: info.outputPath("long-phase18-1280.png") });
  });
});
