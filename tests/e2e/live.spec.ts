import { test, expect } from "@playwright/test";
test("live connection save, exact-host rejection, cache inventory and demo remain distinct", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "실제 PR 연결" }).click();
  await expect(
    page.getByRole("heading", { name: "실제 GitHub 연결" }),
  ).toBeVisible();
  await page.getByLabel("연결 ID", { exact: true }).fill("browser-public");
  await page.getByLabel("계정 식별자", { exact: true }).fill("public");
  await page.getByLabel("인증 방식").selectOption("public");
  await page.getByRole("button", { name: "연결 저장", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("저장");
  await page.getByLabel("Jira 연결 ID").fill("browser-jira");
  await page.getByLabel("Jira Web URL").fill("https://tickets.example.invalid");
  await page
    .getByLabel("Jira API base URL")
    .fill("https://tickets.example.invalid");
  await page.getByLabel("Jira 계정 맥락").fill("test-account");
  await page.getByLabel("프로젝트 키 목록").fill("TEAM");
  await page.getByRole("button", { name: "Jira 연결 저장" }).click();
  await expect(page.getByTestId("jira-settings-status")).toContainText("저장");
  await page.getByRole("button", { name: "내 PR / URL 열기" }).click();
  await page
    .getByLabel("PR URL", { exact: true })
    .fill("https://evil.invalid/acme/repo/pull/1");
  await page.getByRole("button", { name: "고정 snapshot 수집" }).click();
  await expect(page.getByTestId("live-job")).toContainText("failed");
  await expect(page.getByTestId("live-job")).toContainText(
    "registered exact host",
  );
  await expect(page.getByText("MockProvider", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "내 PR / 직접 URL" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "명시적 데모로 돌아가기" }).click();
  await page.getByRole("button", { name: "데모 PR 목록 열기" }).click();
  await expect(page.getByRole("button", { name: "PR #1 열기" })).toBeVisible();
});
