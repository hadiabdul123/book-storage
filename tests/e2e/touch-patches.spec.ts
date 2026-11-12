import { scanPdf } from "../helpers/scanned-pdf";
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { clickTool } from "./controls";

async function openPdf(page: Page) {
  await page.goto("/");
  await page
    .locator("input[type=file]")
    .setInputFiles(path.resolve("tests/fixtures/tracemonkey.pdf"));
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".pdf-page .textLayer span").first()).toBeVisible();
}
async function stroke(
  page: Page,
  x: number,
  y: number,
  dx = 0,
  dy = 0,
  hold = 0,
  stepMs = 20,
) {
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  if (hold) await page.waitForTimeout(hold);
  if (dx || dy)
    for (let n = 1; n <= 5; n++) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + (dx * n) / 5, y: y + (dy * n) / 5 }],
      });
      await page.waitForTimeout(stepMs);
    }
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await session.detach();
}
test("toolbar survives pointer gaps and bookmarks remain clickable beside a selection popup", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  await openPdf(page);
  await page.mouse.move(200, 8);
  await expect(page.locator(".reader-header")).toBeVisible();
  await page.mouse.move(200, 110);
  await page.waitForTimeout(600);
  await expect(page.locator(".reader-header")).toBeVisible();
  const bookmark = page.getByRole("button", {
    name: "Add bookmark",
    exact: true,
  });
  await bookmark.hover();
  await page.waitForTimeout(1300);
  await bookmark.click();
  await expect(
    page.getByRole("button", { name: "Remove bookmark", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .locator(".textLayer span")
    .first()
    .evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = document.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    });
  await expect(page.locator(".passage-popup")).toBeVisible();
  await page
    .getByRole("button", { name: "Remove bookmark", exact: true })
    .click();
  await expect(bookmark).toHaveAttribute("aria-pressed", "false");
  await bookmark.click();
  await expect(
    page.getByRole("button", { name: "Remove bookmark", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});
test("phone swipe preference persists and avoids selection, vertical scrolling and zoomed panning", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "mobile-layout");
  await openPdf(page);
  await clickTool(page, "Reading settings");
  await page.getByLabel("Swipe to turn pages").click();
  await expect(page.getByLabel("Swipe to turn pages")).toBeChecked();
  await expect(
    page.getByRole("combobox", { name: "Navigation", exact: true }),
  ).toHaveValue("paginated");
  await page.getByRole("button", { name: "Close panel" }).click();
  const host = await page.locator(".reader-host").boundingBox();
  const x = host!.width * 0.75,
    y = host!.height * 0.5;
  await stroke(page, x, y, -170, 0);
  await expect(page.locator(".reader-progress")).toContainText("Page 2");
  await stroke(page, x - 170, y, 170, 0);
  await expect(page.locator(".reader-progress")).toContainText("Page 1");
  // Natural diagonal and slower thumb swipes still turn exactly one page.
  await stroke(page, x, y, -170, 45, 0, 120);
  await expect(page.locator(".reader-progress")).toContainText("Page 2");
  await stroke(page, x - 170, y, 170, -45);
  await expect(page.locator(".reader-progress")).toContainText("Page 1");
  await stroke(page, x, y, 0, -100);
  await expect(page.locator(".reader-progress")).toContainText("Page 1");
  await page
    .locator(".textLayer span")
    .first()
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
  await expect(page.locator(".passage-popup")).toBeVisible();
  await stroke(page, x, y, -170, 0);
  await expect(page.locator(".reader-progress")).toContainText("Page 1");
  await page.reload();
  await expect(page.locator(".textLayer span").first()).toBeVisible();
  await clickTool(page, "Reading settings");
  await expect(page.getByLabel("Swipe to turn pages")).toBeChecked();
  await page
    .getByRole("combobox", { name: "Zoom", exact: true })
    .selectOption("2");
  await page.getByRole("button", { name: "Close panel" }).click();
  await stroke(page, x, y, -170, 0);
  await expect(page.locator(".reader-progress")).toContainText("Page 1");
});

test("scanned pages recognize automatically, touch-select with handles, and retain highlights and text on reload", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "mobile-layout");
  test.setTimeout(120000);
  const external: string[] = [];
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).hostname !== "127.0.0.1") {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "Original scan.pdf",
    mimeType: "application/pdf",
    buffer: await scanPdf(page),
  });
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".pdf-page canvas")).toBeVisible();
  // No click or long press is needed to start recognition.
  await expect(page.locator(".ocr-text-layer span").first()).toBeVisible({ timeout: 60000 });
  const box = await page.locator(".pdf-page").boundingBox();
  // Long-press now selects the automatically recognized word.
  await stroke(
    page,
    box!.x + box!.width * 0.16,
    box!.y + box!.height * 0.125,
    0,
    0,
    750,
  );
  await expect(page.locator(".ocr-text-layer span").first()).toBeVisible({
    timeout: 60000,
  });
  await expect(page.locator(".passage-popup")).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".selection-excerpt")).toContainText("Reading");
  await expect(
    page.getByRole("button", { name: "Drag selection end" }),
  ).toBeVisible();
  const end = await page
    .getByRole("button", { name: "Drag selection end" })
    .boundingBox();
  const next = await page
    .locator(".ocr-text-layer span")
    .filter({ hasText: /^opens / })
    .boundingBox();
  await stroke(
    page,
    end!.x + 22,
    end!.y + 22,
    next!.x + next!.width / 2 - (end!.x + 22),
    next!.y + next!.height / 2 + 28 - (end!.y + 22),
  );
  await expect(page.locator(".selection-excerpt")).toContainText(
    "Reading opens",
  );
  await page
    .getByRole("button", { name: "yellow highlight", exact: true })
    .tap();
  await expect(page.locator(".pdf-highlight").first()).toBeVisible();
  await page.screenshot({ path: ".local/scanned-mobile-selection.png" });
  await page.reload();
  await expect(page.locator(".ocr-text-layer")).toContainText("Reading opens");
  await expect(page.locator(".pdf-highlight").first()).toBeVisible();
  expect(external).toEqual([]);
});

