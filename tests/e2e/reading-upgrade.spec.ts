import { showHighlightFilters } from "./controls";
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { numberedPdf } from "../helpers/numbered-pdf";
import { textPdf } from "../helpers/text-pdf";
import { clickTool, showPassageAction } from "./controls";
test.use({ hasTouch: true });
test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem("leafmark-controls-pinned", "true")); });

test("contents lists chapter starts and marks the chapter at the current page", async ({ page }) => {
  const pdf = await PDFDocument.load(numberedPdf(4));
  const { context } = pdf;
  const root = context.obj({ Type: "Outlines", Count: 2 });
  const rootRef = context.register(root);
  const chapter = (title: string, page: number) => context.obj({
    Title: PDFString.of(title), Parent: rootRef, Dest: [pdf.getPage(page).ref, PDFName.of("Fit")],
  });
  const first = chapter("First chapter", 0), second = chapter("Second chapter", 2);
  const firstRef = context.register(first), secondRef = context.register(second);
  first.set(PDFName.of("Next"), secondRef); second.set(PDFName.of("Prev"), firstRef);
  root.set(PDFName.of("First"), firstRef); root.set(PDFName.of("Last"), secondRef);
  pdf.catalog.set(PDFName.of("Outlines"), rootRef);
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({ name: "Outline guide.pdf", mimeType: "application/pdf", buffer: Buffer.from(await pdf.save()) });
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".reader-location")).toHaveText("Page 1 of 4");
  await clickTool(page, "Contents");
  const contents = page.getByRole("navigation", { name: "Book contents" });
  await expect(contents).toContainText("2 sections");
  await expect(contents.locator('[aria-current="location"]')).toContainText("First chapter");
  await expect(contents.getByLabel("Starts on page 3")).toBeVisible();
  await contents.getByRole("button", { name: /Second chapter/ }).click();
  await expect(page.locator(".reader-location")).toHaveText("Page 3 of 4");
  await clickTool(page, "Contents");
  await expect(contents.locator('[aria-current="location"]')).toContainText("Second chapter");
  await contents.getByLabel("Go to page").fill("2");
  await contents.getByRole("button", { name: "Go", exact: true }).click();
  await expect(page.locator(".reader-location")).toHaveText("Page 2 of 4");
});

async function provideTestAudioBackend(page: Page, endClips = false) {
  await page.addInitScript(finish => {
    // The Windows WebKit runner ships without a usable audio backend.
    if (window.AudioContext || "webkitAudioContext" in window) return;
    const createUrl = URL.createObjectURL.bind(URL);
    const media = new Map<string, Blob>();
    URL.createObjectURL = file => {
      const url = createUrl(file);
      if (file instanceof Blob && file.type === "audio/wav") media.set(url, file);
      return url;
    };
    HTMLMediaElement.prototype.play = async function () {
      const file = media.get(this.src);
      if (!file) throw new Error("Missing narration WAV");
      media.delete(this.src);
      if (finish && this.onended) setTimeout(() => this.dispatchEvent(new Event("ended")), 500);
      const header = new DataView(await file.arrayBuffer());
      if (header.getUint32(0) !== 0x52494646 || header.getUint32(8) !== 0x57415645) throw new Error("Invalid narration WAV");
    };
    HTMLMediaElement.prototype.pause = function () {};
  }, endClips);
}

