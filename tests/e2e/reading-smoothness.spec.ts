import { test, expect, type Page, type Locator } from "@playwright/test";
import path from "node:path";
import JSZip from "jszip";
import { textPdf } from "../helpers/text-pdf";
import { clickTool, observePaperTurns } from "./controls";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("leafmark-controls-pinned", "true"));
});

async function open(page: Page, format: string) {
  await page.goto("/");
  if (format === "pdf") await page.locator("input[type=file]").setInputFiles({ name: "Reading.pdf", mimeType: "application/pdf", buffer: textPdf(["Thoughtful reading opens a world of ideas.", "Another line for selecting a passage."]) });
  else if (format === "epub") await page.locator("input[type=file]").setInputFiles(path.resolve("tests/fixtures/alice.epub"));
  else {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Thoughtful reading opens a world of ideas.</w:t></w:r></w:p></w:body></w:document>');
    await page.locator("input[type=file]").setInputFiles({ name: "Reading.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: await zip.generateAsync({ type: "nodebuffer" }) });
  }
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".reader-loading")).toHaveCount(0);
  if (format === "epub") {
    await clickTool(page, "Contents");
    await page.locator(".toc-item").filter({ hasText: /rabbit|chapter|down/i }).first().click();
  }
}

async function hold(page: Page, text: Locator, chromium: boolean) {
  const point = await text.evaluate(el => {
    const doc = el.ownerDocument, walker = doc.createTreeWalker(el, 4);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const word = /[\p{L}\p{N}]{3,}/u.exec(node.textContent || "");
      if (!word) continue;
      const range = doc.createRange(); range.setStart(node, word.index); range.setEnd(node, word.index + Math.min(3, word[0].length));
      const r = range.getBoundingClientRect();
      if (r.width && r.height) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    throw new Error("No visible word");
  });
  if (chromium) {
    const frame = await text.evaluate(el => {
      const frame = el.ownerDocument.defaultView?.frameElement as HTMLElement | null;
      const r = frame?.getBoundingClientRect(); return { x: r?.left || 0, y: r?.top || 0 };
    });
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x + frame.x, y: point.y + frame.y }] });
    await page.waitForTimeout(700);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await session.detach();
  } else {
    // WebKit has no CDP touch injection; exercise the same document listeners.
    await text.evaluate((el, point) => {
      const event = new Event("touchstart", { bubbles: true });
      Object.defineProperty(event, "touches", { value: [{ clientX: point.x, clientY: point.y }] }); el.dispatchEvent(event);
    }, point);
    await page.waitForTimeout(700);
    await text.dispatchEvent("touchend", { touches: [] });
  }
}

for (const format of ["pdf", "epub", "docx"]) test(`${format} touch selection uses app handles and Copy without a native range`, async ({ page, browserName, isMobile }) => {
  test.skip(!isMobile);
  await open(page, format);
  const text = format === "pdf" ? page.locator(".textLayer span").first() : format === "docx" ? page.locator(".docx-content p").first() : page.frameLocator(".reader-host .epub-view iframe").locator("p").filter({ hasText: /Alice/ }).first();
  await clickTool(page, "Reading mode");
  await expect(page.locator(".reader-header")).toBeHidden();
  await expect(text).toBeVisible();
  await hold(page, text, browserName === "chromium");
  await expect(page.locator(".passage-popup")).toBeVisible();
  expect(await text.evaluate(el => el.ownerDocument.getSelection()?.toString() || "")).toBe("");
  expect(await text.evaluate(el => el.ownerDocument.querySelectorAll(".pdf-selection-handle").length)).toBe(2);
  expect(await text.evaluate(el => el.ownerDocument.querySelectorAll(".app-selection-overlay i").length)).toBeGreaterThan(0);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as any).__copied = text; } } });
  });
  const passage = await page.locator(".selection-excerpt").textContent();
  await page.getByRole("button", { name: "Copy", exact: true }).tap();
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).toBe(passage);
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("Denied"); } } }); });
  await page.getByRole("button", { name: "Copy", exact: true }).tap();
  await expect(page.locator(".toast")).toContainText("Copy was blocked");
  expect(await text.evaluate(el => el.ownerDocument.getSelection()?.toString() || "")).toBe("");
  await page.getByRole("button", { name: "yellow highlight", exact: true }).tap();
  await expect.poll(() => page.evaluate(async () => { const { list } = await import(/* @vite-ignore */ "/src/db.ts"); return (await list("annotation")).length; })).toBe(1);
  await page.screenshot({ path: test.info().outputPath(`${format}-app-selection.png`) });
  await page.getByRole("button", { name: "Add note", exact: true }).tap();
  const note = page.getByRole("textbox", { name: "Note for selected passage" });
  await note.fill("A personal reading note");
  expect(await note.evaluate((el: HTMLTextAreaElement) => {
    el.setSelectionRange(2, 10);
    return { start: el.selectionStart, end: el.selectionEnd, nativeMenu: el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })) };
  })).toEqual({ start: 2, end: 10, nativeMenu: true });
});

