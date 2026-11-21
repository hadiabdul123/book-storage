import { expect, test, type Page } from "@playwright/test";
import { wavFixture } from "../helpers/audio-fixture";
import { textPdf } from "../helpers/text-pdf";

async function openNote(page: Page) {
  await page.goto("/#/notebooks");
  await page.getByRole("button", { name: "New notebook" }).click();
  await page.getByLabel("Notebook name").fill("Field journal");
  await page.getByRole("button", { name: "Create notebook" }).click();
  await expect(page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "New notebook" }) })).toBeHidden();
  await expect(page.locator(".pages-heading")).toContainText("Field journal");
  await page.getByRole("button", { name: "New page", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Topic note content" })).toHaveAttribute("contenteditable", "true");
  await page.getByRole("button", {name:"Page options",exact:true}).click();
}

test("notebook text boxes resize, move freely and reopen with their text", async ({ page }, info) => {
  await openNote(page);
  const editor = page.getByRole("textbox", { name: "Topic note content" });
  await editor.fill("A normal paragraph.");
  await page.getByRole("button",{name:"Insert",exact:true}).click();
  const insertBox = page.getByRole("button", { name: "Text box", exact: true });
  await expect(insertBox).toBeInViewport({ ratio: 1 });
  await insertBox.click();
  const box = editor.locator("[data-notebook-text-box]");
  await expect(box).toBeVisible();
  await page.keyboard.insertText("A box with my own words.");
  await expect(box).toHaveText("A box with my own words.");
  const before = (await box.boundingBox())!.width;
  await page.getByRole("button", { name: "Resize text box" }).press("ArrowRight");
  await expect.poll(async () => (await box.boundingBox())!.width).toBeGreaterThan(before);
  const menu = page.getByRole("button", { name: "More actions for text box", exact: true });
  await menu.click();
  await page.getByRole("menuitem", { name: "Move freely" }).click();
  await expect(box).toHaveAttribute("data-free-box", "true");
  const move = page.getByRole("button", { name: "Move text box", exact: true });
  if (info.project.name === "desktop") {
    await move.scrollIntoViewIfNeeded();
    const handle = (await move.boundingBox())!;
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    const initial = await box.getAttribute("style");
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 30, y + 40, { steps: 6 });
    await page.mouse.up();
    await expect(box).not.toHaveAttribute("style", initial!);
  } else await move.press("ArrowDown");
  const style = await box.getAttribute("style");
  await page.getByRole("button", { name: "Save now", exact: true }).click();
  await expect(page.locator(".topic-save-status")).toContainText("Saved on this device");
  await page.reload();
  await expect(box).toHaveText("A box with my own words.");
  await expect(box).toHaveAttribute("style", style!);
  await expect(editor).toContainText("A normal paragraph.");
});

