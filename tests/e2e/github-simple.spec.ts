import { test, expect } from "@playwright/test";
import { createApp } from "../../src/server/http.ts";
import { GitHubClient } from "../../src/server/github.ts";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("real loopback session + CSRF PAT onboarding uses HTTPS fixture, clears input, survives refresh without storing PAT", async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "github-ui-"));
  const token = "FAKE-browser-PAT-not-a-real-account";
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      dir + "/key",
      "-out",
      dir + "/cert",
      "-days",
      "1",
      "-subj",
      "/CN=fixture.github.test",
      "-addext",
      "subjectAltName=DNS:fixture.github.test",
    ],
    { stdio: "ignore" },
  );
  let calls = 0,
    upstreamStatus = 200;
  const upstream = https.createServer(
    { key: readFileSync(dir + "/key"), cert: readFileSync(dir + "/cert") },
    (req, res) => {
      calls++;
      expect(req.headers.authorization).toBe("Bearer " + token);
      expect(req.url).toBe("/api/v3/user");
      if (upstreamStatus !== 200) {
        res.writeHead(upstreamStatus, {
          "Content-Type": "application/json",
          Location: "https://evil.invalid/never-follow",
          "X-GitHub-SSO": "required",
        });
        res.end(JSON.stringify({ message: token }));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "X-GitHub-Enterprise-Version": "3.15.1",
      });
      res.end(JSON.stringify({ login: "fixture-alice", id: 71 }));
    },
  );
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = (upstream.address() as any).port;
  const app = await createApp(0, {
    dataDir: dir + "/data",
    client: (c) =>
      new GitHubClient(c, {
        transport: async (url, headers) =>
          new Promise((resolve, reject) => {
            const u = new URL(url);
            const req = https.request(
              {
                hostname: "127.0.0.1",
                port: upstreamPort,
                servername: "fixture.github.test",
                ca: readFileSync(dir + "/cert"),
                rejectUnauthorized: true,
                path: u.pathname,
                headers,
                method: "GET",
              },
              (res) => {
                let body = "";
                res.on("data", (b) => (body += b));
                res.on("end", () =>
                  resolve({
                    status: res.statusCode!,
                    body,
                    headers: res.headers as Record<string, string>,
                  }),
                );
              },
            );
            req.on("error", reject);
            req.end();
          }),
      }),
  });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + (app.address() as any).port;
  try {
    await page.goto(base);
    const panel = page.getByTestId("github-simple-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator("input:visible")).toHaveCount(2);
    await panel
      .getByLabel("Web URL", { exact: true })
      .fill("https://fixture.github.test");
    const pat = panel.getByLabel("Personal access token (PAT)", {
      exact: true,
    });
    await expect(pat).toHaveAttribute("type", "password");
    await pat.fill(token);
    const blocked = await page.request.post(base + "/api/connections/connect", {
      data: { webUrl: "https://fixture.github.test", token },
    });
    expect(blocked.status()).toBe(403);
    expect(calls).toBe(0);
    await panel.getByRole("button", { name: "연결 확인 및 저장" }).click();
    await expect(pat).toHaveValue("");
    await expect(page.getByTestId("github-verified-account")).toContainText(
      "fixture-alice",
    );
    await expect(page.getByTestId("github-verified-account")).toContainText(
      "3.15.1",
    );
    expect(calls).toBe(1);
    expect(
      await page.evaluate(() => JSON.stringify([localStorage, sessionStorage])),
    ).not.toContain(token);
    expect(await page.content()).not.toContain(token);
    await page.reload();
    await expect(page.getByTestId("github-verified-account")).toContainText(
      "fixture-alice",
    );
    await expect(page.getByTestId("github-verified-account")).toContainText(
      "앱 종료 시 삭제",
    );
    for (const status of [401, 403, 407, 302]) {
      upstreamStatus = status;
      await panel
        .getByLabel("Web URL", { exact: true })
        .fill("https://fixture.github.test");
      await pat.fill(token);
      await panel.getByRole("button", { name: "연결 확인 및 저장" }).click();
      await expect(panel.getByRole("alert")).toContainText(
        "연결하지 못했습니다",
      );
      await expect(pat).toHaveValue("");
      expect(await page.content()).not.toContain(token);
    }
    expect(calls).toBe(5); // no redirect replay, no automatic credential probes
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
