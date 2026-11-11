import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  // Scan the app, excluding HTML in local backups and browser-test artifacts.
  optimizeDeps: { entries: ["index.html"] },
  server: {
    watch: {
      ignored: ["**/.local/**", "**/test-results/**", "**/playwright-report/**"],
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Leafmark — your reading space",
        short_name: "Leafmark",
        description: "Your books, notes, and place in every story.",
        theme_color: "#315c86",
        background_color: "#f5f7fa",
        display: "standalone",
        start_url: "./",
        scope: "./",
        icons: [
          {
            src: "icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          {
            src: "icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        // PDF.js uses an ES-module worker plus PFB/TTF fallback fonts. These
        // must be available before a reader is reopened without networking.
        globPatterns: ["**/*.{js,mjs,css,html,svg,png,woff,woff2,ttf,pfb,wasm,bcmap,bin}", "dictionary/*.json"],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  build: { target: "es2022" },
});
