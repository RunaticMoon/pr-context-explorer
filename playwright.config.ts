import path from "node:path";
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  use: {
    baseURL: "http://127.0.0.1:4317",
    headless: true,
    viewport: { width: 1500, height: 1000 },
  },
  webServer: {
    command: "npm start",
    env: { PRCE_DATA_DIR: path.resolve(".data/e2e-live") },
    url: "http://127.0.0.1:4317",
    reuseExistingServer: false,
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