test("phone EPUB swipes turn the displayed reading page", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "mobile-layout");
  await page.goto("/");
  await page
    .locator("input[type=file]")
    .setInputFiles(path.resolve("tests/fixtures/alice.epub"));
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".reader-loading")).toHaveCount(0);
  await clickTool(page, "Reading settings");
  await page.getByLabel("Swipe to turn pages").click();
  await expect(page.getByLabel("Swipe to turn pages")).toBeChecked();
  await page.getByRole("button", { name: "Close panel" }).click();
  await clickTool(page, "Contents");
  await page
    .locator(".toc-item")
    .filter({ hasText: /rabbit|chapter|down/i })
    .first()
    .click();
  await expect(
    page.frameLocator(".reader-host iframe").first().locator("body"),
  ).toContainText("Alice was beginning");
  const before = await page.locator(".reader-progress").innerText();
  await stroke(page, 310, 400, -180, 0);
  await expect(page.locator(".reader-progress")).not.toHaveText(before);
});


test("selection tools keep their initial position after the first measurement", async ({ page }) => {
  await openPdf(page);
  const positions = await page.evaluate(() => new Promise<number[]>((resolve, reject) => {
    const span = Array.from(document.querySelectorAll(".textLayer span")).find(el => {
      const r = el.getBoundingClientRect();
      return r.top > 300 && r.bottom < innerHeight - 180 && (el.textContent?.length || 0) > 10;
    });
    if (!span) return reject(new Error("No visible text for placement test"));
    const positions: number[] = [];
    let started = 0;
    const deadline = performance.now() + 5000;
    const sample = (time: number) => {
      const popup = document.querySelector<HTMLElement>(".passage-popup");
      if (popup && getComputedStyle(popup).visibility === "visible") {
        started ||= time;
        positions.push(popup.getBoundingClientRect().top);
      }
      if (started && time - started > 240) return resolve(positions);
      if (time > deadline) return reject(new Error("Selection tools did not appear"));
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }));
  expect(positions.length).toBeGreaterThan(2);
  expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(2);
});


test("phone toolbar taps are prompt even when Chrome clears a collapsed selection", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile-layout");
  await openPdf(page);
  const latency = await page.locator(".reader-host").evaluate(host => new Promise<number>((resolve, reject) => {
    const header = document.querySelector<HTMLElement>(".reader-header")!;
    const started = performance.now();
    const send = (type: string) => host.dispatchEvent(new PointerEvent(type, {
      pointerId: 4, pointerType: "touch", isPrimary: true, bubbles: true,
      clientX: 200, clientY: 400,
    }));
    send("pointerdown");
    document.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    send("pointerup");
    const check = () => {
      if (getComputedStyle(header).visibility !== "hidden") return resolve(performance.now() - started);
      if (performance.now() - started > 1000) return reject(new Error("Tap was lost"));
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }));
  expect(latency).toBeLessThan(220);
  // A second deliberate quick tap must not be swallowed by a double-tap timer.
  await page.touchscreen.tap(25, 400);
  await expect(page.locator(".reader-header")).toBeHidden();
});

test("page buttons animate once, preserve rendered pages and respect reduced motion", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Element.prototype.animate;
    (window as any).pageSlides = [];
    Element.prototype.animate = function(frames, options) {
      if (this.classList.contains("reader-host")) (window as any).pageSlides.push(frames);
      return original.call(this, frames, options);
    };
  });
  await openPdf(page);
  await clickTool(page, "Reading settings");
  await page.getByRole("combobox", { name: "Navigation", exact: true }).selectOption("paginated");
  await page.getByRole("button", { name: "Close panel" }).click();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.locator(".reader-progress")).toContainText("Page 2");
  await expect(page.locator('.pdf-page[data-page="2"] canvas')).toBeVisible();
  await expect(page.locator(".reader-host")).not.toHaveAttribute("data-page-turning", /.+/);
  expect(await page.evaluate(() => (window as any).pageSlides.length)).toBe(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  await expect(page.locator(".reader-progress")).toContainText("Page 1");
  expect(await page.evaluate(() => (window as any).pageSlides.length)).toBe(1);
  await page.getByRole("button", { name: "Next page", exact: true }).evaluate(button => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(page.locator(".reader-progress")).toContainText("Page 2");
  await expect(page.locator(".reader-host")).not.toHaveAttribute("data-page-turning", /.+/);
  await expect(page.locator(".reader-progress")).toContainText("Page 2");
});


