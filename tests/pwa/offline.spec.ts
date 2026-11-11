import { chromium, expect, test } from "@playwright/test";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";

test("saved PDF notes and rendering assets survive a full offline browser restart", async ({
  baseURL,
}) => {
  // Chromium's cache adds deep paths: generated test-result names can exceed
  // Windows path limits and prevent service workers from being persisted.
  const profileRoot = path.resolve(".local");
  mkdirSync(profileRoot, { recursive: true });
  const profile = mkdtempSync(path.join(profileRoot, "pwa-"));
  const options = {
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
  };
  const online = await chromium.launchPersistentContext(profile, options);
  try {
    const page = await online.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") console.error(message.text());
    });
    await page.goto(baseURL!);
    await expect(page.getByRole("heading", {
      name: "A little space for a lot of reading",
    })).toBeVisible();
    await expect.poll(() => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return {
        active: registration?.active?.state,
        installing: registration?.installing?.state,
        waiting: registration?.waiting?.state,
      };
    }), { timeout: 45_000, message: "Production service worker activates" }).toMatchObject({
      active: "activated",
    });
    // Prompt-based updates intentionally leave existing pages under their old
    // controller. Reload after first installation to use the active worker.
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await page.locator("input[type=file]").setInputFiles(
      path.resolve("tests/fixtures/tracemonkey.pdf"),
    );
    await expect(page.locator(".book-card")).toHaveCount(1);
    await page.locator(".book-cover-link").click();
    await expect(page.locator(".pdf-page .textLayer span").first()).toBeVisible();
    await page.locator(".pdf-page .textLayer").first().evaluate((layer) => {
      const span = Array.from(layer.querySelectorAll("span")).find(
        (element) => (element.textContent?.length || 0) > 20,
      )!;
      const range = document.createRange();
      range.selectNodeContents(span);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await page.getByRole("textbox", { name: "Note for selected passage" }).fill(
      "Retained across an offline browser restart",
    );
    await page.getByRole("button", { name: "Save highlight", exact: true }).click();
    await expect(page.locator(".pdf-highlight").first()).toBeVisible();
    await page.getByRole("button", { name: "Page notes", exact: true }).click();
    const notebook = page.getByRole("textbox", { name: "Notebook for page 1" });
    await expect(notebook).toHaveAttribute("contenteditable", "true");
    await notebook.fill("Offline notebook survives restart");
    await page.getByRole("button", { name: "Bullet list", exact: true }).click();
    await page.getByRole("button", { name: "Save now", exact: true }).click();
    await expect(page.locator(".notebook-status")).toHaveText("Saved on this device");
    await page.getByRole("button", { name: "Close panel" }).click();
    // Keep IndexedDB/CacheStorage, but prevent the ordinary HTTP cache from
    // concealing missing service-worker assets during the offline restart.
    const session = await online.newCDPSession(page);
    await session.send("Network.clearBrowserCache");
    await session.detach();
  } finally {
    await online.close();
  }

  // A fresh process/profile session cannot reuse the previous page's PDF worker.
  const offline = await chromium.launchPersistentContext(profile, {
    ...options,
    offline: true,
  });
  const errors: string[] = [];
  try {
    const page = await offline.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(baseURL!);
    await expect(page.locator(".book-card")).toHaveCount(1);
    await page.locator(".book-cover-link").click();
    await expect(page.locator(".pdf-page .textLayer span").first()).toBeVisible();
    await expect(page.locator(".pdf-highlight").first()).toBeVisible();
    await page.getByRole("button", { name: "Highlights and notes", exact: true }).click();
    await expect(page.getByText("Retained across an offline browser restart")).toBeVisible();
    await page.locator(".annotation-card").filter({ hasText: "Retained across an offline browser restart" }).getByRole("button", { name: "Go to passage", exact: true }).click();
    await expect(page.locator(".pdf-highlight").first()).toBeVisible();
    await page.getByRole("button", { name: "Page notes", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Notebook for page 1" })).toContainText("Offline notebook survives restart");
    await expect(page.getByRole("textbox", { name: "Notebook for page 1" }).locator("li")).toHaveCount(1);
    await page.getByRole("button", { name: "Dictionary", exact: true }).click();
    // This word was never looked up in the online browser process.
    const external: string[] = [];
    page.on("request", request => { if (new URL(request.url()).origin !== new URL(baseURL!).origin) external.push(request.url()); });
    await page.getByLabel("Dictionary word").fill("serendipity");
    await page.getByRole("button", { name: "Look up", exact: true }).click();
    await expect(page.locator(".dictionary-entry h3").first()).toHaveText("serendipity");
    expect(external).toEqual([]);
    // Exercise both standard font formats even when the fixture embeds its fonts.
    const assets = await page.evaluate(async () => {
      const files = [
        "pdf-assets/standard_fonts/FoxitSerif.pfb",
        "pdf-assets/standard_fonts/LiberationSans-Regular.ttf",
        "pdf-assets/cmaps/Adobe-Japan1-UCS2.bcmap",
        "pdf-assets/wasm/openjpeg.wasm",
      ];
      return Promise.all(files.map(async (file) => {
        const response = await fetch(new URL(file, document.baseURI));
        return { file, ok: response.ok, bytes: (await response.arrayBuffer()).byteLength };
      }));
    });
    for (const asset of assets) {
      expect(asset.ok, asset.file).toBe(true);
      expect(asset.bytes, asset.file).toBeGreaterThan(0);
    }
    expect(errors).toEqual([]);
  } finally {
    await offline.close();
    if (path.dirname(profile) !== profileRoot) throw new Error("Unexpected test profile path");
    rmSync(profile, { recursive: true, force: true });
  }
});
