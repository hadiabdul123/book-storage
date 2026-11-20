import { scanPdf } from "../helpers/scanned-pdf";
import { openTools, clickTool, observePaperTurns } from "../e2e/controls";
import { chromium, expect, test } from "@playwright/test";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";

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
    await page.addInitScript(() =>
      localStorage.setItem("leafmark-controls-pinned", "true"),
    );
    await page.goto(baseURL!);
    await expect(
      page.getByRole("heading", {
        name: "A little space for a lot of reading",
      }),
    ).toBeVisible();
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const registration =
              await navigator.serviceWorker.getRegistration();
            return {
              active: registration?.active?.state,
              installing: registration?.installing?.state,
              waiting: registration?.waiting?.state,
            };
          }),
        { timeout: 45_000, message: "Production service worker activates" },
      )
      .toMatchObject({
        active: "activated",
      });
    // Prompt-based updates intentionally leave existing pages under their old
    // controller. Reload after first installation to use the active worker.
    await page.reload();
    await openTools(page);
    await expect
      .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
      .toBe(true);
    await page
      .locator("input[type=file]")
      .setInputFiles(path.resolve("tests/fixtures/tracemonkey.pdf"));
    await expect(page.locator(".book-card")).toHaveCount(1);
    await page.locator(".book-cover-link").click();
    await openTools(page);
    await expect(
      page.locator(".pdf-page .textLayer span").first(),
    ).toBeVisible();
    await page.route("https://*.wikipedia.org/**", (route) => route.fulfill({ json: {
      query: { pages: [{ ns: 0, title: "Cognitive dissonance", extract: "Discomfort when beliefs and actions conflict." }] },
    } }));
    await clickTool(page, "Dictionary");
    await page.getByLabel("Dictionary word").fill("cognitive dissonance");
    await page.getByRole("button", { name: "Look up", exact: true }).click();
    await page.getByRole("button", { name: "Find another explanation", exact: true }).click();
    await expect(page.locator(".dictionary-reference")).toContainText("Discomfort when beliefs");
    const panelTextLayer = await page.locator(".pdf-page .textLayer").first().elementHandle();
    await page.getByRole("button", { name: "Close panel" }).click();
    // Closing a docked panel changes fit-width and replaces the old text layer.
    // Select from the completed layout rather than a range about to be detached.
    await expect.poll(() => panelTextLayer!.evaluate(el => el.isConnected)).toBe(false);
    await expect(page.locator(".pdf-page .textLayer span").first()).toBeVisible();
    // A queued fit pass can replace another layer after the first replacement.
    // Reacquire the range until the note editor opens; no writing is done yet.
    await expect(async () => {
      if (await page.getByRole("textbox", { name: "Note for selected passage" }).isVisible()) return;
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
      await page.getByRole("button", { name: "Add note", exact: true }).click({ timeout: 1000 });
      await expect(page.getByRole("textbox", { name: "Note for selected passage" })).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 10000 });
    await page
      .getByRole("textbox", { name: "Note for selected passage" })
      .fill("Retained across an offline browser restart");
    await page.getByRole("button", { name: "Save note", exact: true }).click();
    await expect(page.locator(".pdf-highlight").first()).toBeVisible();
    await page
      .getByRole("button", { name: "Bookmark passage", exact: true })
      .click();
    await expect(page.locator(".passage-bookmark")).toHaveCount(1);
    await clickTool(page, "Add bookmark");
    await expect(
      page.getByRole("button", { name: "Remove bookmark", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await clickTool(page, "Page notes");
    const notebook = page.getByRole("textbox", { name: "Notebook for page 1" });
    await expect(notebook).toHaveAttribute("contenteditable", "true");
    await notebook.fill("Offline notebook survives restart");
    await page
      .getByRole("button", { name: "Bullet list", exact: true })
      .click();
    await page.getByRole("button", { name: "Save now", exact: true }).click();
    await expect(page.locator(".notebook-status")).toHaveText(
      "Saved on this device",
    );
    await page.getByRole("button", { name: "Close panel" }).click();
    await page.getByRole("link", { name: "Back to library", exact: true }).click();
    await page
      .locator("input[type=file]")
      .setInputFiles({
        name: "Original scan.pdf",
        mimeType: "application/pdf",
        buffer: await scanPdf(page),
      });
    await expect(page.locator(".book-card")).toHaveCount(2);
    // A waiting release must activate without waiting for the (offline/local)
    // outbox to empty. The persisted notes and operations must survive reload.
    const pendingOperations = () => page.evaluate(() => new Promise<unknown[]>((resolve, reject) => {
      const request = indexedDB.open("leafmark-v1");
      request.onsuccess = () => {
        const database = request.result;
        const operations = database.transaction("outbox").objectStore("outbox").getAll();
        operations.onsuccess = () => { resolve(operations.result); database.close(); };
        operations.onerror = () => { reject(operations.error); database.close(); };
      };
      request.onerror = () => reject(request.error);
    }));
    const pendingBefore = await pendingOperations();
    expect(pendingBefore.length).toBeGreaterThan(0);
    const workerPath = path.resolve(".local/pwa-test-dist/sw.js");
    const workerSource = readFileSync(workerPath, "utf8");
    try {
      writeFileSync(workerPath, workerSource + `\n// update regression ${Date.now()}\n`);
      await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
      await expect(page.getByRole("button", { name: "Update", exact: true })).toBeVisible();
      await Promise.all([
        page.waitForEvent("load"),
        page.getByRole("button", { name: "Update", exact: true }).click(),
      ]);
      await expect(page.locator(".book-card")).toHaveCount(2);
      // Preparation can append book operations during the worker update.
      // Verify the original IDs and payloads survive, rather than freezing its count.
      expect(await pendingOperations()).toEqual(expect.arrayContaining(pendingBefore));
    } finally { writeFileSync(workerPath, workerSource); }
    // Topic writing and offline research jobs use the same durable database.
    await page.goto(new URL("#/notebooks", baseURL!).href);
    await page.getByRole("button", { name: "New notebook", exact: true }).click();
    await page.getByLabel("Notebook name").fill("Offline research");
    await page.getByRole("button", { name: "Create notebook", exact: true }).click();
    await page.getByRole("button", { name: "New page", exact: true }).click();
    await page.getByRole("textbox", { name: "Topic note title" }).fill("Ideas kept offline");
    await page.getByRole("textbox", { name: "Topic note content" }).fill("Writing survives a full offline restart.");
    await page.getByRole("button", { name: "Save now", exact: true }).click();
    await expect(page.locator(".topic-save-status")).toContainText("Saved on this device");
    await page.getByRole("button",{name:"Tools",exact:true}).click();
    await page.getByRole("button", { name: "Research", exact: true }).click();
    await online.setOffline(true);
    await page.getByRole("textbox", { name: "Research question" }).fill("What evidence supports cosmic expansion?");
    await page.getByText("More actions", { exact: true }).click();
    await page.getByRole("button", { name: "Search the web", exact: true }).click();
    await expect(page.locator(".research-pending")).toContainText("cosmic expansion");
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
  offline.setDefaultTimeout(10000);
  const errors: string[] = [];
  try {
    const page = await offline.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() =>
      localStorage.setItem("leafmark-controls-pinned", "true"),
    );
    await page.goto(baseURL!);
    await expect(page.locator(".book-card")).toHaveCount(2);
    await page
      .locator(".book-card")
      .filter({ hasText: "tracemonkey" })
      .locator(".book-cover-link")
      .click();
    await openTools(page);
    await expect(
      page.locator(".pdf-page .textLayer span").first(),
    ).toBeVisible();
    await expect(page.locator(".pdf-highlight").first()).toBeVisible();
    await expect(page.locator(".update-banner")).toHaveCount(0);
    await clickTool(page, "Highlights and notes");
    await expect(
      page.getByText("Retained across an offline browser restart"),
    ).toBeVisible();
    await page
      .locator(".annotation-card")
      .filter({ hasText: "Retained across an offline browser restart" })
      .getByRole("button", { name: "Go to passage", exact: true })
      .click();
    await expect(page.locator(".pdf-highlight").first()).toBeVisible();
    await clickTool(page, "Page notes");
    await expect(
      page.getByRole("textbox", { name: "Notebook for page 1" }),
    ).toContainText("Offline notebook survives restart");
    await expect(
      page.getByRole("textbox", { name: "Notebook for page 1" }).locator("li"),
    ).toHaveCount(1);
    await expect(page.locator(".passage-bookmark")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Remove bookmark", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await clickTool(page, "Dictionary");
    // This word was never looked up in the online browser process.
    const external: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).origin !== new URL(baseURL!).origin)
        external.push(request.url());
    });
    await page.getByLabel("Dictionary word").fill("serendipity");
    await page.getByRole("button", { name: "Look up", exact: true }).click();
    await expect(page.locator(".dictionary-entry h3").first()).toHaveText(
      "serendipity",
    );
    await page.getByLabel("Dictionary word").fill("comfort");
    await page.getByRole("button", { name: "Look up", exact: true }).click();
    await expect(page.locator(".dictionary-entry")).toContainText(
      "Simple meaning",
    );
    expect(external).toEqual([]);
    await page.getByLabel("Dictionary word").fill("psychic entropy");
    await page.getByRole("button", { name: "Look up", exact: true }).click();
    await expect(page.locator(".dictionary-entry").first()).toContainText("Plain-English explanation");
    await page.getByLabel("Dictionary word").fill("cognitive dissonance");
    await page.getByRole("button", { name: "Look up", exact: true }).click();
    await expect(page.locator(".dictionary-reference")).toContainText("Discomfort when beliefs");
    expect(external).toEqual([]);
    // Exercise both standard font formats even when the fixture embeds its fonts.
    const assets = await page.evaluate(async () => {
      const files = [
        "pdf-assets/standard_fonts/FoxitSerif.pfb",
        "pdf-assets/standard_fonts/LiberationSans-Regular.ttf",
        "pdf-assets/cmaps/Adobe-Japan1-UCS2.bcmap",
        "pdf-assets/wasm/openjpeg.wasm",
      ];
      return Promise.all(
        files.map(async (file) => {
          const response = await fetch(new URL(file, document.baseURI));
          return {
            file,
            ok: response.ok,
            bytes: (await response.arrayBuffer()).byteLength,
          };
        }),
      );
    });
    for (const asset of assets) {
      expect(asset.ok, asset.file).toBe(true);
      expect(asset.bytes, asset.file).toBeGreaterThan(0);
    }
    await page.getByRole("button", { name: "Close panel" }).click();
    // The locally bundled curl engine must work on a fresh offline start.
    await clickTool(page, "Reading settings");
    await page.getByRole("combobox", { name: "Navigation", exact: true }).selectOption("paginated");
    await page.getByRole("combobox", { name: "Fit", exact: true }).selectOption("page");
    await page.getByRole("button", { name: "Close panel", exact: true }).click();
    const turns = await observePaperTurns(page);
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect.poll(turns).toBe(1);
    await expect(page.locator(".reader-progress")).toContainText("Page 2");
    await page.getByRole("link", { name: "Back to library", exact: true }).click();
    await page
      .locator(".book-card")
      .filter({ hasText: "Original scan" })
      .locator(".book-cover-link")
      .click();
    // Automatic OCR has never run in this profile: its worker/model must load offline.
    await expect(page.locator(".ocr-text-layer")).toContainText(
      "Reading opens",
      { timeout: 30000 },
    );
    await page.goto(new URL("#/notebooks", baseURL!).href);
    await page.getByRole("button", { name: /^Ideas kept offline/ }).click();
    await expect(page.getByRole("textbox", { name: "Topic note content" })).toContainText("full offline restart");
    await page.getByRole("button",{name:"Tools",exact:true}).click();
    await page.getByRole("button", { name: "Research", exact: true }).click();
    await expect(page.locator(".research-pending")).toContainText("cosmic expansion");
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await offline.close();
    if (path.dirname(profile) !== profileRoot)
      throw new Error("Unexpected test profile path");
    rmSync(profile, { recursive: true, force: true });
  }
});


test("a missing release module offers a deliberate reload and preserves the saved book", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    await page.goto(baseURL!);
    await page.locator("input[type=file]").setInputFiles(path.resolve("tests/fixtures/tracemonkey.pdf"));
    await expect(page.locator(".book-card")).toHaveCount(1);
    await page.route("**/assets/*.js", route => route.abort());
    await page.locator(".book-cover-link").click();
    await expect(page.locator(".update-banner")).toContainText("A reading tool could not load");
    await expect(page).toHaveURL(/#\/read\//);
    await page.unroute("**/assets/*.js");
    await page.getByRole("link", { name: "Back to library to reload" }).click();
    await expect(page.locator(".book-card")).toHaveCount(1);
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: "Reload Leafmark", exact: true }).click(),
    ]);
    await expect(page.locator(".book-card")).toHaveCount(1);
    await page.locator(".book-cover-link").click();
    await expect(page.locator(".pdf-page .textLayer span").first()).toBeVisible();
    await expect(page.locator(".update-banner")).toHaveCount(0);
  } finally { await context.close(); }
});
