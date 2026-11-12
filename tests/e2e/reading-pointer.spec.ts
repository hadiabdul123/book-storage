import { test, expect, type Page } from "@playwright/test";
import { clickTool, openTools } from "./controls";

async function openPdf(page: Page) {
  await page.addInitScript(() => localStorage.setItem("leafmark-controls-pinned", "true"));
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles("tests/fixtures/tracemonkey.pdf");
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".pdf-page .textLayer span").first()).toBeVisible();
  await clickTool(page, "Reading settings");
}
async function setValue(page: Page, label: string, value: string) {
  await page.getByLabel(label, { exact: false }).evaluate((el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}
async function enable(page: Page) {
  await page.getByLabel("Custom pointer", { exact: true }).check();
  await page.getByLabel("Cursor trail", { exact: true }).check();
}
const overlay = (page: Page) => page.locator(".reading-pointer-overlay:not(.is-preview)");
const pointer = (page: Page) => overlay(page).locator("[data-reading-pointer]");
async function moveOnPage(page: Page) {
  const box = (await page.locator('.pdf-page[data-page="1"]').boundingBox())!;
  const x = Math.max(30, box.x + 100);
  await page.mouse.move(x, 320);
  await page.mouse.move(x + 120, 320, { steps: 12 });
}

test("reading guide settings persist across PDFs and work offline", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop");
  await openPdf(page);
  await expect(page.getByLabel("Custom pointer", { exact: true })).not.toBeChecked();
  await expect(overlay(page)).toHaveCount(0);
  await enable(page);
  for (const shape of ["arrow", "dot", "ring", "underline"]) {
    await page.getByLabel("Pointer shape", { exact: true }).selectOption(shape);
    await page.locator(".reading-pointer-preview").hover();
    await expect(page.locator(`.is-preview [data-reading-pointer=${shape}]`)).not.toHaveCSS("display", "none");
  }
  await setValue(page, "Pointer size", "48");
  await page.getByRole("slider", { name: "Pointer size", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("slider", { name: "Pointer size", exact: true })).toHaveValue("49");
  await page.keyboard.press("ArrowLeft");
  await setValue(page, "Trail thickness", "8");
  await setValue(page, "Trail length", "240");
  await setValue(page, "Trail opacity", "60");
  await setValue(page, "Trail fade duration", "600");
  await setValue(page, "Pointer and trail color", "#d14836");
  await page.getByRole("button", { name: "Close panel" }).click();
  await moveOnPage(page);
  await expect(pointer(page)).not.toHaveCSS("display", "none");
  await expect(pointer(page)).toHaveAttribute("transform", /scale\(1.5\)/);
  await page.screenshot({ path: info.outputPath("reading-pointer-page.png") });
  await page.reload();
  await clickTool(page, "Reading settings");
  await expect(page.getByLabel("Pointer shape", { exact: true })).toHaveValue("underline");
  await expect(page.getByLabel("Pointer size", { exact: false })).toHaveValue("48");
  await page.getByRole("button", { name: "Close panel" }).click();
  await page.getByRole("link", { name: "Back to library" }).click();
  await expect(overlay(page)).toHaveCount(0);
  await page.locator("input[type=file]").setInputFiles("tests/fixtures/jbig2-symbol-offset.pdf");
  await expect(page.locator(".book-card")).toHaveCount(2);
  await page.locator('.book-card').filter({ hasText: "jbig2-symbol-offset" }).locator('.book-cover-link').click();
  await clickTool(page, "Reading settings");
  await expect(page.getByLabel("Pointer shape", { exact: true })).toHaveValue("underline");
  await expect(page.getByLabel("Cursor trail", { exact: true })).toBeChecked();
  await context.setOffline(true);
  await page.getByLabel("Pointer shape", { exact: true }).selectOption("ring");
  await page.locator(".reading-pointer-preview").hover();
  await expect(page.locator('.is-preview [data-reading-pointer="ring"]')).toBeVisible();
  await page.getByRole("button", { name: "Reset reading pointer" }).click();
  await expect(page.getByLabel("Custom pointer", { exact: true })).not.toBeChecked();
  await expect(overlay(page)).toHaveCount(0);
});

test("guide fades, stays screen sized at zoom, and leaves selection and regions usable", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  await openPdf(page); await enable(page);
  await page.getByRole("button", { name: "Close panel" }).click();
  await moveOnPage(page);
  await expect(pointer(page)).not.toHaveCSS("display", "none");
  await expect(overlay(page).locator("g > g").first().locator("path").last()).toBeAttached();
  await expect(overlay(page).locator("g > g").first().locator("path")).toHaveCount(0, { timeout: 2000 });
  await expect(pointer(page)).not.toHaveCSS("display", "none");
  const transform = await pointer(page).getAttribute("transform");
  await clickTool(page, "Reading settings");
  await expect(pointer(page)).not.toBeVisible();
  await page.getByRole("combobox", { name: "Zoom", exact: true }).selectOption("1.5");
  await page.getByRole("button", { name: "Close panel" }).click();
  await moveOnPage(page);
  await expect(pointer(page)).toHaveAttribute("transform", /scale\(1\)/);
  expect(transform).toContain("scale(1)");
  await clickTool(page, "Reading settings");
  await page.getByRole("combobox", { name: "Zoom", exact: true }).selectOption("1");
  await page.getByRole("button", { name: "Close panel" }).click();
  const text = page.locator('.pdf-page .textLayer span').filter({ hasText: "Trace-based" }).first();
  await expect(text).toBeVisible();
  const box = (await text.boundingBox())!;
  await page.mouse.move(box.x + 3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(180, box.width - 3), box.y + box.height / 2, { steps: 8 });
  await expect(pointer(page)).not.toBeVisible();
  await page.mouse.up();
  await expect(page.getByRole("region", { name: "Save selected passage" })).toBeVisible();
  await page.getByRole("button", { name: "yellow highlight", exact: true }).click();
  await expect(page.locator(".pdf-highlight").first()).toBeVisible();
  await clickTool(page, "Reading settings");
  await page.getByRole("button", { name: "Select a region", exact: true }).click();
  await page.mouse.move(300, 340); await page.mouse.down();
  await page.mouse.move(420, 420, { steps: 8 }); await page.mouse.up();
  await expect(pointer(page)).not.toBeVisible();
  await expect(page.getByRole("region", { name: "Save selected passage" })).toBeVisible();
});

test("pointer and trail are independent and failed settings saves stay usable", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  await openPdf(page);
  await page.getByLabel("Cursor trail", { exact: true }).check();
  await page.getByRole("button", { name: "Close panel" }).click();
  await moveOnPage(page);
  await expect(pointer(page)).not.toBeVisible();
  await expect(page.locator(".reading-pointer-active")).toHaveCount(0);
  await expect(overlay(page).locator("g > g").first().locator("path").last()).toBeAttached();
  await clickTool(page, "Reading settings");
  await page.getByLabel("Cursor trail", { exact: true }).uncheck();
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error("storage full"); }; });
  await page.getByLabel("Custom pointer", { exact: true }).check();
  await expect(page.getByText(/Reading pointer changed, but could not be saved/)).toBeVisible();
  await page.getByRole("button", { name: "Close panel" }).click();
  await moveOnPage(page);
  await expect(pointer(page)).not.toHaveCSS("display", "none");
  await expect(overlay(page).locator("g > g").first().locator("path")).toHaveCount(0);
  await page.mouse.wheel(0, 200);
  await expect(pointer(page)).not.toBeVisible();
});

test("touch reading does not show a mouse guide even when enabled", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile-layout");
  await openPdf(page); await enable(page);
  await page.getByRole("button", { name: "Close panel" }).click();
  await page.touchscreen.tap(150, 350);
  await expect(pointer(page)).not.toBeVisible();
  await expect(page.locator(".reading-pointer-active")).toHaveCount(0);
  await openTools(page);
  await expect(page.getByRole("button", { name: "Reading settings", exact: true })).toBeVisible();
});
