import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { clickTool, openTools } from "./controls";

async function openPdf(page: Page) {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles(path.resolve("tests/fixtures/tracemonkey.pdf"));
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".pdf-page .textLayer span").first()).toBeVisible();
  await clickTool(page, "Reading settings");
  await page.getByLabel("Keep controls visible on this device").check();
}

test("bottom page controls can be hidden independently and stay hidden after reload", async ({ page }) => {
  await openPdf(page);
  await expect(page.locator(".reader-footer")).toBeVisible();
  await page.getByLabel("Hide bottom page controls").check();
  await expect(page.locator(".reader-footer")).toHaveCount(0);
  await expect(page.locator(".reader-header")).toBeVisible();
  await page.getByRole("button", { name: "Close panel" }).click();
  await page.reload();
  await expect(page.locator(".pdf-page canvas").first()).toBeVisible();
  await expect(page.locator(".reader-footer")).toHaveCount(0);
  await clickTool(page, "Reading settings");
  await expect(page.getByLabel("Hide bottom page controls")).toBeChecked();
  await page.getByLabel("Hide bottom page controls").uncheck();
  await expect(page.locator(".reader-footer")).toBeVisible();
});

test("desktop wheel and keyboard zoom resize only the PDF and retain saved zoom", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  await openPdf(page);
  const paper = page.locator('.pdf-page[data-page="1"]');
  const original = (await paper.boundingBox())!;
  const header = (await page.locator(".reader-header").boundingBox())!;
  const panel = (await page.locator(".reader-panel").boundingBox())!;
  const viewport = await page.evaluate(() => ({ width: innerWidth, ratio: devicePixelRatio }));
  await page.mouse.move(original.x + 150, 350);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -200);
  await page.keyboard.up("Control");
  await expect.poll(async () => Number(await page.getByRole("combobox", { name: "Zoom", exact: true }).inputValue())).toBeGreaterThan(1.4);
  expect((await paper.boundingBox())!.width).toBeGreaterThan(original.width * 1.4);
  expect((await page.locator(".reader-header").boundingBox())!.height).toBe(header.height);
  expect((await page.locator(".reader-panel").boundingBox())!.width).toBe(panel.width);
  expect(await page.evaluate(() => ({ width: innerWidth, ratio: devicePixelRatio }))).toEqual(viewport);
  await page.locator(".reader-host").focus();
  await page.keyboard.press("Control+0");
  await expect(page.getByRole("combobox", { name: "Zoom", exact: true })).toHaveValue("1");
  await page.keyboard.press("Control+Equal");
  await expect(page.getByRole("combobox", { name: "Zoom", exact: true })).toHaveValue("1.25");
  await page.reload();
  await clickTool(page, "Reading settings");
  await expect(page.getByRole("combobox", { name: "Zoom", exact: true })).toHaveValue("1.25");
  expect((await page.locator(".reader-header").boundingBox())!.height).toBe(header.height);
  await page.locator(".reader-host").focus();
  await page.keyboard.press("Control+Minus");
  await expect(page.getByRole("combobox", { name: "Zoom", exact: true })).toHaveValue("1");
});

test("phone pinch zoom keeps chrome fixed, allows panning, and does not turn pages", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile-layout");
  await openPdf(page);
  await page.getByLabel("Swipe to turn pages").check();
  await page.getByRole("button", { name: "Close panel" }).click();
  const header = (await page.locator(".reader-header").boundingBox())!;
  const paper = page.locator('.pdf-page[data-page="1"]');
  const original = (await paper.boundingBox())!;
  const session = await page.context().newCDPSession(page);
  const center = { x: 195, y: 370 };
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [
    { x: center.x - 45, y: center.y, id: 1 }, { x: center.x + 45, y: center.y, id: 2 },
  ] });
  for (let step = 1; step <= 6; step++) {
    const distance = 45 + step * 7;
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [
      { x: center.x - distance, y: center.y, id: 1 }, { x: center.x + distance, y: center.y, id: 2 },
    ] });
    await page.waitForTimeout(20);
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(async () => (await paper.boundingBox())!.width).toBeGreaterThan(original.width * 1.7);
  await expect(page.locator(".reader-host")).not.toHaveClass(/pdf-zooming/);
  await expect.poll(() => page.evaluate(async () => {
    const { db, list } = await import("/src/db.ts");
    const book = (await list("book"))[0];
    return JSON.parse((await db.meta.get(`device-reading:${book.id}`))!.value).zoom || 1;
  })).toBeGreaterThan(1.7);
  expect(await page.evaluate(() => visualViewport!.scale)).toBe(1);
  expect((await page.locator(".reader-header").boundingBox())!.height).toBe(header.height);
  await expect(page.locator(".reader-progress")).toContainText("Page 1");
  const before = await page.locator(".reader-host").evaluate(el => el.scrollLeft);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 270, y: 440 }] });
  for (let step = 1; step <= 6; step++) {
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 270 - step * 20, y: 440 }] });
    await page.waitForTimeout(20);
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => page.locator(".reader-host").evaluate(el => el.scrollLeft)).toBeGreaterThan(before + 20);
  await expect(page.locator(".reader-progress")).toContainText("Page 1");
  await session.detach();
  await page.reload();
  await openTools(page);
  await expect.poll(async () => (await paper.boundingBox())!.width).toBeGreaterThan(original.width * 1.7);
  expect(await page.evaluate(() => visualViewport!.scale)).toBe(1);
  await clickTool(page, "Reading settings");
  await page.getByRole("button", { name: "Select a region", exact: true }).click();
  expect(await page.locator(".reader-host").evaluate(el => getComputedStyle(el).touchAction)).toBe("none");
  const regionTouch = await page.context().newCDPSession(page);
  await regionTouch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 100, y: 300 }] });
  for (let step = 1; step <= 5; step++) {
    await regionTouch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 100 + step * 20, y: 300 + step * 20 }] });
  }
  await regionTouch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.locator(".passage-popup")).toBeVisible();
  await regionTouch.detach();
});
