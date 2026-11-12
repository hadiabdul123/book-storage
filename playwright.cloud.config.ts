import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/cloud",
  workers: 1,
  timeout: 90_000,
  outputDir: "test-results/cloud",
  use: { baseURL: "http://127.0.0.1:4175", trace: "retain-on-failure" },
  webServer: {
    command: "npm run dev -- --port 4175 --strictPort",
    url: "http://127.0.0.1:4175",
    reuseExistingServer: false,
    env: {
      VITE_SUPABASE_URL: "https://cloud.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
      VITE_BASE_PATH: "/",
    },
  },
});
