import { test, expect } from "@playwright/test";
async function open(page: any) {
  await page.goto("/");
  await page.getByRole("button", { name: "데모 PR 목록 열기" }).click();
  await page.getByRole("button", { name: "PR #1 열기" }).click();
}
test("잘못된 URL 범위와 side는 표시 거부", async ({ page }) => {
  await open(page);
  const url = new URL(page.url());
  url.searchParams.set("end", "99999");
  await page.goto(url.toString());
  await expect(page.getByRole("alert")).toContainText("선택 상태");
});
test("삭제 old, rename ID, 그래프 edge 근거, 문맥 확장과 투어 강조", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "Phase 2", exact: true }).click();
  await page
    .getByRole("button", { name: "파일 src/obsolete.ts", exact: true })
    .click();
  await expect(page.getByTestId("code-new")).toContainText("파일이 없습니다");
  await expect(page.getByTestId("evidence-location")).toContainText("old");
  await page
    .getByRole("button", { name: "파일 src/format.ts", exact: true })
    .click();
  await expect(page.getByTestId("code-old")).toContainText("src/legacy.ts");
  const id = new URL(page.url()).searchParams.get("file");
  await page.getByRole("button", { name: "Baseline (비교 기준)" }).click();
  await page
    .getByRole("button", { name: "파일 src/legacy.ts", exact: true })
    .click();
  expect(new URL(page.url()).searchParams.get("file")).toBe(id);
  await page.getByRole("button", { name: "Phase 3", exact: true }).click();
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await page.getByLabel("문맥 파일 확장").check();
  await expect(
    page.getByRole("button", { name: "파일 src/main.ts", exact: true }),
  ).toBeVisible();
  await page.locator(".react-flow__edge").first().click({ force: true });
  await expect(page.getByTestId("evidence-location")).toContainText("new");
  await expect(page.getByTestId("code-new").locator(".highlight")).toHaveCount(
    1,
  );
  await page.getByRole("button", { name: "Guided Flow", exact: true }).click();
  await expect(page.locator(".react-flow")).toBeVisible();
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  await page.screenshot({ path: "artifacts/tour.png", fullPage: true });
});
