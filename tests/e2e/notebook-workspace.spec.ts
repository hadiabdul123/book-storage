import { expect, test, type Page } from "@playwright/test";
import { wavFixture } from "../helpers/audio-fixture";

async function openNote(page: Page) {
  await page.goto("/#/notebooks");
  await page.getByRole("button", { name: "New notebook" }).click();
  await page.getByLabel("Notebook name").fill("Field journal");
  await page.getByRole("button", { name: "Create notebook" }).click();
  await expect(page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "New notebook" }) })).toBeHidden();
  await expect(page.locator(".notebook-detail-actions")).toContainText("Field journal");
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Topic note content" })).toHaveAttribute("contenteditable", "true");
}


test("paper ink stays with its paragraph, reopens and can be resized", async ({ page }, info) => {
  test.skip(info.project.name === "mobile-layout", "Mouse drawing and context menu regression.");
  await openNote(page);
  const editor = page.getByRole("textbox", { name: "Topic note content" });
  await editor.fill("The river runs through the old town.");
  await page.getByRole("button", { name: "Pen", exact: true }).click();
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
  await page.getByRole("button", { name: "Select drawing", exact: true }).click();
  const point = await stroke.evaluate(element => {
    const path = element as SVGPathElement;
    const p = path.getPointAtLength(path.getTotalLength() / 4);
    const screen = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(point.x, point.y);
  const handle = page.getByRole("button", { name: "Resize drawing" });
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
  await page.getByRole("button", { name: "Select media" }).click();
  const paper = (await page.locator(".notebook-paper").boundingBox())!;
  await page.mouse.move(paper.x + paper.width - 10, top.y - 4); await page.mouse.down();
  await page.mouse.move(paper.x + 4, bottom.y + bottom.height + 3, { steps: 12 }); await page.mouse.up();
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
  await page.getByRole("button", { name: "Copy attachments" }).click();
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await expect(writing).toHaveAttribute("contenteditable", "true");
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