test("inserting a saved quote offline preserves the selected writing and undoes with its citation", async ({ page, context }) => {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles([
    { name: "River journal.pdf", mimeType: "application/pdf", buffer: textPdf(["Opening of journal", "Rivers need healthy floodplains."]) },
    { name: "Field journal.pdf", mimeType: "application/pdf", buffer: textPdf(["Birds nest near the water."]) },
  ]);
  await expect(page.locator(".book-card")).toHaveCount(2);
  await page.evaluate(async () => {
    const { list, save } = await import("/src/db.ts");
    const books = await list("book");
    for (const [index, text] of ["Rivers need healthy floodplains.", "Birds nest near the water."].entries()) {
      const book = books.find(book => book.title === (index ? "Field journal" : "River journal"))!;
      await save("annotation", { id: `excerpt-${index}`, bookId: book.id, text, note: "", tags: [], color: "yellow",
        locator: { type: "pdf", v: 1, page: index ? 1 : 2, hash: book.hash, y: 0, quote: { exact: text, prefix: "", suffix: "" } },
        createdAt: new Date().toISOString() });
    }
  });
  await openNote(page);
  const editor = page.getByRole("textbox", { name: "Topic note content" });
  await editor.fill("Keep these words and this suffix.");
  await editor.press("End");
  await editor.press("Enter");
  await editor.pressSequentially("Second paragraph.");
  await editor.evaluate(element => {
    const { editor } = element as HTMLElement & { editor: import("@tiptap/core").Editor };
    editor.commands.setTextSelection({ from: 1, to: 17 });
  });
  await context.setOffline(true);
  const picker = page.getByRole("dialog", { name: "Insert quote" });
  const trigger = page.getByRole("button", { name: "Insert quote", exact: true });
  await page.getByRole("button",{name:"Insert",exact:true}).click();
  await trigger.click();
  await picker.getByRole("button", { name: "Close" }).click();
  await expect(editor.locator(".source-citation")).toHaveCount(0);
  await page.getByRole("button",{name:"Insert",exact:true}).click();
  await trigger.click();
  await picker.getByRole("combobox", { name: "Book", exact: true }).selectOption({ label: "River journal" });
  await picker.getByLabel("Search highlights").fill("floodplains");
  await picker.getByRole("button", { name: /Rivers need healthy floodplains/ }).click();
  await expect(editor).toBeFocused();
  await expect(editor.locator("p")).toHaveText([
    "Keep these words", "Rivers need healthy floodplains.", "River journal · page 2", " and this suffix.", "Second paragraph.",
  ]);
  await page.getByRole("button",{name:"Format",exact:true}).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(editor.locator("p")).toHaveText(["Keep these words and this suffix.", "Second paragraph."]);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(editor.getByRole("link", { name: "River journal · page 2" })).toBeVisible();
  await expect(page.locator(".topic-save-status")).toContainText("Saved on this device");
  await context.setOffline(false);
  await page.reload();
  const citation = editor.getByRole("link", { name: "River journal · page 2" });
  await expect(citation).toHaveAttribute("href", /%22page%22%3A2/);
  await citation.click();
  await expect(page.locator(".reader-shell")).toHaveAttribute("data-loading", "false");
  await expect(page.locator(".pdf-page .textLayer").getByText("Rivers need healthy floodplains.", { exact: true })).toBeInViewport();
});