test("rapid zoom buttons retain a preview until the final zoom is rendered", async ({ page }) => {
  await open(page, "pdf");
  await clickTool(page, "Reading settings");
  await page.getByRole("combobox", { name: "Zoom", exact: true }).selectOption("3");
  await expect(page.locator(".reader-host")).not.toHaveClass(/pdf-zooming/);
  expect(await page.locator(".pdf-page canvas").evaluate((canvas: HTMLCanvasElement) => canvas.width * canvas.height)).toBeLessThanOrEqual(6_000_000);
  await page.getByRole("combobox", { name: "Zoom", exact: true }).evaluate(select => {
    for (const value of ["1.5", "2", "1.25"]) { (select as HTMLSelectElement).value = value; select.dispatchEvent(new Event("change", { bubbles: true })); }
  });
  await expect(page.locator(".reader-host")).not.toHaveClass(/pdf-zooming/);
  await expect(page.locator(".pdf-zoom-preview")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Zoom", exact: true })).toHaveValue("1.25");
  await expect.poll(() => page.evaluate(async () => {
    const { db, list } = await import(/* @vite-ignore */ "/src/db.ts");
    const book = (await list("book"))[0]; return JSON.parse((await db.meta.get(`device-reading:${book.id}`))!.value).zoom;
  })).toBe(1.25);
  await expect(page.locator(".pdf-page canvas")).toHaveCount(1);
  await expect(page.locator(".pdf-page .textLayer")).toHaveCount(1);
});

test("repeated curls reuse one isolated renderer and idle without animation callbacks", async ({ page }) => {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles(path.resolve("tests/fixtures/tracemonkey.pdf"));
  await page.locator(".book-cover-link").click();
  await expect(page.locator('.pdf-page[data-page="1"] .textLayer span').first()).toBeVisible();
  await expect(page.locator(".reader-shell")).toHaveAttribute("data-loading", "false");
  await clickTool(page, "Reading settings");
  await page.getByRole("combobox", { name: "Navigation", exact: true }).selectOption("paginated");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await page.locator('.pdf-page[data-page="1"]').hover({ position: { x: 30, y: 100 } });
  await expect(page.locator(".reader-host")).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => page.locator(".turn-surface-cache img").evaluateAll(images => images.length >= 2 && images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  const turns = await observePaperTurns(page);
  await clickTool(page, "Next page");
  await expect.poll(turns).toBe(1);
  await expect(page.locator(".reader-progress")).toContainText("Page 2");
  const realm = await page.locator(".paper-turn-realm").elementHandle();
  expect(realm).toBeTruthy();
  await realm!.evaluate((el: HTMLIFrameElement) => {
    const win = el.contentWindow!; (win as any).__frames = 0;
    const count = () => { (win as any).__frames++; win.requestAnimationFrame(count); }; win.requestAnimationFrame(count);
  });
  await page.waitForTimeout(600);
  expect(await realm!.evaluate((el: HTMLIFrameElement) => (el.contentWindow as any).__frames)).toBe(0);
  const started = Date.now();
  await clickTool(page, "Next page");
  await expect(page.locator(".reader-progress")).toContainText("Page 3");
  expect(Date.now() - started).toBeGreaterThan(250);
  expect(await realm!.evaluate(el => el.isConnected)).toBe(true);
  expect(await realm!.evaluate((el: HTMLIFrameElement) => (el.contentWindow as any).__frames)).toBeGreaterThan(0);
  const frames = await realm!.evaluate((el: HTMLIFrameElement) => (el.contentWindow as any).__frames);
  await page.waitForTimeout(120);
  expect(await realm!.evaluate((el: HTMLIFrameElement) => (el.contentWindow as any).__frames)).toBe(frames);
  await expect.poll(() => page.locator(".turn-surface-cache").count()).toBeLessThanOrEqual(3);
});


test("a new scroll during PDF sharpening supersedes the old fit position", async ({ page }) => {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles(path.resolve("tests/fixtures/tracemonkey.pdf"));
  await page.locator(".book-cover-link").click();
  await expect(page.locator('.pdf-page[data-page="1"] .textLayer span').first()).toBeVisible();
  await expect(page.locator(".reader-shell")).toHaveAttribute("data-loading", "false");
  await clickTool(page, "Reading settings");
  await page.evaluate(async () => {
    const { PdfReader } = await import(/* @vite-ignore */ "/src/reader/pdf.ts");
    const proto = PdfReader.prototype as any, original = proto.render;
    let slow = true;
    proto.render = async function(...args: unknown[]) {
      if (slow && this.layingOut && this.layout.fit === "page") {
        slow = false; this.host.dataset.testSharpening = "true";
        await new Promise<void>(resolve => { (window as any).__finishSharpening = resolve; });
        delete this.host.dataset.testSharpening;
      }
      return original.apply(this, args);
    };
  });
  await page.getByRole("combobox", { name: "Fit", exact: true }).selectOption("page");
  await expect(page.locator(".reader-host")).toHaveAttribute("data-test-sharpening", "true");
  await page.locator('.pdf-page[data-page="3"]').evaluate(element => element.scrollIntoView({ block: "start" }));
  await page.evaluate(() => (window as any).__finishSharpening());
  await expect(page.locator(".reader-progress")).toContainText("Page 3");
  await expect(page.locator(".reader-host")).not.toHaveAttribute("data-test-sharpening", "true");
});