test("read along starts at a selection and draws a temporary sentence highlight", async ({ page }) => {
  await provideTestAudioBackend(page);
  await page.route(url => url.pathname.endsWith("/narration.worker.ts"), route => route.fulfill({
    contentType: "text/javascript",
    // Hold sentence two until the UI has started and paused sentence one.
    body: `let released = false, waiting;
    const gate = new BroadcastChannel("narration-test");
    gate.onmessage = () => { released = true; if (waiting) send(waiting); };
    self.onmessage = ({ data }) => {
      if (data.id === 2 && !released) waiting = data;
      else send(data);
    };
    function send(data) {
      const samples = new Float32Array(72000);
      self.postMessage({ id: data.id, samples, rate: 24000 }, [samples.buffer]);
    };`,
  }));
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({ name: "Narration.pdf", mimeType: "application/pdf",
    buffer: textPdf(["The first sentence opens the story.", "The second sentence belongs here.", "The third sentence ends the passage."]) });
  await page.locator(".book-cover-link").click();
  await page.locator(".textLayer span").getByText("The second sentence belongs here.", { exact: true }).evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = document.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await showPassageAction(page, "Listen from here");
  await page.getByRole("button", { name: "Listen from here", exact: true }).click();
  await page.getByLabel("Playback speed").selectOption("1.25");
  await page.getByRole("button", { name: "Play from selection" }).click();
  await expect(page.locator(".read-along blockquote")).toHaveText("The second sentence belongs here.");
  await expect(page.locator(".narration-layer span").first()).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const channel = new BroadcastChannel("narration-test");
    channel.postMessage("release"); channel.close();
  });
  await page.getByRole("button", { name: "Next sentence" }).click();
  await expect(page.locator(".read-along blockquote")).toHaveText("The third sentence ends the passage.");
  await page.getByRole("button", { name: "Stop narration" }).click();
  await expect(page.locator(".narration-layer")).toHaveCount(0);
  await expect(page.locator(".pdf-highlight")).toHaveCount(0);
});

async function provideInstalledVoice(page: Page, endClips = false) {
  await page.addInitScript(finish => {
    const synth = Object.assign(new EventTarget(), {
      getVoices: () => [{ voiceURI: "local-test", name: "Test voice", localService: true, lang: "en-US", default: true }],
      resume() {}, cancel() {},
      speak(utterance: SpeechSynthesisUtterance) {
        document.body.dataset.spoken = utterance.text;
        const log = JSON.parse(document.body.dataset.speechLog || "[]");
        log.push(utterance.text); document.body.dataset.speechLog = JSON.stringify(log);
        if (finish) setTimeout(() => utterance.onend?.call(utterance, {} as SpeechSynthesisEvent), 50);
      },
    });
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synth });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: class {
      constructor(public text: string) {}
    } });
  }, endClips);
}

test("switches to an installed voice from the current sentence while the model is waiting", async ({ page }) => {
  await provideTestAudioBackend(page);
  await provideInstalledVoice(page);
  await page.route(url => url.pathname.endsWith("/narration.worker.ts"), route =>
    route.fulfill({ contentType: "text/javascript", body: "self.onmessage = () => {};" }));
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({ name: "Audio.pdf", mimeType: "application/pdf",
    buffer: textPdf(["Read this aloud.", "Keep your place."]) });
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".textLayer span").first()).toBeVisible();
  await clickTool(page, "Listen");
  await page.getByRole("button", { name: "Play from here" }).click();
  await expect(page.locator(".read-along [role=status]")).toContainText("Preparing the first sentence");
  await page.getByRole("button", { name: "Play now with Test voice" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-spoken", "Read this aloud.");
  await expect(page.getByLabel("Voice", { exact: true })).toHaveValue("device:local-test");
  await page.getByRole("button", { name: "Stop narration" }).click();
});

test("continuous listening reads the next two sentences in order when neural synthesis falls behind", async ({ page }) => {
  await provideTestAudioBackend(page, true);
  await provideInstalledVoice(page, true);
  await page.route(url => url.pathname.endsWith("/narration.worker.ts"), route =>
    route.fulfill({ contentType: "text/javascript", body: `self.onmessage = ({data}) => {
      if (data.id === 1) self.postMessage({id:data.id, samples:new Float32Array(12000), rate:24000});
    }` }));
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({ name: "Continuous.pdf", mimeType: "application/pdf",
    buffer: textPdf(["Start here.", "Continue this passage.", "Finish the paragraph."]) });
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".textLayer span").first()).toBeVisible();
  await clickTool(page, "Listen");
  await page.getByRole("button", {name:"Play from here"}).click();
  await expect(page.locator("body")).toHaveAttribute("data-speech-log", JSON.stringify(["Continue this passage.", "Finish the paragraph."]));
  await expect(page.locator(".read-along")).toContainText("You reached the end of the book");
  await expect(page.getByLabel("Voice", {exact:true})).toHaveValue("af_heart");
});

