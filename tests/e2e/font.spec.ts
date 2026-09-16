import { test, expect } from "@playwright/test";
test("한국어 글꼴을 외부 요청 없이 자체 제공", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith("http://127.0.0.1:4317")) external.push(r.url());
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "연결 및 분석 설정" }),
  ).toHaveCSS("font-family", /Noto Sans KR/);
  await page.evaluate(() => document.fonts.ready);
  expect(external).toEqual([]);
  await page.getByRole("button", { name: "명시적 데모로 돌아가기" }).click();
  await page.getByRole("button", { name: "PR #1 열기" }).click();
  await expect(
    page.getByTestId("phase-message").locator("pre").first(),
  ).toHaveCSS("font-family", /Noto Sans KR/);
  // Metadata and specific code/diff selectors used to override the Korean fallback.
  await expect(page.locator(".revision").first()).toHaveCSS(
    "font-family",
    /Noto Sans KR/,
  );
  await page.getByRole("button", { name: "Phase 2", exact: true }).click();
  await page
    .getByRole("button", { name: "파일 src/process.ts", exact: true })
    .click();
  for (const selector of [".code-pane h4", ".code-pane pre", ".rawdiff pre"]) {
    await expect(page.locator(selector).first()).toHaveCSS(
      "font-family",
      /Noto Sans KR/,
    );
  }
  await page.getByRole("button", { name: "연결 설정", exact: true }).click();
  await page.screenshot({ path: "artifacts/connections.png", fullPage: true });
});
