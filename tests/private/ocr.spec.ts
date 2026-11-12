import { test, expect } from "@playwright/test";
test.use({
  viewport: { width: 412, height: 850 },
  isMobile: true,
  hasTouch: true,
});
test("private scanned PDF gains local selectable text and a persistent touch highlight", async ({
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
  await expect(target.locator(".textLayer span")).toHaveCount(0);
  await page.getByRole("button", { name: "Show reading controls" }).focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("button", { name: "Recognize text on page 20", exact: true })
    .click();
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
  await expect(page.locator(".passage-popup")).toBeVisible();
  await page
    .getByRole("button", { name: "yellow highlight", exact: true })
    .tap();
  await expect(target.locator(".pdf-highlight").first()).toBeVisible();
  await page.reload();
  await target.scrollIntoViewIfNeeded();
  await expect(target.locator(".ocr-text-layer span").first()).toBeAttached();
  await expect(target.locator(".pdf-highlight").first()).toBeVisible();
  expect(external).toEqual([]);
});
