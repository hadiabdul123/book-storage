import { defineConfig } from "@playwright/test";
import config from "./playwright.config";

export default defineConfig({
  ...config,
  testDir: "./tests/private",
  outputDir: ".local/private-test-results",
  timeout: 120_000,
  workers: 1,
  use: { ...config.use, trace: "off", screenshot: "off", video: "off" },
  projects: [{ name: "private-desktop", use: { viewport: { width: 1440, height: 1000 } } }],
});
