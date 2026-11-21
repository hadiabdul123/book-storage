import { test, expect, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { clickTool, showPassageAction } from "./controls";
test.use({ hasTouch: true });
test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem("leafmark-controls-pinned", "true")); });
async function drawingReady(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator(".reader-host")).toHaveAttribute("aria-busy", "false");
}
async function open(page: Page, scan = false) {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), text = "Keep this thoughtful passage";
  const background = scan && await pdf.embedPng(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQI12P4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==","base64"));
  for (let i = 0; i < 3; i++) {
    const sheet = pdf.addPage([400,600]);
    if (background) sheet.drawImage(background,{x:0,y:0,width:400,height:600});
    sheet.drawText(text, { x: 392 - font.widthOfTextAtSize(text, 18), y: 400, size: 18, font });
  }
  await page.goto("/"); await page.locator("input[type=file]").setInputFiles({ name: "Gesture safety.pdf", mimeType: "application/pdf", buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator(".book-card")).toHaveCount(1); await page.locator(".book-cover-link").click();
  await expect(page.locator(".reader-shell")).toHaveAttribute("data-loading", "false");
  await clickTool(page, "Reading settings");
  await page.getByRole("combobox", { name: "Navigation", exact: true }).selectOption("paginated"); await page.getByRole("combobox", { name: "Fit", exact: true }).selectOption("page");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(page.locator(".reader-host")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('.pdf-page[data-page="1"] .textLayer span').first()).toBeVisible();
}
test("holding and adjusting an edge passage never turns the highlighted page", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Real long-press injection requires CDP.");
  await open(page); await clickTool(page, "Reading mode");
  const r = (await page.locator('.pdf-page[data-page="1"] .textLayer span').first().boundingBox())!;
  const cdp = await page.context().newCDPSession(page), x = r.x + r.width - 3, y = r.y + r.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{x,y}] }); await page.waitForTimeout(650);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - 100, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.locator(".passage-popup")).toBeVisible();
  const handle = (await page.getByRole("button", { name: "Drag selection start", exact: true }).boundingBox())!;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: handle.x + 22, y: handle.y + 22 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: r.x + 10, y: r.y - 6 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await cdp.detach();
  await expect(page.locator('.pdf-page[data-page="1"]')).toBeVisible(); await expect(page.locator('.pdf-page[data-page="2"]')).toBeHidden();
  await expect(page.locator(".paper-turn-stage")).toHaveCount(0);
});
test("tapping a tablet page does not accept a delayed page-wide native selection", async ({page}) => {
  await open(page);
  const layer = page.locator('.pdf-page[data-page="1"] .textLayer');
  const run = (await layer.locator("span").first().boundingBox())!;
  await page.touchscreen.tap(run.x + run.width / 2,run.y + run.height / 2);
  await layer.evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("");
  await expect(page.locator(".passage-popup")).toHaveCount(0);
});

