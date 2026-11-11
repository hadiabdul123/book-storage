import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/pwa",
  timeout: 90_000,
  workers: 1,
  outputDir: "test-results/pwa",
  use: { baseURL: "http://127.0.0.1:4174" },
  webServer: {
    command: "npm run build -- --outDir .local/pwa-test-dist && npm run preview -- --port 4174 --strictPort --outDir .local/pwa-test-dist",
    url: "http://127.0.0.1:4174",
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      VITE_SUPABASE_URL: "",
      VITE_SUPABASE_PUBLISHABLE_KEY: "",
      VITE_BASE_PATH: "/",
    },
  },
});
