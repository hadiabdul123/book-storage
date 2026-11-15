import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/pwa-cloud", timeout: 120000, workers: 1,
  outputDir: "test-results/pwa-cloud", use: { baseURL: "http://127.0.0.1:4176" },
  webServer: {
    command: "npm run build -- --outDir .local/pwa-cloud-dist && npm run preview -- --port 4176 --strictPort --outDir .local/pwa-cloud-dist",
    url: "http://127.0.0.1:4176", timeout: 120000, reuseExistingServer: false,
    env: { VITE_SUPABASE_URL: "https://cloud.supabase.co", VITE_SUPABASE_PUBLISHABLE_KEY: "test-publishable-key", VITE_BASE_PATH: "/" },
  },
});
