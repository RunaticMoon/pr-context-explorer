import { test, expect } from "@playwright/test";
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("real source form connects to local HTTPS Jira protocol fixture and clears typed token", async ({
  page,
}) => {
  const root = mkdtempSync(join(tmpdir(), "jira-browser-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(root, "key.pem"),
      "-out",
      join(root, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(join(root, "cert.pem"), "utf8");
  const seen: string[] = [];
  const server = createServer(
    { key: readFileSync(join(root, "key.pem")), cert },
    (req, res) => {
      seen.push(req.url!);
      expect(req.headers.authorization).toBe(
        "Basic " +
          Buffer.from("fixture@example.test:BROWSER-FAKE-ONLY").toString(
            "base64",
          ),
      );
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          req.url!.endsWith("/myself")
            ? { accountId: "browser-fixture-account" }
            : { version: "fixture-version" },
        ),
      );
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await page.goto("/");
    await page.getByRole("tab", { name: "Jira", exact: true }).click();
    await page
      .getByLabel("Jira Web URL")
      .fill(`https://localhost:${(server.address() as any).port}`);
    await page.getByLabel("Jira 이메일").fill("fixture@example.test");
    await page.getByLabel("Jira API 토큰").fill("BROWSER-FAKE-ONLY");
    await page.getByText("고급 설정 (선택)", { exact: true }).click();
    await page.getByLabel("Jira 사용자 CA PEM").fill(cert);
    const reply = page.waitForResponse((r) =>
      r.url().endsWith("/api/jira/connect"),
    );
    await page.getByRole("button", { name: "Jira 연결 및 자동 확인" }).click();
    const response = await reply;
    expect(response.status(), await response.text()).toBe(201);
    await expect(page.getByTestId("jira-connection-summary")).toContainText(
      "browser-fixture-account",
    );
    await expect(page.getByTestId("jira-connection-summary")).toContainText(
      "/rest/api/3",
    );
    await expect(page.getByLabel("Jira API 토큰")).toHaveValue("");
    expect(seen).toEqual(["/rest/api/3/myself", "/rest/api/3/serverInfo"]);
    expect(
      await page.evaluate(() => JSON.stringify([localStorage, sessionStorage])),
    ).not.toContain("BROWSER-FAKE-ONLY");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("Jira simple form separates Cloud Enterprise plan from Data Center and hides derived fields", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Jira", exact: true }).click();
  await expect(page.getByLabel("Jira 배포")).toBeVisible();
  await expect(page.getByLabel("Jira 배포")).toContainText(
    "Cloud (Enterprise 플랜 포함)",
  );
  await expect(page.getByLabel("Jira 배포")).toContainText(
    "Enterprise 서버 (Data Center)",
  );
  await expect(page.getByLabel("Jira Web URL")).toBeVisible();
  await expect(page.getByLabel("Jira 이메일")).toBeVisible();
  await expect(page.getByLabel("Jira API 토큰")).toHaveAttribute(
    "type",
    "password",
  );
  await expect(page.getByLabel("Jira 계정 맥락")).toHaveCount(0);
  await expect(page.getByLabel("Jira 연결 ID")).toHaveCount(0);
  await expect(page.getByLabel("Jira API base URL")).not.toBeVisible();
  await page.getByLabel("Jira 배포").selectOption("data_center");
  await expect(page.getByLabel("Jira 이메일")).toHaveCount(0);
  await expect(page.getByLabel("Jira PAT")).toHaveAttribute("type", "password");
  await expect(
    page.getByText("토큰은 메모리에만 보관 · 앱 종료 시 삭제", {
      exact: false,
    }),
  ).toBeVisible();
});