test("desktop mouse selection works on automatically recognized scans and survives reload", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  test.setTimeout(90000);
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "Automatic scan.pdf", mimeType: "application/pdf", buffer: await scanPdf(page),
  });
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator(".book-cover-link").click();
  const words = page.locator(".ocr-text-layer span");
  await expect(words.first()).toBeVisible({ timeout: 60000 });
  const first = (await words.first().boundingBox())!;
  const second = (await words.nth(1).boundingBox())!;
  await page.mouse.move(first.x + 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + second.width - 2, second.y + second.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(".selection-excerpt")).toContainText("Reading opens");
  await page.getByRole("button", { name: "blue highlight", exact: true }).click();
  await expect(page.locator(".pdf-highlight").first()).toBeVisible();
  // Recognized text is cached locally; reopening does not need the OCR worker.
  await page.route("**/ocr/**", route => route.abort());
  await page.reload();
  await expect(words.first()).toBeVisible();
  await expect(page.locator(".pdf-highlight").first()).toBeVisible();
});

test("phone pages use the screen width and center vertically with compact selection tools", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile-layout");
  await openPdf(page);
  await clickTool(page, "Reading settings");
  await page.getByLabel("Swipe to turn pages").click();
  await page.getByRole("button", { name: "Close panel" }).click();
  await expect(page.locator(".reader-host")).toHaveAttribute("data-navigation", "paginated");
  const host = (await page.locator(".reader-host").boundingBox())!;
  const paper = (await page.locator('.pdf-page[data-page="1"]').boundingBox())!;
  expect(host.width - paper.width).toBeLessThan(10);
  expect(Math.abs((paper.x + paper.width / 2) - (host.x + host.width / 2))).toBeLessThan(2);
  expect(Math.abs((paper.y + paper.height / 2) - (host.y + host.height / 2))).toBeLessThan(4);
  await page.locator('.pdf-page[data-page="1"] .textLayer span').first().evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  const popup = page.locator(".passage-popup");
  await expect(popup).toBeVisible();
  expect((await popup.boundingBox())!.height).toBeLessThan(150);
  const button = (await page.getByRole("button", { name: "yellow highlight", exact: true }).boundingBox())!;
  expect(button.width).toBeGreaterThanOrEqual(44);
  expect(button.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: ".local/compact-phone-page.png" });
});