test("library and reader agree on PDF pages and progress", async ({ page }, info) => {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({ name: "Progress guide.pdf", mimeType: "application/pdf", buffer: numberedPdf(4) });
  const card = page.locator(".book-card");
  const label = card.locator(".book-progress-label");
  await expect(label.locator("span")).toHaveText(["4 pages", "0%"]);
  await expect(card).not.toContainText("Unknown author");
  await expect(card.locator(".book-preparation, .book-sync-status")).toHaveCount(0);
  await card.getByRole("button", { name: "Details for Progress guide" }).click();
  const details = page.getByRole("dialog", { name: "Book details" });
  await expect(details).toContainText("Available offline");
  await details.getByRole("textbox", { name: "Author", exact: true }).fill("A. Reader");
  await details.getByRole("button", { name: "Save changes" }).click();
  await expect(card.locator(".book-author")).toHaveText("A. Reader");

  // Model a pre-existing PDF with prepared text and a missing page-count cache.
  const book = await page.evaluate(async () => {
    const { db, list } = await import("/src/db.ts");
    const { pdfPageCountKey, preparationKey } = await import("/src/pdfText.ts");
    const book = (await list("book"))[0];
    await db.meta.put({ key: preparationKey(book), value: JSON.stringify({ status: "ready", total: 4, done: 4 }) });
    await db.meta.delete(pdfPageCountKey(book.hash));
    return { id: book.id, hash: book.hash };
  });
  await expect(label.locator("span")).toHaveText(["0%"]);
  await card.locator(".book-cover-link").click();
  const header = page.locator(".reader-location");
  const footer = page.locator(".reader-progress > span");
  async function expectPage(number: number) {
    const expected = `Page ${number} of 4`;
    await expect(header).toBeVisible();
    await expect(header).toHaveText(expected);
    await expect(footer).toHaveText(expected);
  }
  await expectPage(1);
  await clickTool(page, "Reading settings");
  await page.getByRole("combobox", { name: "Pages across", exact: true }).selectOption("1");
  await page.getByRole("combobox", { name: "Navigation", exact: true }).selectOption("paginated");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(page.locator(".reader-host")).not.toHaveAttribute("aria-busy", "true");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expectPage(2);

  await clickTool(page, "Reading settings");
  await page.getByRole("combobox", { name: "Pages across", exact: true }).selectOption("2");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(page.locator(".reader-host")).toHaveAttribute("data-columns", "2");
  await expect(page.locator(".reader-host")).not.toHaveAttribute("aria-busy", "true");
  const target = encodeURIComponent(JSON.stringify({ type: "pdf", v: 1, hash: book.hash, page: 3, y: 0 }));
  await page.goto(`/#/read/${book.id}?source=${target}`);
  await expectPage(3);
  expect(await header.evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("reader-page-progress.png") });
  await clickTool(page, "Reading mode");
  await expect(header).toBeHidden();
  await expect(footer).toBeHidden();
  await page.reload();
  await expectPage(3);
  await page.getByRole("link", { name: "Back to library", exact: true }).click();
  await expect(label.locator("span")).toHaveText(["Page 3 of 4", "75%"]);
  await expect(page.locator(".continue-reading .book-progress-label span")).toHaveText(["Page 3 of 4", "75%"]);
  await card.locator(".book-cover-link").click();
  await expectPage(3);
  await clickTool(page, "Reading settings");
  await page.getByLabel("Hide bottom page controls").check();
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(header).toHaveText("Page 3 of 4");
  await expect(footer).toHaveCount(0);
  await page.getByRole("link", { name: "Back to library", exact: true }).click();
  await page.getByRole("button", { name: "List view" }).click();
  await expect(page.locator(".books-list .book-progress-label span")).toHaveText(["Page 3 of 4", "75%"]);
  await page.screenshot({ path: info.outputPath("library-list-progress.png") });
  await card.getByRole("button", { name: "Details for Progress guide" }).click();
  await details.getByLabel("Reading status").selectOption("finished");
  await details.getByRole("button", { name: "Save changes" }).click();
  await expect(label.locator("span")).toHaveText(["Page 3 of 4", "100%"]);
});

