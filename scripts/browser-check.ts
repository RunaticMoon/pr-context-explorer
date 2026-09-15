import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1500, height: 1000 },
  });
  const errors: string[] = [],
    requests: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(
    "http://127.0.0.1:4393/?page=live-workspace&snapshot=f8530256bc0d9afceac634600003c0809d407b10fcd51cbb2961db96dede2d5c",
  );
  await page
    .getByRole("heading", { name: "Edited README via GitHub" })
    .waitFor({ state: "visible", timeout: 10000 })
    .catch(async () => {
      await page.locator(".timeline").waitFor();
    });
  await page.screenshot({
    path: "artifacts/core-public-workspace.png",
    fullPage: true,
  });
  await page.locator("button.file").filter({ hasText: "README" }).click();
  await page.getByTestId("live-evidence-location").waitFor();
  await page.screenshot({
    path: "artifacts/core-public-code.png",
    fullPage: true,
  });
  const result = {
    source: "actual public octocat/Hello-World PR #1; model not invoked",
    title: await page.locator("h1").first().textContent(),
    evidence: await page.getByTestId("live-evidence-location").textContent(),
    consoleErrors: errors,
    externalBrowserRequests: requests.filter(
      (u) => !u.startsWith("http://127.0.0.1:4393/"),
    ),
    screenshotInspection:
      "captured; Browser Use visual tool blocked by unsupported configured real profile",
  };
  writeFileSync(
    "artifacts/core-browser-check.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
