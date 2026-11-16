import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testMatch: ["tablet-reading.spec.ts", "book-turns.spec.ts"],
  testIgnore: [],
  outputDir: "test-results/tablet",
  projects: [
    { name: "android-tablet", use: { ...devices["Galaxy Tab S4"], browserName: "chromium", viewport: { width: 800, height: 1280 } } },
    { name: "ipad", use: { ...devices["iPad (gen 7)"], browserName: "webkit", viewport: { width: 810, height: 1080 } } },
  ],
});