test("long notebook pages scroll independently of the notebook navigation and formatting toolbar", async ({ page }) => {
  await openNote(page);
  const editor = page.getByRole("textbox", { name: "Topic note content" });
  await editor.evaluate(element => {
    const { editor } = element as HTMLElement & { editor: import("@tiptap/core").Editor };
    editor.commands.setContent({ type: "doc", content: Array.from({ length: 45 }, (_, i) => ({
      type: "paragraph", content: [{ type: "text", text: `Study entry ${i + 1}` }],
    })) });
  });
  const header = page.getByRole("button", { name: "Pages", exact: true });
  const toolbar = page.getByRole("toolbar", { name: "Topic note formatting" });
  const start = { head: (await header.boundingBox())!.y, tools: (await toolbar.boundingBox())!.y };
  const last = editor.getByText("Study entry 45", { exact: true });
  await last.evaluate(element => {
    const scroll = element.closest(".notebook-page-scroll")!;
    scroll.scrollTop += element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12;
  });
  await expect.poll(() => page.locator(".notebook-page-scroll").evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  expect((await header.boundingBox())!.y).toBeCloseTo(start.head);
  expect((await toolbar.boundingBox())!.y).toBeCloseTo(start.tools);
  await expect(last).toBeInViewport();
});

test("paper ink stays with its paragraph, reopens and can be resized", async ({ page }, info) => {
  test.skip(info.project.name === "mobile-layout", "Mouse drawing and context menu regression.");
  await openNote(page);
  const editor = page.getByRole("textbox", { name: "Topic note content" });
  await editor.fill("The river runs through the old town.");
  await page.getByRole("button", { name: "Pen", exact: true }).click();
  await editor.locator("p").scrollIntoViewIfNeeded();
  const bounds = (await editor.locator("p").boundingBox())!;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(bounds.x + 20, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 105, y + 8, { steps: 8 });
  await page.mouse.up();
  const stroke = page.locator(".paper-ink-art path");
  await expect(stroke).toHaveCount(1);
  const anchor = editor.locator("[data-ink-anchor]");
  await expect(anchor).toHaveText("The river runs through the old town.");
  await expect(page.locator(".paper-ink-frame")).toHaveCount(0);
  await page.getByRole("button", {name:"Pen",exact:true}).click();
  await page.getByRole("button", { name: "Select drawing", exact: true }).click();
  const point = await stroke.evaluate(element => {
    const path = element as SVGPathElement;
    const p = path.getPointAtLength(path.getTotalLength() / 4);
    const screen = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(point.x, point.y);
  const handle = page.getByRole("button", { name: "Resize drawing", exact: true });
  await expect(handle).toBeVisible();
  if (info.project.name === "desktop") {
    const resize = (await handle.boundingBox())!;
    await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2);
    await page.mouse.down(); await page.mouse.move(resize.x + 24, resize.y + 6, { steps: 6 }); await page.mouse.up();
    await expect.poll(() => page.evaluate(async () => (await (await import("/src/db.ts")).list("notebook-overlay"))[0].scale)).toBeGreaterThan(1.1);
  }
  const scale = await page.evaluate(async () => (await (await import("/src/db.ts")).list("notebook-overlay"))[0].scale);
  await handle.focus(); await page.keyboard.press("+");
  await expect.poll(() => page.evaluate(async () => (await (await import("/src/db.ts")).list("notebook-overlay"))[0].scale)).toBeCloseTo(scale * 1.1);
  const heightHandle = page.getByRole("button", { name: "Resize drawing height", exact: true });
  await heightHandle.press("+");
  await expect.poll(() => page.evaluate(async () => {
    const [drawing] = await (await import("/src/db.ts")).list("notebook-overlay");
    return drawing.scaleY! > drawing.scaleX!;
  })).toBe(true);
  await page.getByRole("button", {name:"Pen",exact:true}).click();
  await page.getByRole("button", { name: "Write", exact: true }).click();
  // Insert a paragraph before the anchored block without splitting its identity.
  const paperOffset = () => stroke.evaluate(path => path.getBoundingClientRect().top - path.closest(".notebook-paper")!.getBoundingClientRect().top);
  const before = await paperOffset();
  await editor.evaluate(element => (element as HTMLElement & { editor: import("@tiptap/core").Editor }).editor.commands.insertContentAt(0, {
    type: "paragraph", content: [{ type: "text", text: "Field notes" }],
  }));
  await expect(editor.locator("p").first()).toHaveText("Field notes");
  await expect.poll(paperOffset).toBeGreaterThan(before + 10);
  await expect(page.locator(".topic-save-status")).toContainText("Saved on this device");
  await page.reload();
  await expect(stroke).toHaveCount(1);
  await expect(anchor).toHaveText("The river runs through the old town.");
  const currentPage = page.locator(".notebook-pages nav button[aria-current=page]");
  if (!(await currentPage.isVisible())) await page.getByRole("button", { name: "Pages", exact: true }).click();
  await currentPage.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByLabel("Name", { exact: true }).fill("River notes");
  await page.getByRole("button", { name: "Save name" }).click();
  const closeNavigation = page.getByRole("button", { name: "Close notebook navigation" });
  if (await closeNavigation.isVisible()) await closeNavigation.click();
  await expect(page.getByLabel("Topic note title")).toHaveValue("River notes");
});

test("audio attachments persist and a clicked timestamp seeks where the codec is available", async ({ page, browserName }) => {
  await openNote(page);
  await page.getByRole("textbox", { name: "Topic note content" }).fill("Listen for the change. ");
  const bytes = wavFixture();
  // Some Playwright WebKit builds advertise WAV but fail a plain media
  // element decoder. Verify attachment retention and download in that case.
  const codec = browserName !== "webkit" || await page.evaluate(async base64 => {
    const raw = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([raw], { type: "audio/wav" }));
    const element = new Audio();
    const playable = new Promise<boolean>(resolve => {
      element.onloadedmetadata = () => resolve(true); element.onerror = () => resolve(false);
    });
    element.src = url; element.load();
    const result = await Promise.race([playable, new Promise<boolean>(resolve => setTimeout(() => resolve(false), 3000))]);
    URL.revokeObjectURL(url);
    return result;
  }, bytes.toString("base64"));
  await page.getByLabel("Attach image, video or audio").setInputFiles({ name: "sample.wav", mimeType: "audio/wav", buffer: bytes });
  if (!codec) {
    await expect(page.getByText(/This file couldn’t play/)).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "More actions for sample.wav" }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Download original" }).click();
    expect((await download).suggestedFilename()).toBe("sample.wav");
    return;
  }
  const player = page.getByLabel("Topic note content").locator("audio");
  await expect.poll(() => player.evaluate(a => (a as HTMLAudioElement).duration)).toBe(3);
  await player.evaluate(a => { (a as HTMLAudioElement).currentTime = 1.5; });
  await page.getByRole("button", { name: "More actions for sample.wav" }).click();
  await page.getByRole("menuitem", { name: "Insert timestamp", exact: true }).click();
  const timestamp = page.getByRole("link", { name: "0:01" });
  await expect(timestamp).toBeVisible();
  await expect(page.locator(".topic-save-status")).toContainText("Saved on this device");
  await page.reload();
  await timestamp.click();
  await expect.poll(() => player.evaluate(a => (a as HTMLAudioElement).currentTime)).toBeCloseTo(1.5, 1);
  await page.getByRole("button", { name: "More actions for sample.wav" }).click();
  await expect(page.getByRole("menuitem", { name: "Available offline" })).toBeDisabled();
});

