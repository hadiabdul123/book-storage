import { showPassageAction } from "./controls";
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { textPdf } from "../helpers/text-pdf";
import { scanPdf } from "../helpers/scanned-pdf";
import { clickTool } from "./controls";

async function openPdf(page: Page, scanned = false) {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "Quiet reading.pdf", mimeType: "application/pdf",
    buffer: scanned ? await scanPdf(page) : textPdf(["A little time for reading.", "A page with room to think."]),
  });
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".pdf-page canvas").first()).toBeVisible();
  expect((await page.locator(".reader-shell").boundingBox())!.width).toBe(await page.evaluate(() => innerWidth));
}
const paperFilter = (page: Page) => page.locator(".pdf-page canvas").first().evaluate(el => getComputedStyle(el).filter);
async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true, scale: "css" });
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test("tablet bookshelf and every navigation destination fit portrait, landscape and split screen", async ({ page }) => {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles(Array.from({ length: 6 }, (_, n) => ({
    name: `Reading ${n + 1}.pdf`, mimeType: "application/pdf", buffer: textPdf([`Chapter ${n + 1}`, "Room for a new idea."]),
  })));
  await expect(page.locator(".book-card")).toHaveCount(6, { timeout: 45000 });
  for (const size of [{ width: 810, height: 1080 }, { width: 1280, height: 800 }, { width: 540, height: 1080 }]) {
    await page.setViewportSize(size);
    await noOverflow(page);
    if (size.width > 760) {
      await expect(page.getByRole("navigation", {name:"Workspace"}).getByRole("link", {name:"Highlights"})).toBeVisible();
      expect((await page.locator(".common-header").boundingBox())!.width).toBe(size.width);
    } else {
      await page.getByRole("button", {name:"Navigation",exact:true}).click();
      await expect(page.getByRole("navigation", {name:"Workspace"})).toBeVisible();
      await page.getByRole("button", {name:"Navigation",exact:true}).click();
    }
    await screenshot(page, `library-${size.width}`);
    for (const route of ["/notes", "/notebooks", "/settings", "/"]) {
      await page.goto(`/#${route}`);
      await expect(page.locator(".reader-shell")).toHaveCount(0);
      await noOverflow(page);
    }
    const details = page.getByRole("button", { name: "Details for Reading 1", exact: true });
    await details.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await noOverflow(page);
    await page.getByRole("button", { name: "Close", exact: true }).click();
  }
});

test("warm PDF pages, Original colors and chosen themes survive reload", async ({ page }) => {
  await openPdf(page);
  await expect(page.locator(".reader-header")).toBeHidden();
  await expect(page.locator(".reader-shell")).toHaveClass(/theme-sepia/);
  expect(await paperFilter(page)).toContain("sepia");
  await screenshot(page, "warm-paper");
  await page.locator(".pdf-page .textLayer span").first().evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await showPassageAction(page, "yellow highlight");
  await page.getByRole("button", { name: "yellow highlight", exact: true }).tap();
  await expect(page.locator(".pdf-highlight")).toHaveCount(1);
  await clickTool(page, "Reading settings");
  await expect(page.getByRole("button", { name: "Warm paper", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Original PDF colors", { exact: true }).check();
  await expect.poll(() => paperFilter(page)).toBe("none");
  await page.reload();
  await expect(page.locator(".pdf-page canvas").first()).toBeVisible();
  expect(await paperFilter(page)).toBe("none");
  await clickTool(page, "Reading settings");
  await page.getByLabel("Original PDF colors", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect.poll(() => paperFilter(page)).toContain("invert");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await clickTool(page, "Reading mode");
  await expect(page.locator(".reader-header")).toBeHidden();
  await screenshot(page, "dark-paper");
  await clickTool(page, "Reading settings");
  await page.getByRole("button", { name: "Original", exact: true }).click();
  await expect(page.locator(".reader-shell")).toHaveClass(/theme-light/);
  await page.reload();
  await expect(page.locator(".pdf-page canvas").first()).toBeVisible();
  await expect(page.locator(".reader-shell")).toHaveClass(/theme-light/);
  expect(await paperFilter(page)).toBe("none");
});

test("scanned PDF paper is softened without filtering selection overlays", async ({ page }) => {
  await openPdf(page, true);
  expect(await paperFilter(page)).toContain("sepia");
  expect(await page.locator(".pdf-page").first().evaluate(el => getComputedStyle(el).filter)).toBe("none");
  await screenshot(page, "warm-scan");
});

test("panels resize without losing a PDF place or notebook writing", async ({ page }) => {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles(path.resolve("tests/fixtures/tracemonkey.pdf"));
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".pdf-page canvas").first()).toBeVisible();
  await expect(page.locator(".reader-loading")).toHaveCount(0);
  await clickTool(page, "Reading settings");
  await page.getByRole("combobox", { name: "Navigation", exact: true }).selectOption("paginated");
  await page.getByRole("combobox", { name: "Fit", exact: true }).selectOption("page");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await page.locator(".reader-host").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".reader-progress")).toContainText("2");
  await clickTool(page, "Page notes");
  const editor = page.locator(".reader-panel .tiptap");
  await editor.fill("A thought kept through rotation.");
  for (const size of [{ width: 1280, height: 800 }, { width: 810, height: 1080 }, { width: 540, height: 1080 }, { width: 810, height: 500 }]) {
    await page.setViewportSize(size);
    await expect(editor).toContainText("A thought kept through rotation.");
    await noOverflow(page);
    await screenshot(page, `notes-${size.width}-${size.height}`);
    const panel = (await page.locator(".reader-panel").boundingBox())!;
    expect(panel.x + panel.width).toBeLessThanOrEqual(size.width + 1);
    expect(panel.y + panel.height).toBeLessThanOrEqual(size.height + 1);
    if (size.width >= 1100) {
      const host = (await page.locator(".reader-host").boundingBox())!;
      expect(host.x + host.width).toBeLessThanOrEqual(panel.x + 1);
    }
  }
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await clickTool(page, "Page notes");
  await expect(editor).toContainText("A thought kept through rotation.");
});

