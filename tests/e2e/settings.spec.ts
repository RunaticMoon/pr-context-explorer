import { test, expect } from "@playwright/test";
test("fresh root is real tabbed onboarding, not config-only demo", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("tab", { name: "GitHub", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("github-simple-panel")).toBeVisible();
  await expect(page.getByText("LOCAL FIRST / STAGE 1")).toHaveCount(0);
  await expect(page.getByLabel("API base URL (자동 감지)")).not.toBeVisible();
  await page
    .getByRole("tab", { name: "GitHub", exact: true })
    .press("ArrowRight");
  await expect(page.getByRole("tab", { name: "분석 엔진" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("tab", { name: "분석 엔진" }).press("End");
  await expect(
    page.getByRole("tab", { name: "Jira", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

// Intercepted display fixture only: no real account, auth or inference claims.
test("friendly labels, responsive tabs and ephemeral drafts (FAKE display fixture)", async ({
  page,
}) => {
  let engineReads = 0,
    inferenceCalls = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/engines/setup") engineReads++;
    if (new URL(request.url()).pathname === "/api/live/run") inferenceCalls++;
  });
  const id = "gh-FAKE-opaque-connection-id";
  await page.route("**/api/connections", (route) =>
    route.fulfill({
      json: {
        connections: [
          {
            id,
            type: "github",
            account: "jude-moon",
            webUrl: "https://github.com",
            apiUrl: "https://api.github.com",
            apiVersion: "2022-11-28",
            auth: { kind: "session" },
            credentialState: "session",
          },
        ],
      },
    }),
  );
  await page.goto("/");
  await expect(page.getByLabel("승인된 연결")).toContainText(
    "jude-moon · GitHub",
  );
  expect(await page.getByLabel("승인된 연결").inputValue()).toBe(id);
  expect(await page.getByLabel("승인된 연결").textContent()).not.toContain(id);
  const secret = "FAKE-unsubmitted-draft";
  await page.getByLabel("Personal access token (PAT)").fill(secret);
  await page.getByRole("tab", { name: "Jira", exact: true }).click();
  await page.getByRole("tab", { name: "GitHub", exact: true }).click();
  await expect(page.getByLabel("Personal access token (PAT)")).toHaveValue("");
  expect(
    await page.evaluate(() => JSON.stringify([localStorage, sessionStorage])),
  ).not.toContain(secret);
  for (const [size, width, height] of [
    ["desktop", 1280, 800],
    ["medium", 960, 720],
    ["narrow", 760, 700],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(
      (size) =>
        (document.documentElement.style.fontSize =
          size === "narrow" ? "17.5px" : "14px"),
      size,
    );
    for (const [id, label] of [
      ["github", "GitHub"],
      ["engine", "분석 엔진"],
      ["jira", "Jira"],
    ] as const) {
      await page.getByRole("tab", { name: label, exact: true }).click();
      await page.evaluate(() => document.fonts.ready);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `artifacts/settings-ux/${id}-${size}.png`,
        fullPage: true,
      });
    }
  }
  expect(engineReads).toBe(1);
  expect(inferenceCalls).toBe(0);
  await page.getByRole("tab", { name: "GitHub", exact: true }).click();
  await page
    .getByRole("button", { name: "연결 확인 및 저장", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "연결 확인 및 저장", exact: true }),
  ).toBeInViewport();
  await page.getByText("고급 API 설정 (선택)", { exact: true }).click();
  await page
    .getByLabel("API base URL (자동 감지)")
    .fill(
      "https://" + "enterprise-context".repeat(15) + ".example.test/api/v3",
    );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("legacy route and demo isolation tolerate fixture failure", async ({
  page,
}) => {
  await page.route("**/api/snapshot", (r) =>
    r.fulfill({ status: 500, json: { error: "FAKE demo unavailable" } }),
  );
  await page.goto("/?page=connections");
  await expect(page.getByTestId("github-simple-panel")).toBeVisible();
  await page.getByRole("tab", { name: "분석 엔진" }).click();
  await page.goBack();
  await expect(
    page.getByRole("tab", { name: "GitHub", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});