test("a downloaded video opens in the notebook player", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "The fixture uses Chromium's WebM recorder.");
  await openNote(page);
  const raw = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 32;
    const stream = canvas.captureStream(15), recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    const ready = new Promise<Blob>(resolve => { recorder.ondataavailable = event => resolve(event.data); });
    const paint = canvas.getContext("2d")!;
    recorder.start();
    for (const color of ["#315c86", "#8abde8", "#293541"]) {
      paint.fillStyle = color; paint.fillRect(0, 0, 32, 32);
      await new Promise(resolve => setTimeout(resolve, 70));
    }
    recorder.stop(); stream.getTracks().forEach(track => track.stop());
    return [...new Uint8Array(await (await ready).arrayBuffer())];
  });
  await page.getByLabel("Attach image, video or audio").setInputFiles({ name: "sample.webm", mimeType: "video/webm", buffer: Buffer.from(raw) });
  const attachment = page.getByRole("figure", { name: "Attachment: sample.webm" });
  await expect(attachment).toBeVisible();
  const original = (await attachment.boundingBox())!.width;
  await page.getByRole("button", { name: "More actions for sample.webm" }).click();
  await page.getByRole("menuitem", { name: "Display size" }).click();
  await page.getByLabel("Width (% of page)").fill("55");
  await page.getByRole("button", { name: "Apply size" }).click();
  await expect.poll(async () => (await attachment.boundingBox())!.width).toBeLessThan(original * .65);
  await expect.poll(() => page.getByLabel("Topic note content").locator("video").evaluate(v => (v as HTMLVideoElement).videoWidth)).toBe(32);
  await expect(page.getByRole("figure", { name: "Attachment: sample.webm" })).not.toContainText("sample.webm");
});

