import { test, expect } from "@playwright/test";

test("private PDF imports and renders representative pages without image failures", async ({ page }, testInfo) => {
  const file = process.env.LEAFMARK_TEST_PDF;
  test.skip(!file, "Set LEAFMARK_TEST_PDF to a private local PDF; never commit the book.");
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    if (/Unable to decode|failed to initialize|Internal error|cover generation failed/i.test(message.text())) failures.push(message.text());
  });
  // Keep private fixtures entirely local even if cloud settings exist on this PC.
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles(file!);
  await expect(page.locator(".book-card")).toHaveCount(1, { timeout: 45_000 });
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".pdf-page canvas").first()).toBeVisible();
  const count = await page.locator(".pdf-page").count();
  expect(count).toBeGreaterThan(1);
  for (const number of [1, 2, Math.ceil(count / 2), count]) {
    await page.locator(`.pdf-page[data-page="${number}"]`).scrollIntoViewIfNeeded();
    const canvas = page.locator(`.pdf-page[data-page="${number}"] canvas`);
    await expect(canvas).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
      const pixels = element.getContext("2d")!.getImageData(0, 0, element.width, element.height).data;
      let dark = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] && pixels[i] < 150) dark++;
      return dark;
    })).toBeGreaterThan(20);
    await canvas.screenshot({ path: testInfo.outputPath(`page-${number}.png`) });
  }
  expect(failures).toEqual([]);
  await expect(page.locator(".reader-error")).toHaveCount(0);
});
