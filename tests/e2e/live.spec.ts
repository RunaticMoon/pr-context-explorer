import { test, expect } from "@playwright/test";
test("live connection save, exact-host rejection, cache inventory and demo remain distinct", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "실제 GitHub 연결" }),
  ).toBeVisible();
  await page
    .getByText("고급 기존 인증 설정 · gh / 환경변수 / 공개 URL", {
      exact: true,
    })
    .click();
  await page.getByLabel("연결 ID", { exact: true }).fill("browser-public");
  await page.getByLabel("계정 식별자", { exact: true }).fill("public");
  await page
    .locator("select")
    .filter({ has: page.locator('option[value="public"]') })
    .selectOption("public");
  await page.getByRole("button", { name: "연결 저장", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("저장");
  // Legacy non-secret configuration is still supported through the protected API.
  // Actual simple HTTPS onboarding is covered by jira-simple.spec.ts.
  const saved = await page.evaluate(async () => {
    const session = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const { csrf } = await session.json();
    const response = await fetch("/api/jira/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PRCE-CSRF": csrf },
      body: JSON.stringify({
        connections: [
          {
            id: "browser-jira",
            deployment: "cloud",
            webBaseUrl: "https://tickets.example.invalid",
            apiBaseUrl: "https://tickets.example.invalid",
            accountContextId: "anonymous",
            authentication: "anonymous",
          },
        ],
        projectHosts: { TEAM: ["browser-jira"] },
      }),
    });
    return { status: response.status, body: await response.text() };
  });
  expect(saved.status, saved.body).toBe(201);
  await page.reload();
  await page.getByRole("tab", { name: "Jira", exact: true }).click();
  await expect(
    page.getByText("anonymous · https://tickets.example.invalid", {
      exact: false,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "내 PR / URL 열기", exact: true })
    .click();
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
  await expect(page.getByRole("button", { name: "PR #1 열기" })).toBeVisible();
});