test("dropped images stay in the text flow and move without changing the writing", async ({ page, browserName }, info) => {
  test.skip(browserName !== "chromium", "External file drag uses Chromium's DataTransfer fixture.");
  await openNote(page);
  const editor = page.getByLabel("Topic note content");
  await editor.evaluate(element => (element as HTMLElement & { editor: import("@tiptap/core").Editor }).editor.commands.setContent({
    type: "doc", content: ["Before the image", "Keep writing after the image"].map(text => ({ type: "paragraph", content: [{ type: "text", text }] })),
  }));
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 16; canvas.height = 12;
    canvas.getContext("2d")!.fillRect(0, 0, 16, 12);
    return canvas.toDataURL().split(",")[1];
  });
  const transfer = await page.evaluateHandle(base64 => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "diagram.png", { type: "image/png" }));
    data.items.add(new File([bytes], "detail.png", { type: "image/png" }));
    return data;
  }, png);
  const first = editor.getByText("Before the image", { exact: true });
  const bounds = (await first.boundingBox())!;
  const coordinate = { clientX: bounds.x + bounds.width - 2, clientY: bounds.y + bounds.height / 2, dataTransfer: transfer };
  await first.dispatchEvent("dragover", coordinate);
  await expect(page.locator(".notebook-drop-line")).toBeVisible();
  await first.dispatchEvent("drop", coordinate);
  const blocks = editor.locator(":scope > p, :scope > .notebook-media-widget");
  await expect(blocks.nth(0)).toHaveText("Before the image");
  await expect(blocks.nth(1).getByRole("img", { name: "diagram.png" })).toBeVisible();
  await blocks.nth(2).scrollIntoViewIfNeeded();
  await expect(blocks.nth(2).getByRole("img", { name: "detail.png" })).toBeVisible();
  await expect(blocks.nth(3)).toHaveText("Keep writing after the image");
  await page.getByRole("button", { name: "More actions for detail.png" }).click();
  await page.getByRole("menuitem", { name: "Move up" }).click();
  await expect(blocks.nth(1).getByRole("img", { name: "detail.png" })).toBeVisible();
  await page.reload();
  await expect(blocks.nth(1).getByRole("img", { name: "detail.png" })).toBeVisible();
  await expect(blocks.nth(3)).toHaveText("Keep writing after the image");
  if (info.project.name === "desktop") {
    const paragraph = editor.getByText("Keep writing after the image", { exact: true });
    const handle = page.getByRole("button", { name: "Drag diagram.png", exact: true });
    await paragraph.scrollIntoViewIfNeeded();
    await handle.hover();
    const size = (await paragraph.boundingBox())!;
    await page.mouse.down(); await page.mouse.move(size.x + size.width - 3, size.y + size.height / 2, { steps: 12 }); await page.mouse.up();
    await expect(blocks.nth(2)).toHaveText("Keep writing after the image");
    await expect(blocks.nth(3).getByRole("img", { name: "diagram.png" })).toBeVisible();
  }
});

