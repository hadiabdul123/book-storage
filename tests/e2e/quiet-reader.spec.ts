import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
async function open(page: Page) {
  await page.goto("/");
  await page
    .locator("input[type=file]")
    .setInputFiles(path.resolve("tests/fixtures/tracemonkey.pdf"));
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".pdf-page .textLayer span").first()).toBeVisible();
}
async function touch(page: Page, kind: "tap" | "drag" | "hold") {
  await page.locator(".reader-host").evaluate(async (el, kind) => {
    const box = el.getBoundingClientRect(),
      x = box.left + box.width / 2,
      y = box.top + box.height / 2;
    const event = (type: string, dy = 0) =>
      el.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 7,
          pointerType: "touch",
          isPrimary: true,
          bubbles: true,
          clientX: x,
          clientY: y + dy,
        }),
      );
    event("pointerdown");
    if (kind === "drag") event("pointermove", 60);
    if (kind === "hold") await new Promise((r) => setTimeout(r, 450));
    event("pointerup", kind === "drag" ? 60 : 0);
  }, kind);
}
test("quiet controls distinguish taps from scrolling and long presses without reflow", async ({
  page,
}, info) => {
  await open(page);
  await page.screenshot({
    path: `.local/quiet-reading-${info.project.name}.png`,
  });
  const header = page.locator(".reader-header"),
    host = page.locator(".reader-host");
  await expect(header).toBeHidden();
  const before = await host.boundingBox();
  await touch(page, "tap");
  await expect(header).toBeVisible();
  await page.screenshot({
    path: `.local/quiet-controls-${info.project.name}.png`,
  });
  expect(await host.boundingBox()).toEqual(before);
  await touch(page, "tap");
  await expect(header).toBeHidden();
  await touch(page, "drag");
  await page.waitForTimeout(400);
  await expect(header).toBeHidden();
  await touch(page, "hold");
  await page.waitForTimeout(400);
  await expect(header).toBeHidden();
  await page.getByRole("button", { name: "Show reading controls" }).focus();
  await page.keyboard.press("Enter");
  await expect(header).toBeVisible();
});
test("desktop hover reveals controls and leaving hides them", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  await open(page);
  await page.mouse.move(100, 8);
  await expect(page.locator(".reader-header")).toBeVisible();
  await page.mouse.move(100, 400);
  await expect(page.locator(".reader-header")).toBeHidden();
});
test("simple meanings are compact and expandable without network lookup", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "Show reading controls" }).focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("button", { name: "Reading tools" });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("button", { name: "Dictionary", exact: true }).click();
  await page.getByLabel("Dictionary word").fill("comfort");
  await page.getByRole("button", { name: "Look up", exact: true }).click();
  await expect(page.locator(".dictionary-entry")).toHaveCount(1);
  await expect(page.locator(".dictionary-entry li")).toHaveCount(1);
  await expect(page.locator(".dictionary-entry")).toContainText(
    "Simple meaning",
  );
  await page.getByRole("button", { name: "More meanings" }).click();
  expect(await page.locator(".dictionary-entry li").count()).toBeGreaterThan(1);
});

test("browser touch long press selects text without revealing reading controls", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "mobile-layout");
  await open(page);
  const r = await page
    .locator(".pdf-page .textLayer span")
    .first()
    .boundingBox();
  if (!r) throw new Error("Reader not laid out");
  const point = { x: r.x + 20, y: r.y + r.height / 2 };
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [point],
  });
  await page.waitForTimeout(750);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await page.waitForTimeout(400);
  await expect(page.locator(".reader-header")).toBeHidden();
  await expect(page.locator(".passage-popup")).toBeVisible();
  await expect(page.locator(".selection-excerpt")).not.toBeEmpty();
  await session.detach();
});
