import { test, expect } from "@playwright/test";
test("선택 old/new 코드 설명 전환", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "명시적 데모로 돌아가기" }).click();
  await page.getByRole("button", { name: "PR #1 열기" }).click();
  await page.getByRole("button", { name: "Phase 2", exact: true }).click();
  await page
    .getByRole("button", { name: "파일 src/process.ts", exact: true })
    .click();
  await expect(page.getByTestId("code-explanation")).toContainText("ok:false");
  await page
    .getByTestId("code-old")
    .getByRole("button", { name: "1", exact: true })
    .click();
  await expect(page.getByTestId("code-explanation")).toContainText(
    "정규화 없이",
  );
  await expect(page.getByTestId("code-explanation")).toContainText(
    "catch 없음",
  );
});
