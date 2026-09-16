import { test, expect } from "@playwright/test";

// Real createApp server and browser cookies. No API interception, tokens or remote access.
test("one session bootstrap supports live saves, reload, demo and browser back", async ({
  page,
}) => {
  const bootstrapResponses: number[] = [];
  page.on("response", (r) => {
    if (new URL(r.url()).pathname === "/api/session")
      bootstrapResponses.push(r.status());
  });
  const save = async (account: string) => {
    const advanced = page
      .locator("details")
      .filter({
        has: page.getByText("고급 기존 인증 설정 · gh / 환경변수 / 공개 URL", {
          exact: true,
        }),
      });
    if (!(await page.getByLabel("계정 식별자", { exact: true }).isVisible()))
      await advanced.locator("summary").click();
    await page.getByLabel("계정 식별자", { exact: true }).fill(account);
    await page
      .locator("select")
      .filter({ has: page.locator('option[value="public"]') })
      .selectOption("public");
    const response = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/connections" &&
        r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "연결 저장", exact: true }).click();
    const r = await response;
    expect(r.status(), await r.text()).toBe(201);
    const saved = await page.request.get("/api/connections");
    expect(
      (await saved.json()).connections.some(
        (c: any) => c.account === account && c.auth.kind === "public",
      ),
    ).toBe(true);
  };
  await page.goto("/?page=live-connections");
  await save("core-regression-first");
  expect(bootstrapResponses).toEqual([200]);
  await page.reload();
  await save("core-regression-reload");
  expect(bootstrapResponses).toEqual([200, 200]);
  await page.getByRole("button", { name: "명시적 데모로 돌아가기" }).click();
  await expect(
    page.getByText("MockProvider", { exact: true }).first(),
  ).toBeVisible();
  await page.goBack();
  await save("core-regression-back");
  await page.getByRole("button", { name: "명시적 데모로 돌아가기" }).click();
  await page.getByRole("button", { name: "실제 PR 연결", exact: true }).click();
  await save("core-regression-demo-live");
  expect(bootstrapResponses).toEqual([200, 200]);
});