async function open(page: Page) {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({ name: "Reading practice.pdf", mimeType: "application/pdf", buffer: numberedPdf(4) });
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".reader-shell")).toHaveAttribute("data-loading", "false");
  await expect(page.locator('.pdf-page[data-page="1"] .textLayer span').first()).toBeVisible();
}
async function draw(page: Page, selector: string) {
  if (selector.includes("pdf-ink-layer")) await expect(page.locator(".reader-host")).toHaveClass(/drawing-mode/);
  const canvas = page.locator(selector).first(); await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const y = Math.max(180, box.y + Math.min(box.height * .3, 180));
  await page.mouse.move(box.x + box.width * .25, y); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .45, y + 25, { steps: 8 });
  await page.mouse.move(box.x + box.width * .65, y, { steps: 8 }); await page.mouse.up();
}
test("layout, appearance and zoom apply across books; zoomed edge taps turn spreads", async ({ page }) => {
  await open(page); await clickTool(page, "Reading settings");
  await page.getByRole("combobox", { name: "Pages across", exact: true }).selectOption("2");
  await page.getByRole("combobox", { name: "Navigation", exact: true }).selectOption("paginated");
  await page.getByRole("combobox", { name: "Fit", exact: true }).selectOption("width");
  await page.getByLabel("Trim blank margins in two-page view").uncheck();
  await page.getByRole("combobox", { name: "Zoom", exact: true }).selectOption("1.5");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(page.locator(".reader-host")).toHaveAttribute("data-columns", "2");
  await expect(page.locator(".reader-host")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.locator(".reader-host")).not.toHaveClass(/pdf-zooming/);
  const box = (await page.locator(".reader-host").boundingBox())!;
  const edgeY = box.y + Math.min(300, box.height / 2);
  await page.touchscreen.tap(box.x + box.width - 24, edgeY);
  await expect(page.locator('.pdf-page[data-page="3"]')).toBeVisible();
  // A stationary mouse press may be held or delivered across slow frames.
  // Only a touch hold needs the long-press cutoff used for text selection.
  await page.mouse.move(box.x + 24, edgeY); await page.mouse.down();
  await page.waitForTimeout(400); await page.mouse.up();
  await expect(page.locator('.pdf-page[data-page="1"]')).toBeVisible();
  await clickTool(page, "Reading settings"); await expect(page.getByRole("combobox", { name: "Zoom", exact: true })).toHaveValue("1.5");
  await page.getByRole("link", { name: "Back to library", exact: true }).click();
  await page.locator(".library-page input[type=file]").setInputFiles({ name: "Another book.pdf", mimeType: "application/pdf", buffer: numberedPdf(3) });
  await expect(page.locator(".book-card")).toHaveCount(2);
  await page.locator(".book-card").filter({ hasText: "Another book" }).locator(".book-cover-link").click();
  await expect(page.locator(".reader-shell")).toHaveAttribute("data-loading", "false");
  await expect(page.locator(".reader-shell")).toHaveClass(/theme-dark/);
  await expect(page.locator(".reader-host")).toHaveAttribute("data-columns", "2");
  await clickTool(page, "Reading settings"); await expect(page.getByRole("combobox", { name: "Zoom", exact: true })).toHaveValue("1.5");
  await page.reload(); await clickTool(page, "Reading settings");
  await expect(page.getByRole("combobox", { name: "Zoom", exact: true })).toHaveValue("1.5");
});
test("PDF ink survives reopening, supports undo and exports a separate marked PDF", async ({ page }) => {
  await open(page); await clickTool(page, "Draw on PDF");
  await expect(page.getByRole("toolbar", { name: "Drawing tools" })).toBeVisible();
  await expect(page.locator(".reader-host")).not.toHaveAttribute("aria-busy", "true");
  await draw(page, '.pdf-page[data-page="1"] .pdf-ink-layer');
  await expect(page.locator('.pdf-page[data-page="1"] .pdf-ink-layer path')).toHaveCount(1);
  await expect.poll(() => page.evaluate(async () => { const { list } = await import("/src/db.ts"); return (await list("ink-stroke")).length; })).toBe(1);
  await page.reload(); await expect(page.locator('.pdf-page[data-page="1"] .pdf-ink-layer path')).toHaveCount(1);
  await expect(page.locator('.pdf-page[data-page="1"] .pdf-ink-layer')).toHaveCSS("position", "absolute");
  await expect(page.locator('.pdf-page[data-page="1"] .pdf-ink-layer')).toHaveCSS("pointer-events", "none");
  await clickTool(page, "Draw on PDF"); await expect(page.locator(".reader-host")).not.toHaveAttribute("aria-busy", "true");
  await draw(page, '.pdf-page[data-page="1"] .pdf-ink-layer');
  await expect(page.locator('.pdf-page[data-page="1"] .pdf-ink-layer path')).toHaveCount(2);
  await page.getByRole("button", { name: "Undo drawing", exact: true }).click();
  await expect(page.locator('.pdf-page[data-page="1"] .pdf-ink-layer path')).toHaveCount(1);
  await page.getByRole("button", { name: "Redo drawing", exact: true }).click();
  await expect(page.locator('.pdf-page[data-page="1"] .pdf-ink-layer path')).toHaveCount(2);
  const download = page.waitForEvent("download"); await page.getByRole("button", { name: "Export marked PDF", exact: true }).click();
  const file = await download; expect(file.suggestedFilename()).toMatch(/-marked\.pdf$/);
  expect((await PDFDocument.load(await readFile((await file.path())!))).getPageCount()).toBe(4);
  await page.goto("/#/notes?layout=book"); await showHighlightFilters(page);
  await page.getByLabel("Note type").selectOption("drawing");
  await page.locator(".notes-passage-list section button").first().click(); await expect(page.locator(".ink-preview path")).toHaveCount(2);
});
test("notebook sections, text highlighting and inline drawings persist", async ({ page }) => {
  await page.goto("/#/notebooks"); await page.getByRole("button", { name: "New notebook", exact: true }).click();
  await page.getByLabel("Notebook name").fill("Study notebook"); await page.getByRole("button", { name: "Create notebook", exact: true }).click();
  const newSection = page.getByRole("button", { name: "New section", exact: true });
  if (!(await newSection.isVisible())) await page.getByRole("button", { name: "Pages", exact: true }).click();
  page.once("dialog", d => d.accept("Questions")); await newSection.click();
  await expect(page.locator(".notebook-sections button[aria-current=page]")).toContainText("Questions");
  await page.getByRole("button", { name: "New page", exact: true }).click();
  await page.getByRole("button", {name:"Page options",exact:true}).click();
  await page.getByLabel("Topic note title").fill("The useful idea");
  const editor = page.getByRole("textbox", { name: "Topic note content", exact: true });
  await editor.fill("An important thought worth keeping.");
  // Set a real DOM selection: emulated iPad WebKit has no hardware-keyboard
  // select-all mapping. Formatting still runs through the actual ribbon button.
  await editor.evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("An important thought worth keeping.");
  await page.getByRole("button", { name: "Highlight", exact: true }).click(); await expect(editor.locator("mark")).toHaveCount(1);
  // Mobile browser emulation can retain the DOM range through ArrowRight.
  // Collapse the real selection before Enter so it cannot replace the passage.
  await editor.evaluate(el => {
    (el as HTMLElement).focus();
    const range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect.poll(() => page.evaluate(() => document.getSelection()?.isCollapsed)).toBe(true);
  await editor.press("Enter");
  await expect(editor.locator("mark")).toHaveText("An important thought worth keeping.");
  await editor.evaluate(element => (element as HTMLElement & { editor: import("@tiptap/core").Editor }).editor.commands.insertContent({
    type: "drawing", attrs: { blockId: crypto.randomUUID(), height: 300 },
  }));
  await page.getByRole("button", { name: "Edit drawing", exact: true }).click();
  await draw(page, ".notebook-ink"); await expect(page.locator(".notebook-ink path")).toHaveCount(1);
  await page.getByRole("button", { name: "Done drawing", exact: true }).click();
  await page.getByRole("button", { name: "Save now", exact: true }).click();
  await expect(page.locator(".topic-save-status")).toContainText("Saved on this device");
  await page.reload(); await expect(editor.locator("mark")).toHaveCount(1); await expect(page.locator(".notebook-ink path")).toHaveCount(1);
  await expect(page.getByLabel("Move page to section")).toHaveValue(await page.evaluate(async () => { const { list } = await import("/src/db.ts"); return (await list("notebook-section")).find(s => s.title === "Questions")!.id; }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("notebook-drawing.png"), fullPage: true });
});
test("touch selection tools hide during handle dragging and return above the selection", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Native held-touch injection requires CDP.");
  await page.goto("/"); await page.locator("input[type=file]").setInputFiles({ name: "Selection.pdf", mimeType: "application/pdf", buffer: textPdf(["A thoughtful reading practice", "Keep your ideas close."]) });
  await expect(page.locator(".book-card")).toHaveCount(1); await page.locator(".book-cover-link").click();
  const span = page.locator(".textLayer span").filter({ hasText: "thoughtful" }); await expect(span).toBeVisible();
  await clickTool(page, "Reading mode"); await expect(page.locator(".reader-header")).toBeHidden();
  const r = (await span.boundingBox())!, session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: r.x + r.width * .3, y: r.y + r.height / 2 }] });
  await page.waitForTimeout(700); await expect(page.locator(".passage-popup")).toBeHidden(); await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const popup = page.locator(".passage-popup"); await expect(popup).toBeVisible(); expect((await popup.boundingBox())!.height).toBeLessThan(65);
  const handle = page.getByRole("button", { name: "Drag selection end", exact: true }); const h = (await handle.boundingBox())!;
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: h.x + 22, y: h.y + 22 }] });
  await expect(popup).toBeHidden();
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: h.x + 70, y: h.y + 22 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await session.detach();
  await expect(popup).toBeVisible();
  const selected = await page.locator(".app-selection-overlay i").first().boundingBox();
  const tools = (await popup.boundingBox())!; expect(tools.y + tools.height).toBeLessThanOrEqual(selected!.y);
  await showPassageAction(page, "yellow highlight"); await page.getByRole("button", { name: "yellow highlight", exact: true }).tap();
  await expect(page.locator(".pdf-highlight")).toHaveCount(1);
});
test("trimmed spreads keep PDF highlights and ink aligned through rotation and zoom", async ({ page }) => {
  await open(page); await clickTool(page, "Reading settings");
  await page.getByRole("combobox", { name: "Pages across", exact: true }).selectOption("2");
  await page.getByRole("combobox", { name: "Navigation", exact: true }).selectOption("paginated");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  const paper = page.locator('.pdf-page[data-page="1"]');
  await expect(paper).toHaveAttribute("data-pdf-crop", /,/);
  await expect(page.locator(".reader-host")).not.toHaveAttribute("aria-busy", "true");
  await expect(paper).toBeVisible();
  await expect(page.locator('.pdf-page[data-page="3"]')).toBeHidden();
  await paper.locator(".textLayer span").first().evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); const s = document.getSelection()!; s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event("selectionchange")); });
  await showPassageAction(page, "yellow highlight"); await page.getByRole("button", { name: "yellow highlight", exact: true }).click();
  await expect(paper.locator(".pdf-highlight")).toHaveCount(1);
  await clickTool(page, "Draw on PDF"); await expect(page.locator(".reader-host")).not.toHaveAttribute("aria-busy", "true");
  await draw(page, '.pdf-page[data-page="1"] .pdf-ink-layer');
  await expect.poll(() => page.evaluate(async () => { const { list } = await import("/src/db.ts"); return (await list("ink-stroke")).length; })).toBe(1);
  const originalPoints = await page.evaluate(async () => { const { list } = await import("/src/db.ts"); return (await list("ink-stroke"))[0].points; });
  await clickTool(page, "Reading settings"); await page.getByRole("button", { name: "Rotate page", exact: true }).click();
  await expect(paper).toHaveAttribute("data-pdf-rotation", "90");
  await page.getByRole("combobox", { name: "Zoom", exact: true }).selectOption("1.5");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(page.locator(".reader-host")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.locator(".reader-host")).not.toHaveClass(/pdf-zooming/);
  const delta = await page.evaluate(async () => {
    const [{ db, list }, { pdfLibrary, pdfOptions }, { pageViewport }, { inkPath }] = await Promise.all([import("/src/db.ts"), import("/src/pdf.ts"), import("/src/reader/pdfGeometry.ts"), import("/src/ink.ts")]);
    const book = (await list("book"))[0], file = (await db.files.get(book.id))!, stroke = (await list("ink-stroke"))[0];
    const api = await pdfLibrary(), task = api.getDocument(pdfOptions(await file.source.arrayBuffer()));
    try {
      const page = await (await task.promise).getPage(1), element = document.querySelector<HTMLElement>('.pdf-page[data-page="1"]')!, svg = element.querySelector<SVGSVGElement>(".pdf-ink-layer")!;
      const crop = element.dataset.pdfCrop!.split(",").map(Number), base = page.getViewport({ scale: 1 }), cropped = pageViewport(base, crop as [number,number,number,number], 1, 90);
      const viewport = pageViewport(base, crop as [number,number,number,number], svg.viewBox.baseVal.width / cropped.width, 90);
      const expected = inkPath(stroke, (x, y) => viewport.convertToViewportPoint(x, y)).match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)!.map(Number);
      const actual = svg.querySelector("path")!.getAttribute("d")!.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)!.map(Number);
      const annotation = (await list("annotation"))[0], rect = annotation.locator.type === "pdf" ? annotation.locator.regions![0].rects[0] : [0,0,0,0];
      const a = viewport.convertToViewportPoint(rect[0], rect[1]), b = viewport.convertToViewportPoint(rect[2], rect[3]), mark = element.querySelector<HTMLElement>(".pdf-highlight")!;
      const text = element.querySelector(".textLayer span")!.getBoundingClientRect(), highlight = mark.getBoundingClientRect();
      return { path: Math.max(...actual.map((n, i) => Math.abs(n - expected[i]))), left: Math.abs(parseFloat(mark.style.left) - Math.min(a[0], b[0])), top: Math.abs(parseFloat(mark.style.top) - Math.min(a[1], b[1])), overlaps: Math.min(text.right, highlight.right) > Math.max(text.left, highlight.left) && Math.min(text.bottom, highlight.bottom) > Math.max(text.top, highlight.top), points: stroke.points };
    } finally { await task.destroy(); }
  });
  expect(delta.path).toBeLessThan(.01); expect(delta.left).toBeLessThan(.01); expect(delta.top).toBeLessThan(.01); expect(delta.overlaps).toBe(true); expect(delta.points).toEqual(originalPoints);
});