test("a blank scanned page does not interrupt reading or retry recognition endlessly", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  test.setTimeout(90000);
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "Blank scan.pdf", mimeType: "application/pdf", buffer: await scanPdf(page, true),
  });
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator(".book-cover-link").click();
  await expect.poll(() => page.evaluate(async () => {
    const { db } = await import("/src/db.ts");
    return (await db.meta.where("key").startsWith("ocr-v2:").toArray()).map(row => row.value);
  }), { timeout: 60000 }).toEqual(["[]"]);
  await page.route("**/ocr/**", route => route.abort());
  await page.reload();
  await expect(page.locator(".pdf-ocr-button")).toBeHidden();
  await expect(page.locator(".reader-error")).toHaveCount(0);
  await expect(page.locator(".pdf-page canvas")).toBeVisible();
});

test("navigation mode switches reuse rendered pages and keep the current page", async ({ page }) => {
  await openPdf(page);
  await clickTool(page, "Reading settings");
  const navigation = page.getByRole("combobox", { name: "Navigation", exact: true });
  await navigation.selectOption("paginated");
  await expect(page.locator(".reader-host")).toHaveAttribute("data-navigation", "paginated");
  const canvas = await page.locator('.pdf-page[data-page="1"] canvas').elementHandle();
  expect(canvas).not.toBeNull();
  for (const mode of ["continuous", "paginated", "continuous"]) {
    await navigation.selectOption(mode);
    await expect(page.locator(".reader-host")).toHaveAttribute("data-navigation", mode);
    expect(await canvas!.evaluate(el => el.isConnected)).toBe(true);
    await expect(page.locator('.pdf-page[data-page="1"]')).toBeVisible();
  }
});


test("recognition prepares unseen pages once and reuses the whole saved result after reload", async ({ page }) => {
  test.setTimeout(90000);
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "Background scan.pdf", mimeType: "application/pdf", buffer: await scanPdf(page, false, 3),
  });
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator(".book-cover-link").click();
  await expect(page.locator('.pdf-page[data-page="1"] .ocr-text-layer')).toContainText("Reading opens", { timeout: 60000 });
  await expect.poll(() => page.evaluate(async () => {
    const { db } = await import("/src/db.ts");
    return (await db.meta.where("key").startsWith("ocr-v2:").toArray())
      .filter(row => JSON.parse(row.value).some((word: any) => word.text === "Reading")).length;
  }), { timeout: 60000 }).toBe(3);
  let restartedWorker = false;
  await page.route("**/ocr/**", route => { restartedWorker = true; return route.abort(); });
  await page.reload();
  await expect(page.locator('.pdf-page[data-page="1"] .ocr-text-layer')).toContainText("Reading opens");
  await page.locator('.pdf-page[data-page="3"]').scrollIntoViewIfNeeded();
  await expect(page.locator('.pdf-page[data-page="3"] .ocr-text-layer')).toContainText("Reading opens");
  expect(restartedWorker).toBe(false);
  await expect(page.locator(".reader-error")).toHaveCount(0);
});


