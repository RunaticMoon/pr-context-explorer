import { test, expect } from "@playwright/test";
test("전체 데모 경험과 revision/근거/투어 URL 복원", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "연결 및 분석 설정" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "명시적 데모로 돌아가기" }).click();
  await page.getByRole("button", { name: "PR #1 열기" }).click();
  await expect(
    page.getByText("MockProvider", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.locator(".react-flow")).toBeVisible();
  await page.getByRole("button", { name: "Phase 1", exact: true }).click();
  await expect(page.getByTestId("phase-message")).toContainText("본문 없음");
  const phaseOne = new URL(page.url()).searchParams.get("commit");
  await page
    .getByRole("button", { name: "파일 src/rules.ts", exact: true })
    .click();
  await expect(page.getByTestId("code-new")).toContainText("trim");
  await page.getByRole("button", { name: "Phase 2", exact: true }).click();
  await expect(page.getByText("renamed").first()).toBeVisible();
  await page.getByRole("button", { name: "Guided Flow", exact: true }).click();
  await expect(page.getByTestId("tour")).toContainText("head 고정");
  expect(new URL(page.url()).searchParams.get("commit")).not.toBe(phaseOne);
  await page.getByRole("button", { name: "읽음 표시", exact: true }).click();
  await expect(page.getByTestId("progress")).toContainText("1 / 3");
  await page.getByRole("button", { name: "다음 단계", exact: true }).click();
  await page.getByRole("button", { name: "단계 근거 1", exact: true }).click();
  await expect(page.getByTestId("evidence-location")).toContainText("new");
  const evidenceURL = page.url();
  await page.reload();
  await expect(page.getByTestId("evidence-location")).toContainText("new");
  expect(page.url()).toBe(evidenceURL);
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "Code Explorer", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Phase 1", exact: true }).click();
  await expect(page.getByTestId("phase-explanation")).toContainText(
    "아직 연결되지",
  );
  await expect(page.getByTestId("tour")).toHaveCount(0);
  await page.screenshot({ path: "artifacts/workspace.png", fullPage: true });
  expect(errors).toEqual([]);
});
