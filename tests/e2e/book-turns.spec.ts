import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { clickTool, observePaperTurns } from "./controls";
import { numberedPdf } from "../helpers/numbered-pdf";

async function open(page: Page, format = "pdf") {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles(path.resolve(`tests/fixtures/${format === "pdf" ? "tracemonkey.pdf" : "alice.epub"}`));
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".reader-shell")).toHaveAttribute("data-loading", "false");
  await expect(page.locator(".reader-loading")).toHaveCount(0);
  if (format === "pdf") await expect(page.locator('.pdf-page[data-page="1"] .textLayer span').first()).toBeVisible();
  if (format === "epub") {
    await clickTool(page, "Contents");
    await page.locator(".toc-item").filter({ hasText: /rabbit|chapter|down/i }).first().click();
  }
  await clickTool(page, "Reading settings");
  await page.getByRole("combobox", { name: format === "pdf" ? "Navigation" : "Layout", exact: true }).selectOption("paginated");
  if (format === "pdf") await page.getByRole("combobox", { name: "Fit", exact: true }).selectOption("page");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(page.locator(".reader-host")).toHaveAttribute("data-edge-turns", "true");
  if (format === "pdf") await expect(page.locator('.pdf-page[data-page="1"] .textLayer span').first()).toBeVisible();
}
async function drag(page: Page, fraction: number, release = true) {
  const paper = page.locator('.pdf-page:not([hidden])').first();
  const box = (await paper.boundingBox())!;
  await page.mouse.move(box.x + box.width - 8, box.y + box.height * .8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * fraction, box.y + box.height * .72, { steps: 12 });
  if (release) await page.mouse.up();
  return box;
}
test("PDF curl follows a held edge, reverses without navigation, and commits a complete turn", async ({ page }) => {
  await open(page);
  await expect(page.locator('.pdf-page[data-page="1"] canvas')).toBeVisible();
  const box = await drag(page, .60, false);
  await expect(page.locator(".reader-host")).toHaveAttribute("data-page-turn-state", "user_fold");
  await page.waitForTimeout(1800);
  await expect(page.locator(".paper-turn-stage")).toBeVisible();
  await expect(page.locator(".reader-progress")).toContainText("Page 1");
  await page.screenshot({ path: `.local/curl-${test.info().project.name}.png` });
  await page.mouse.move(box.x + box.width - 8, box.y + box.height * .8, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator(".paper-turn-stage")).toHaveCount(0);
  await expect(page.locator(".reader-progress")).toContainText("Page 1");
  await drag(page, -.10);
  await expect(page.locator(".reader-progress")).toContainText("Page 2");
  await expect(page.locator(".paper-turn-stage")).toHaveCount(0);
  // Backward folds use the same cancellation threshold in portrait mode.
  const second = (await page.locator('.pdf-page[data-page="2"]').boundingBox())!;
  await page.mouse.move(second.x + 8, second.y + second.height * .7); await page.mouse.down();
  await page.mouse.move(second.x + second.width * .6, second.y + second.height * .6, { steps: 12 });
  await expect(page.locator(".reader-host")).toHaveAttribute("data-page-turn-state", "user_fold");
  await page.mouse.move(second.x + 8, second.y + second.height * .7, { steps: 10 }); await page.mouse.up();
  await expect(page.locator(".paper-turn-stage")).toHaveCount(0);
  await expect(page.locator(".reader-progress")).toContainText("Page 2");
  await page.locator(".reader-host").focus(); await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".reader-progress")).toContainText("Page 1");
});
test("two-page spreads keep pairs and an odd final blank without counting a new page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({ name: "Three pages.pdf", mimeType: "application/pdf", buffer: numberedPdf(3) });
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".reader-loading")).toHaveCount(0);
  await expect(page.locator('.pdf-page[data-page="1"] canvas')).toBeVisible();
  await clickTool(page, "Reading settings");
  await page.getByRole("combobox", { name: "Pages across", exact: true }).selectOption("2");
  await page.getByRole("combobox", { name: "Navigation", exact: true }).selectOption("paginated");
  await page.getByRole("combobox", { name: "Fit", exact: true }).selectOption("page");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(page.locator(".reader-host")).toHaveAttribute("data-columns", "2");
  await expect(page.locator(".pdf-spread:visible .pdf-page")).toHaveCount(2);
  const first = (await page.locator('.pdf-page[data-page="1"]').boundingBox())!;
  const mate = (await page.locator('.pdf-page[data-page="2"]').boundingBox())!;
  expect(mate.x - first.x - first.width).toBeCloseTo(2, 0);
  await page.screenshot({ path: `.local/book-spread-${test.info().project.name}.png` });
  await clickTool(page, "Next page");
  await expect(page.locator(".reader-progress")).toContainText("Page 3");
  await expect(page.locator(".pdf-spread:visible .pdf-blank-page")).toHaveCount(1);
  await clickTool(page, "Next page");
  await expect(page.locator(".reader-host")).not.toHaveAttribute("data-page-turning", /.+/);
  await expect(page.locator(".reader-progress")).toContainText("Page 3");
  await clickTool(page, "Previous page");
  await expect(page.locator(".reader-progress")).toContainText("Page 1");
});
test("native Android touch can hold and cancel a fold without a second swipe navigation", async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== "chromium" || !isMobile);
  await open(page);
  const box = (await page.locator('.pdf-page[data-page="1"]').boundingBox())!;
  const session = await page.context().newCDPSession(page);
  const touch = (type: string, x?: number, y?: number) => session.send("Input.dispatchTouchEvent", { type: type as "touchStart", touchPoints: x === undefined ? [] : [{ x, y: y! }] });
  const y = box.y + box.height * .7;
  await touch("touchStart", box.x + box.width - 10, y);
  for (let n = 1; n <= 8; n++) {
    await touch("touchMove", box.x + box.width - 10 - box.width * .35 * n / 8, y - n * 2);
    await page.waitForTimeout(20); // Native touch input advances on display frames.
  }
  await expect(page.locator(".reader-host")).toHaveAttribute("data-page-turn-state", "user_fold");
  await page.waitForTimeout(1800);
  await expect(page.locator(".paper-turn-stage")).toBeVisible();
  await touch("touchMove", box.x + box.width - 10, y); await touch("touchEnd");
  await expect(page.locator(".paper-turn-stage")).toHaveCount(0);
  await expect(page.locator(".reader-progress")).toContainText("Page 1");
  await session.detach();
});
test("EPUB edge folds show the book and remain reversible without changing the live text", async ({ page }) => {
  await open(page, "epub");
  const bookId = page.url().split("/read/")[1].split("?")[0];
  const savedCfi = () => page.evaluate(async id => {
    const { get } = await import(/* @vite-ignore */ "/src/db.ts");
    const position = await get("position", id);
    return position?.locator.type === "epub" ? position.locator.cfi : undefined;
  }, bookId);
  await expect.poll(savedCfi, { timeout: 15000 }).toBeDefined();
  const cfi = await savedCfi();
  // Location generation refines percentages in the background without moving
  // the CFI. Compare the actual first paragraph's viewport position instead.
  const paragraph = page.frameLocator(".reader-host iframe").first().locator("p").filter({ hasText: "Alice was beginning" }).first();
  const before = await paragraph.boundingBox();
  const box = (await page.locator(".reader-host").boundingBox())!;
  await page.mouse.move(box.x + box.width - 8, box.y + box.height * .8); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .6, box.y + box.height * .7, { steps: 12 });
  await expect(page.locator(".reader-host")).toHaveAttribute("data-page-turn-state", "user_fold");
  await page.waitForTimeout(1800);
  await expect(page.locator(".paper-turn-stage")).toBeVisible();
  await page.screenshot({ path: `.local/epub-curl-${test.info().project.name}.png` });
  const held = (await paragraph.boundingBox())!;
  expect(held.width).toBe(before!.width);
  expect(Math.abs(held.y - before!.y)).toBeLessThanOrEqual(4);
  expect(await savedCfi()).toBe(cfi);
  const liveFont = await paragraph.evaluate(el => getComputedStyle(el.ownerDocument.body).fontFamily);
  const copyFonts = await page.locator(".paper-turn-stage").evaluate((el: HTMLIFrameElement) =>
    [...el.contentDocument!.querySelectorAll(".turn-leaf iframe")].map(frame => {
      const doc = (frame as HTMLIFrameElement).contentDocument!;
      return getComputedStyle(doc.body).fontFamily;
    }));
  expect(copyFonts.length).toBeGreaterThan(0);
  expect(copyFonts.every(font => font === liveFont)).toBe(true);
  await page.mouse.move(box.x + box.width - 8, box.y + box.height * .8, { steps: 12 }); await page.mouse.up();
  await expect(page.locator(".paper-turn-stage")).toHaveCount(0);
  expect(Math.abs((await paragraph.boundingBox())!.y - before!.y)).toBeLessThanOrEqual(4);
  await page.goto("/#/"); // Unmount flushes the live position immediately.
  expect(await savedCfi()).toBe(cfi);
});
test("EPUB button curls retain selectable text; instant preference survives reload", async ({ page }) => {
  await open(page, "epub");
  const before = await page.locator(".reader-progress").textContent();
  const turns = await observePaperTurns(page);
  await clickTool(page, "Next page");
  await expect.poll(turns).toBe(1);
  await expect(page.locator(".paper-turn-stage")).toHaveCount(0);
  await expect(page.locator(".reader-progress")).not.toHaveText(before!);
  await expect(page.locator(".reader-host .epub-view iframe").first()).toBeVisible();
  await clickTool(page, "Reading settings");
  await page.getByLabel("Page-turn effect", { exact: true }).selectOption("none");
  await page.reload();
  await expect(page.locator(".reader-loading")).toHaveCount(0);
  await clickTool(page, "Reading settings");
  await expect(page.getByLabel("Page-turn effect", { exact: true })).toHaveValue("none");
});
test("fullscreen requests hidden navigation and restores pinned controls on exit", async ({ page }) => {
  await page.addInitScript(() => {
    let element: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", { get: () => element });
    HTMLElement.prototype.requestFullscreen = async function(options) {
      (window as any).__fullscreenOptions = options;
      element = this; document.dispatchEvent(new Event("fullscreenchange"));
    };
    document.exitFullscreen = async () => { element = null; document.dispatchEvent(new Event("fullscreenchange")); };
    localStorage.setItem("leafmark-controls-pinned", "true");
  });
  await open(page);
  await clickTool(page, "Enter fullscreen reading");
  await expect(page.locator(".reader-header")).toBeHidden();
  expect(await page.evaluate(() => (window as any).__fullscreenOptions)).toEqual({ navigationUI: "hide" });
  expect(await page.evaluate(() => document.fullscreenElement?.className)).toContain("reader-shell");
  await clickTool(page, "Exit fullscreen reading");
  await expect(page.locator(".reader-header")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("leafmark-controls-pinned"))).toBe("true");
});
test("browser fullscreen enters quiet reading and exits through the fullscreen event", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium");
  await open(page);
  test.skip(!(await page.evaluate(() => document.fullscreenEnabled)));
  await clickTool(page, "Enter fullscreen reading");
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains("reader-shell"))).toBe(true);
  await expect(page.locator(".reader-header")).toBeHidden();
  await page.evaluate(() => document.exitFullscreen());
  await expect(page.locator(".reader-header")).toBeVisible();
});
test("denied fullscreen retains quiet reading and can restore pinned controls", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("leafmark-controls-pinned", "true");
    HTMLElement.prototype.requestFullscreen = () => Promise.reject(new DOMException("Fullscreen denied", "NotAllowedError"));
  });
  await open(page);
  await clickTool(page, "Enter fullscreen reading");
  await expect(page.locator(".reader-header")).toBeHidden();
  await expect(page.locator('.toast[role="status"]')).toContainText("browser did not allow fullscreen");
  await clickTool(page, "Exit fullscreen reading");
  await expect(page.locator(".reader-header")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("leafmark-controls-pinned"))).toBe("true");
});
