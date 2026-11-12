import { test, expect } from "@playwright/test";
for (const phone of [false, true]) test.describe(phone ? "phone" : "desktop", () => {
test.use({
  viewport: phone ? { width: 412, height: 850 } : { width: 1440, height: 1000 },
  isMobile: phone,
  hasTouch: phone,
});

test("private scanned PDF gains automatic text selection and a persistent highlight", async ({
  page,
}) => {
  test.setTimeout(180000);
  const file = process.env.LEAFMARK_TEST_PDF;
  test.skip(!file, "Private file supplied only through the environment");
  const external: string[] = [];
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).hostname !== "127.0.0.1") {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles(file!);
  await expect(page.locator(".book-card")).toHaveCount(1, { timeout: 45000 });
  await page.locator(".book-cover-link").click();
  const target = page.locator('.pdf-page[data-page="20"]');
  await target.scrollIntoViewIfNeeded();
  await expect(target.locator(".textLayer")).toBeAttached();
  // Visible scanned pages are recognized without pressing an enable button.
  await expect(target.locator(".ocr-text-layer span").first()).toBeVisible({
    timeout: 90000,
  });
  expect(await target.locator(".ocr-text-layer span").count()).toBeGreaterThan(
    50,
  );
  // Choose an interior word, then let the touch fallback create the range.
  const word = target.locator(".ocr-text-layer span").nth(25);
  await word.scrollIntoViewIfNeeded();
  const r = await word.boundingBox();
  if (phone) {
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: r!.x + r!.width / 2, y: r!.y + r!.height / 2 }],
  });
  await page.waitForTimeout(750);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
    await session.detach();
  } else {
    await page.mouse.move(r!.x + 1, r!.y + r!.height / 2);
    await page.mouse.down();
    await page.mouse.move(r!.x + r!.width - 1, r!.y + r!.height / 2, { steps: 10 });
    await page.mouse.up();
  }
  await expect(page.locator(".passage-popup")).toBeVisible();
  const highlight = page.getByRole("button", { name: "yellow highlight", exact: true });
  if (phone) await highlight.tap();
  else await highlight.click();
  await expect(target.locator(".pdf-highlight").first()).toBeVisible();
  // The completed page must remain selectable even when the recognition
  // engine cannot load again. Other unfinished pages may resume separately.
  await page.route("**/ocr/**", route => route.abort());
  await page.reload();
  await target.scrollIntoViewIfNeeded();
  await expect(target.locator(".ocr-text-layer span").first()).toBeAttached();
  await expect(target.locator(".pdf-highlight").first()).toBeVisible();
  await expect(target.locator(".pdf-ocr-button")).toBeHidden();
  expect(external).toEqual([]);
});

});
