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

test("scanned pages recognize locally, touch-select with handles, and retain highlights and text on reload", async ({
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
  const box = await page.locator(".pdf-page").boundingBox();
  // Long-press the image itself: recognition must start without a settings detour.
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