test("a group of attachments can move freely and be copied to a different page", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Exercises desktop marquee and pointer dragging.");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openNote(page);
  const writing = page.getByRole("textbox", { name: "Topic note content" });
  await writing.fill("A caption before the diagrams.");
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 220; canvas.height = 100;
    canvas.getContext("2d")!.fillRect(0, 0, 220, 100);
    return canvas.toDataURL().split(",")[1];
  });
  const uploads = ["first.png", "second.png"].map(name => ({ name, mimeType: "image/png", buffer: Buffer.from(base64, "base64") }));
  await page.getByLabel("Attach image, video or audio").setInputFiles(uploads);
  const media = page.locator(".notebook-paper .note-media");
  await expect(media).toHaveCount(2);
  const sheet = (await page.locator(".note-paper-column").boundingBox())!;
  expect(sheet.width).toBeLessThanOrEqual(768);
  await media.last().scrollIntoViewIfNeeded();
  const top = (await media.first().boundingBox())!, bottom = (await media.last().boundingBox())!;
  await page.getByRole("button", { name: "Select", exact:true }).click();
  const paper = (await page.locator(".notebook-paper").boundingBox())!;
  await page.mouse.move(paper.x + paper.width - 10, top.y - 4); await page.mouse.down();
  await page.mouse.move(paper.x + 4, bottom.y + bottom.height + 3, { steps: 12 }); await page.mouse.up();
  await page.getByRole("button", {name:"Select",exact:true}).click();
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Move selection freely" }).click();
  const floated = page.locator(".notebook-free-media .is-free");
  await expect(floated).toHaveCount(2);
  const before = (await floated.first().boundingBox())!.x;
  const handle = (await page.getByRole("button", { name: "Drag first.png" }).boundingBox())!;
  await page.mouse.move(handle.x + 17, handle.y + 17); await page.mouse.down();
  await page.mouse.move(handle.x + 117, handle.y + 17, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => (await floated.first().boundingBox())!.x).toBeGreaterThan(before + 70);
  const left = (await floated.last().boundingBox())!.x;
  expect(left).toBeGreaterThan(before + 70);
  await page.getByRole("button", {name:"Select",exact:true}).click();
  await page.getByRole("button", { name: "Copy attachments" }).click();
  await page.getByRole("button", {name:"Pages",exact:true}).click();
  await page.getByRole("button", { name: "New page", exact: true }).click();
  await expect(writing).toHaveAttribute("contenteditable", "true");
  await page.getByRole("button", {name:"Page options",exact:true}).click();
  await page.getByRole("button", {name:"Select",exact:true}).click();
  await page.getByRole("button", {name:"Select",exact:true}).click();
  await page.getByRole("button", { name: "Paste attachments" }).click();
  await expect(writing.locator(".note-media")).toHaveCount(2);
  await expect(writing.getByRole("img", { name: "first.png" })).toBeVisible();
  await page.reload(); await expect(writing.locator(".note-media")).toHaveCount(2);
});

test("holding a notebook image on a phone opens attachment actions", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile-layout", "Exercises a native Chromium touch hold.");
  await openNote(page);
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 120; canvas.height = 70;
    canvas.getContext("2d")!.fillRect(0, 0, 120, 70);
    return canvas.toDataURL().split(",")[1];
  });
  await page.getByLabel("Attach image, video or audio").setInputFiles({ name: "study.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  const image = page.getByRole("img", { name: "study.png" });
  await image.scrollIntoViewIfNeeded();
  const bounds = (await image.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bounds.x + 60, y: bounds.y + 35 }] });
  await expect(page.getByRole("menuitem", { name: "Download original" })).toBeVisible();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.getByRole("menuitem", { name: "Move to Trash" })).toBeVisible();
});