test("outside taps close Explain and all passage icons without removing the highlight", async ({ page, browserName }) => {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({ name: "Explain dismissal.pdf", mimeType: "application/pdf", buffer: textPdf(["A thoughtful reading practice", "Keep your ideas close."]) });
  await expect(page.locator(".book-card")).toHaveCount(1); await page.locator(".book-cover-link").click();
  const span = page.locator(".textLayer span").filter({ hasText: "thoughtful" }); await expect(span).toBeVisible();
  await clickTool(page, "Reading mode");
  const popup = page.locator(".passage-popup");
  for (const touch of browserName === "chromium" ? [false, true] : [false]) {
    if (touch) {
      await clickTool(page, "Reading mode"); await expect(page.locator(".reader-header")).toBeHidden();
      await span.evaluate(el => el.scrollIntoView({ block: "center", behavior: "instant" }));
      const r = (await span.boundingBox())!, session = await page.context().newCDPSession(page);
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: r.x + r.width * .3, y: r.y + r.height / 2 }] });
      await page.waitForTimeout(650);
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await session.detach();
    } else await span.evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el); const selection = document.getSelection()!;
      selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event("selectionchange"));
    });
    await expect(popup).toBeVisible();
    if (!touch) { await showPassageAction(page, "yellow highlight"); await page.getByRole("button", { name: "yellow highlight", exact: true }).tap(); }
    await showPassageAction(page, "Explain"); await page.getByRole("button", { name: "Explain", exact: true }).tap();
    await expect(popup).toHaveAttribute("data-mode", "meaning");
    const host = (await page.locator(".reader-host").boundingBox())!;
    await page.touchscreen.tap(host.x + host.width / 2, host.y + host.height - 80);
    await expect(popup).toHaveCount(0);
    await page.waitForTimeout(300); await expect(popup).toHaveCount(0);
    await expect(page.locator(".pdf-selection-handle")).toHaveCount(0);
    await expect(page.locator(".pdf-highlight")).toHaveCount(1);
  }
});