test("touch on text over a page-sized scan keeps only the pressed word", async ({page,browserName}) => {
  test.skip(browserName !== "chromium","Touch input uses CDP.");
  await open(page,true);
  const layer = page.locator('.pdf-page[data-page="1"] .textLayer');
  const point = await layer.locator("span").first().evaluate(el => {
    const text = el.firstChild!, start = text.textContent!.indexOf("thoughtful");
    const range = document.createRange(); range.setStart(text,start); range.setEnd(text,start+10);
    const box = range.getBoundingClientRect(); return {x:box.left+box.width/2,y:box.top+box.height/2};
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[point]});
  await layer.evaluate((el,p) => el.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:p.x,clientY:p.y})),point);
  await expect(page.getByLabel("Drag selection end")).toBeVisible();
  await cdp.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
  // Reproduce the late browser selection reported by tablet readers.
  await layer.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const s=getSelection()!; s.removeAllRanges(); s.addRange(range); });
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("");
  await expect(page.locator(".pdf-image-selection")).toHaveCount(0);
  await expect(page.getByLabel("Drag selection start")).toBeVisible();
  await showPassageAction(page,"yellow highlight");
  await page.getByRole("button",{name:"yellow highlight",exact:true}).click();
  await expect.poll(() => page.evaluate(async () => (await (await import("/src/db.ts")).list("annotation")).map(a=>a.text))).toEqual(["thoughtful"]);
  await cdp.detach();
});
test("mouse text selection starting inside the turn edge keeps the page still", async ({ page }) => {
  await open(page); await clickTool(page, "Reading mode");
  const r = (await page.locator('.pdf-page[data-page="1"] .textLayer span').first().boundingBox())!;
  await page.mouse.move(r.x + r.width - 3, r.y + r.height / 2); await page.mouse.down();
  await page.mouse.move(r.x + 8, r.y + r.height / 2, { steps: 12 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString().length || 0)).toBeGreaterThan(5);
  await expect(page.locator(".passage-popup")).toBeVisible(); await expect(page.locator('.pdf-page[data-page="2"]')).toBeHidden();
  await expect(page.locator(".paper-turn-stage")).toHaveCount(0);
});
test("stylus wins over a resting palm and unrelated palm cancellation at zoom", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Native stylus injection requires CDP.");
  await open(page); await clickTool(page, "Draw on PDF"); await drawingReady(page);
  const svg = page.locator('.pdf-page[data-page="1"] .pdf-ink-layer'), host = (await page.locator(".reader-host").boundingBox())!;
  const x = host.x + host.width * .45, y = host.y + Math.min(250, host.height * .4), cdp = await page.context().newCDPSession(page);
  // Pinch while drawing is enabled, then write with the pen after sharpening.
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x - 45, y }, { x: x + 45, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - 90, y }, { x: x + 90, y }] });
  await expect(page.locator(".pdf-zoom-preview")).toHaveCount(1);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await drawingReady(page); await expect(page.locator(".pdf-zoom-preview")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reset page zoom", exact: true })).toContainText("200%");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x + 80, y: y + 80 }] });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, pointerType: "pen", force: .4 });
  await expect(svg).toHaveAttribute("data-ink-pen-active", "true");
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + 35, y: y + 20, button: "left", buttons: 1, pointerType: "pen", force: .7 });
  await svg.dispatchEvent("pointercancel", { pointerId: 999, pointerType: "touch", bubbles: true });
  await expect(svg).toHaveAttribute("data-ink-pen-active", "true");
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + 70, y, button: "left", buttons: 1, pointerType: "pen", force: .6 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + 70, y, button: "left", buttons: 0, pointerType: "pen" });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await cdp.detach();
  await expect(svg.locator("path")).toHaveCount(1);
  const saved = () => page.evaluate(async () => { const { list } = await import("/src/db.ts"); return list("ink-stroke"); });
  await expect.poll(saved).toHaveLength(1);
  const strokes = await saved();
  expect(strokes[0].points.length).toBeGreaterThan(2);
  expect(strokes[0].points.some(p => p[2] > .6)).toBe(true);
  await page.reload(); await expect(page.locator('.pdf-page[data-page="1"] .pdf-ink-layer path')).toHaveCount(1);
});
test("zoom finishes an active pen stroke in the old coordinates before redrawing", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Native stylus injection requires CDP.");
  await open(page); await clickTool(page, "Draw on PDF"); await drawingReady(page);
  const paper = (await page.locator('.pdf-page[data-page="1"] .pdf-ink-layer').boundingBox())!;
  const x = paper.x + paper.width * .4, y = paper.y + Math.min(160, paper.height * .3);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, pointerType: "pen", force: .5 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + 30, y: y + 20, button: "left", buttons: 1, pointerType: "pen", force: .7 });
  await expect(page.locator(".pdf-ink-layer[data-ink-pen-active=true]")).toHaveCount(1);
  await page.getByRole("button", { name: "Reading settings", exact: true }).evaluate((button: HTMLButtonElement) => button.click());
  await page.getByRole("combobox", { name: "Zoom", exact: true }).selectOption("2");
  await expect(page.locator(".reader-host")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".pdf-zoom-preview")).toHaveCount(0);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + 100, y: y + 80, button: "left", buttons: 1, pointerType: "pen", force: .8 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + 100, y: y + 80, button: "left", buttons: 0, pointerType: "pen" }); await cdp.detach();
  await expect(page.locator('.pdf-page[data-page="1"] .pdf-ink-layer path')).toHaveCount(1);
  const saved = () => page.evaluate(async () => { const { list } = await import("/src/db.ts"); return list("ink-stroke"); });
  await expect.poll(saved).toHaveLength(1);
  expect((await saved())[0].points).toHaveLength(2);
});


test("an edge tap dismisses saved-highlight tools without turning until the next tap", async ({ page }) => {
  await open(page); await clickTool(page, "Reading mode");
  // Reading mode awaits notebook flushing before it clears the old selection.
  // Wait for that action and its layout before creating this test's range.
  await expect(page.locator(".reader-header")).toBeHidden(); await drawingReady(page);
  const span = page.locator('.pdf-page[data-page="1"] .textLayer span').first();
  await span.evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); const s = document.getSelection()!; s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event("selectionchange")); });
  await showPassageAction(page, "yellow highlight"); await page.getByRole("button", { name: "yellow highlight", exact: true }).click();
  await expect(page.locator(".pdf-highlight")).toHaveCount(1); await page.keyboard.press("Escape");
  await expect(page.locator(".passage-popup")).toHaveCount(0);
  const mark = (await page.locator(".pdf-highlight").boundingBox())!;
  await page.touchscreen.tap(mark.x + mark.width / 2, mark.y + mark.height / 2);
  await expect(page.locator(".passage-popup")).toBeVisible();
  expect(await page.evaluate(() => document.getSelection()?.toString() || "")).toBe("");
  const paper = (await page.locator('.pdf-page[data-page="1"]').boundingBox())!;
  const x = paper.x + paper.width - 8, y = paper.y + paper.height * .75;
  await page.touchscreen.tap(x, y);
  await expect(page.locator(".passage-popup")).toHaveCount(0); await expect(page.locator('.pdf-page[data-page="2"]')).toBeHidden();
  await page.touchscreen.tap(x, y); await expect(page.locator('.pdf-page[data-page="2"]')).toBeVisible();
});