test("failed OCR startup pauses background processing and manual retry recovers", async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let attempts = 0;
  await page.route("**/ocr/worker.min.js", route => { attempts++; return route.abort(); });
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "Retry scan.pdf", mimeType: "application/pdf", buffer: await scanPdf(page, false, 3),
  });
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator(".book-cover-link").click();
  const retry = page.locator('.pdf-page[data-page="1"] .pdf-ocr-button');
  await expect(retry).toHaveText("Retry text recognition");
  await page.waitForTimeout(1000);
  expect(attempts).toBe(1);
  await page.unroute("**/ocr/worker.min.js");
  await retry.click();
  await expect(page.locator('.pdf-page[data-page="1"] .ocr-text-layer')).toContainText("Reading opens", { timeout: 60000 });
  await expect.poll(() => page.evaluate(async () => {
    const { db } = await import("/src/db.ts");
    return db.meta.where("key").startsWith("ocr-v2:").count();
  }), { timeout: 60000 }).toBe(3);
  expect(errors).toEqual([]);
});


test("a fully saved scanned book never announces recognition again after refresh", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__recognitionNotices = [];
    new MutationObserver(() => {
      for (const button of document.querySelectorAll(".pdf-ocr-button.recognizing:not([hidden])"))
        (window as any).__recognitionNotices.push(button.textContent);
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "Already prepared.pdf", mimeType: "application/pdf", buffer: await scanPdf(page, false, 12),
  });
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.evaluate(async () => {
    const { db, list } = await import("/src/db.ts");
    const book = (await list("book"))[0];
    await db.meta.bulkPut(Array.from({ length: 12 }, (_, n) => ({
      key: `ocr-v2:${book.id}:${book.hash}:${n + 1}`,
      value: JSON.stringify([{ text: "Saved recognition", rect: [50, 500, 200, 530] }]),
    })));
  });
  let workerStarts = 0;
  await page.route("**/ocr/**", route => { workerStarts++; return route.abort(); });
  await page.locator(".book-cover-link").click();
  await expect(page.locator('.pdf-page[data-page="1"] .ocr-text-layer')).toContainText("Saved recognition");
  await page.reload();
  await expect(page.locator('.pdf-page[data-page="1"] .ocr-text-layer')).toContainText("Saved recognition");
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => (window as any).__recognitionNotices)).toEqual([]);
  expect(workerStarts).toBe(0);
  await page.locator('.pdf-page[data-page="12"]').scrollIntoViewIfNeeded();
  await expect(page.locator('.pdf-page[data-page="12"] .ocr-text-layer')).toContainText("Saved recognition");
});


test("refresh resumes only unfinished scanned pages and retains completed text", async ({ page }) => {
  test.setTimeout(90000);
  await page.addInitScript(() => {
    (window as any).__ocrJobs = 0;
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message: any, ...args: any[]) {
      if (message?.action === "recognize") (window as any).__ocrJobs++;
      return (send as any).call(this, message, ...args);
    };
  });
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "Partly prepared.pdf", mimeType: "application/pdf", buffer: await scanPdf(page, false, 3),
  });
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.evaluate(async () => {
    const { db, list } = await import("/src/db.ts");
    const book = (await list("book"))[0];
    await db.meta.bulkPut([1, 2].map(n => ({
      key: `ocr-v2:${book.id}:${book.hash}:${n}`,
      value: JSON.stringify([{ text: "Previously saved", rect: [50, 500, 200, 530] }]),
    })));
  });
  await page.locator(".book-cover-link").click();
  await expect.poll(() => page.evaluate(async () => {
    const { db } = await import("/src/db.ts");
    return db.meta.where("key").startsWith("ocr-v2:").count();
  }), { timeout: 60000 }).toBe(3);
  expect(await page.evaluate(() => (window as any).__ocrJobs)).toBe(1);
  await expect(page.locator('.pdf-page[data-page="1"] .ocr-text-layer')).toContainText("Previously saved");
  await page.reload();
  await expect(page.locator('.pdf-page[data-page="1"] .ocr-text-layer')).toContainText("Previously saved");
  await page.locator('.pdf-page[data-page="3"]').scrollIntoViewIfNeeded();
  await expect(page.locator('.pdf-page[data-page="3"] .ocr-text-layer')).toContainText("Reading opens");
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => (window as any).__ocrJobs)).toBe(0);
  await expect(page.locator('.pdf-ocr-button.recognizing')).toHaveCount(0);
});