test("EPUB frame colors and text selection survive themes and tablet resizing", async ({ page }) => {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles(path.resolve("tests/fixtures/alice.epub"));
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator(".book-cover-link").click();
  await clickTool(page, "Contents");
  await page.locator(".toc-item").filter({ hasText: /rabbit|chapter|down/i }).first().click();
  const body = page.frameLocator(".reader-host iframe").first().locator("body");
  await expect(body).toContainText("Alice was beginning");
  await expect(body).toHaveCSS("background-color", "rgb(244, 236, 217)");
  // The WebKit listener workaround must still block scripts from the book,
  // including same-origin scripts that the outer app's policy would allow.
  let scriptRequests = 0;
  await page.route("**/untrusted-book.js", route => {
    scriptRequests++;
    return route.fulfill({ contentType: "text/javascript", body: "parent.__bookScriptRan = true;" });
  });
  const blockedDirective = await body.evaluate(el => new Promise<string>(resolve => {
    const doc = el.ownerDocument, script = doc.createElement("script");
    const blocked = (event: SecurityPolicyViolationEvent) => {
      if (!event.blockedURI.endsWith("/untrusted-book.js")) return;
      doc.removeEventListener("securitypolicyviolation", blocked);
      script.remove(); resolve(event.effectiveDirective);
    };
    doc.addEventListener("securitypolicyviolation", blocked);
    script.src = `${parent.location.origin}/untrusted-book.js`;
    el.append(script);
  }));
  expect(blockedDirective).toMatch(/^script-src/);
  expect(scriptRequests).toBe(0);
  expect(await page.evaluate(() => (window as any).__bookScriptRan)).toBeUndefined();
  const paragraph = body.locator("p").filter({ hasText: "Alice was beginning" }).first();
  await paragraph.scrollIntoViewIfNeeded();
  await paragraph.evaluate(el => {
    (el as HTMLElement).tabIndex = -1; (el as HTMLElement).focus({ preventScroll: true });
    const doc = el.ownerDocument, walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const text = walker.nextNode()!;
    const range = doc.createRange(); range.setStart(text, 0); range.setEnd(text, Math.min(60, text.textContent!.length));
    const selection = doc.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    doc.dispatchEvent(new Event("selectionchange"));
  });
  await showPassageAction(page, "blue highlight");
  await expect(page.getByRole("button", { name: "blue highlight", exact: true })).toBeVisible();
  await showPassageAction(page, "blue highlight");
  await page.getByRole("button", { name: "blue highlight", exact: true }).tap();
  await expect(page.locator(".leafmark-highlight").first()).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await clickTool(page, "Reading settings");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(body).toHaveCSS("background-color", "rgb(32, 40, 48)");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await page.setViewportSize({ width: 540, height: 1080 });
  await expect(body).toContainText("Alice was beginning");
  await noOverflow(page);
  await screenshot(page, "epub-dark-split");
  await expect(page.locator(".leafmark-highlight").first()).toBeVisible();
});

test("tablet page swipes turn pages while a long press keeps controls quiet", async ({ page }) => {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles(path.resolve("tests/fixtures/tracemonkey.pdf"));
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".pdf-page canvas").first()).toBeVisible();
  await clickTool(page, "Reading settings");
  await page.getByLabel("Swipe to turn pages", { exact: true }).check();
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await clickTool(page, "Reading mode");
  await expect(page.locator(".reader-header")).toBeHidden();
  await page.locator(".reader-host").evaluate(async el => {
    const box = el.getBoundingClientRect(), x = box.left + 100, y = box.top + 200;
    const pointer = (type: string) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerType: "touch", pointerId: 17, isPrimary: true, clientX: x, clientY: y,
    }));
    pointer("pointerdown");
    await new Promise(resolve => setTimeout(resolve, 500));
    pointer("pointerup");
  });
  await expect(page.locator(".reader-header")).toBeHidden();
  await page.locator(".reader-host").evaluate(el => {
    const box = el.getBoundingClientRect(), x = box.left + box.width * 0.8, y = box.top + box.height / 2;
    const touch = (clientX: number) => ({ identifier: 1, target: el, clientX, clientY: y });
    // WebKit does not expose a constructible Touch; dispatch the standard fields.
    const event = (type: string, touches: object[], changedTouches = touches) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(e, { touches: { value: touches }, changedTouches: { value: changedTouches } });
      el.dispatchEvent(e);
    };
    event("touchstart", [touch(x)]);
    event("touchmove", [touch(x - 150)]);
    event("touchend", [], [touch(x - 150)]);
  });
  await clickTool(page, "Reading settings");
  await expect(page.locator(".reader-progress")).toContainText("2");
  await expect(page.getByLabel("Swipe to turn pages", { exact: true })).toBeChecked();
});