test("peeking at pages preserves the selected words and the writing column", async ({page}, info) => {
  test.skip(info.project.name !== "desktop", "Requires a fine hover pointer");
  await openNote(page);
  const editor = page.getByLabel("Topic note content");
  await editor.fill("Return to the passage.");
  await editor.press("ControlOrMeta+a");
  const selection = () => page.evaluate(() => window.getSelection()?.toString());
  const before = await editor.boundingBox();
  await page.mouse.move(3,160);
  await expect(page.getByLabel("Notebook pages")).toBeVisible();
  await page.mouse.move(900,160);
  await expect(page.getByLabel("Notebook pages")).toBeHidden();
  expect(await editor.boundingBox()).toEqual(before);
  expect(await selection()).toContain("Return to the passage.");
  await page.getByRole("button",{name:"Pages",exact:true}).click();
  await page.mouse.move(900,160);
  await expect(page.getByLabel("Notebook pages")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Notebook pages")).toBeHidden();
});

test("mixed page selection cuts, undoes and pastes text, media and ink together", async ({page}) => {
  await openNote(page);
  const editor=page.getByRole("textbox",{name:"Topic note content"});
  await editor.fill("First paragraph."); await editor.press("End"); await editor.press("Enter");
  await editor.pressSequentially("Second paragraph.");
  await page.getByLabel("Attach image, video or audio").setInputFiles([
    {name:"Diagram.png",mimeType:"image/png",buffer:Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=","base64")},
    {name:"Recording.wav",mimeType:"audio/wav",buffer:wavFixture()},
  ]);
  const media=page.locator(".notebook-paper .note-media"), strokes=page.locator(".paper-ink-art path");
  await expect(media).toHaveCount(2);
  await page.evaluate(async () => {
    const {save,list}=await import("/src/db.ts");
    const [note]=await list("notebook-note");
    const createdAt=new Date().toISOString();
    await save("notebook-overlay",{id:"page-ink",noteId:note.id,anchor:"paper",x:30,y:20,scale:1,createdAt});
    await save("ink-stroke",{id:"pen-mark",target:{type:"notebook",noteId:note.id,blockId:"page-ink"},tool:"pen",
      color:"#315c86",width:3,points:[[0,0,.5],[25,12,.5]],createdAt});
  });
  await expect(strokes).toHaveCount(1);
  // A real browser range preserves the endpoint words in either direction.
  // Place an inline attachment between the two paragraphs.
  await page.evaluate(async () => {
    const {list,save}=await import("/src/db.ts");
    const [note]=await list("notebook-note"), [image]=await list("notebook-image");
    const el=document.querySelector(".notebook-writing");
    const ed=(el as HTMLElement & {editor:import("@tiptap/core").Editor}).editor;
    const first=ed.state.doc.firstChild!;
    ed.view.dispatch(ed.state.tr.setNodeMarkup(0,undefined,{...first.attrs,inkAnchor:"between-lines"}));
    await save("notebook-image",{...image,placement:{after:"between-lines",order:0}});
    const [overlay]=await list("notebook-overlay");
    await save("notebook-overlay",{...overlay,noteId:note.id,anchor:"between-lines",x:110,y:6});
  });
  for (const backward of [true,false]) {
    await editor.evaluate((el,reverse) => {
      const first=el.querySelector("p")!.firstChild!;
      const last=Array.from(el.querySelectorAll("p")).find(p=>p.textContent==="Second paragraph.")!.firstChild!;
      (el as HTMLElement).focus();
      const sel=document.getSelection()!;
      if (reverse) sel.setBaseAndExtent(last,6,first,6); else sel.setBaseAndExtent(first,6,last,6);
      document.dispatchEvent(new Event("selectionchange"));
    },backward);
    await expect(page.getByRole("figure",{name:"Attachment: Diagram.png"})).toHaveClass(/is-selected/);
    const selectedText=await editor.evaluate(el=>{
      const data=new DataTransfer();
      el.dispatchEvent(new ClipboardEvent("copy",{clipboardData:data,bubbles:true,cancelable:true}));
      return data.getData("text/plain");
    });
    expect(selectedText).toContain("paragraph."); expect(selectedText).toContain("Second"); expect(selectedText).not.toContain("First");
  }
  await editor.press("Control+a");
  await expect(media.first()).toHaveClass(/is-selected/); await expect(strokes).toHaveClass(/note-stroke-picked/);
  const clip = await editor.evaluateHandle(el => {
    const clipboardData=new DataTransfer();
    el.dispatchEvent(new ClipboardEvent("cut",{clipboardData,bubbles:true,cancelable:true}));
    return clipboardData;
  });
  expect(await clip.evaluate(data=>data.getData("text/plain"))).toContain("First paragraph.");
  await expect(media).toHaveCount(0); await expect(strokes).toHaveCount(0);
  await expect(editor).not.toContainText("First paragraph.");
  await page.getByRole("button",{name:"Format",exact:true}).click();
  await page.getByRole("button",{name:"Undo",exact:true}).click();
  await expect(media).toHaveCount(2); await expect(strokes).toHaveCount(1); await expect(editor).toContainText("First paragraph.");
  await page.getByRole("button",{name:"Pages",exact:true}).click();
  await page.getByRole("button",{name:"New page",exact:true}).click();
  await expect(editor).toBeEditable();
  await editor.click(); await editor.evaluate((el,data)=>{el.dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true}));},clip);
  await expect(editor).toContainText("Second paragraph."); await expect(media).toHaveCount(2); await expect(strokes).toHaveCount(1);
  await page.reload();
  await expect(editor).toContainText("First paragraph."); await expect(media).toHaveCount(2); await expect(strokes).toHaveCount(1);
});
