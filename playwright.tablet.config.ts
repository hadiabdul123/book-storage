import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  // Real PDF fits, decoded previews and a curl can queue on WebKit in CI.
  // Share the existing PDF-render budget; timing-specific checks stay explicit.
  expect: { ...base.expect, timeout: 15_000 },
  testMatch: ["tablet-reading.spec.ts", "book-turns.spec.ts", "reading-smoothness.spec.ts", "reading-upgrade.spec.ts", "organization.spec.ts", "gesture-safety.spec.ts", "notebook-workspace.spec.ts"],
  testIgnore: [],
  outputDir: "test-results/tablet",
  projects: [
    { name: "android-tablet", use: { ...devices["Galaxy Tab S4"], browserName: "chromium", viewport: { width: 800, height: 1280 } } },
    { name: "ipad", use: { ...devices["iPad (gen 7)"], browserName: "webkit", viewport: { width: 810, height: 1080 } } },
  ],
});
