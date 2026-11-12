import { test, expect } from "@playwright/test";
import path from "node:path";

test("reading mode, local zoom, and panels preserve a scrollable PDF", async ({
  page,
}, info) => {
  await page.goto("/");
  await page
    .locator("input[type=file]")
    .setInputFiles(path.resolve("tests/fixtures/tracemonkey.pdf"));
  await expect(page.locator(".book-card")).toHaveCount(1);
  await expect(page.locator(".book-sync-status")).toContainText(
    "Saved on this device",
  );
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".pdf-page .textLayer span").first()).toBeVisible();
  await page.getByRole("button", { name: "Contents", exact: true }).click();
  await page.locator(".toc-item").first().click();
  await expect(page.locator(".reader-host")).not.toHaveClass(/passage-arrived/);
  await expect(page.locator(".reader-host")).toHaveClass(/pdf-reader/);
  await page
    .locator('.pdf-page[data-page="3"]')
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect(page.locator(".reader-progress")).toContainText("Page 3");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Reset page zoom" }),
  ).toHaveText("125%");
  await page.getByRole("button", { name: "Enter reading mode" }).click();
  await expect(page.locator(".reader-header")).toBeHidden();
  await expect(page.locator(".reader-footer")).toBeHidden();
  const host = page.locator(".pdf-reader");
  const prior = await host.evaluate((el) => el.scrollTop);
  await host.evaluate((el) => {
    el.scrollTop += el.clientHeight;
  });
  await expect
    .poll(() => host.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(prior);
  await page.screenshot({
    path: `.local/reading-mode-${info.project.name}.png`,
  });
  await page.getByRole("button", { name: "Show reading controls" }).click();
  await page.getByRole("button", { name: "Page notes", exact: true }).click();
  await page.getByRole("button", { name: "Close panel" }).click();
  const afterPanel = await host.evaluate((el) => el.scrollTop);
  await host.evaluate((el) => {
    el.scrollTop += el.clientHeight;
  });
  await expect
    .poll(() => host.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(afterPanel);
  await page.reload();
  await expect(page.locator(".reader-loading")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Reset page zoom" }),
  ).toHaveText("125%");
  await expect(page.locator(".pdf-reader")).toHaveAttribute(
    "data-navigation",
    "continuous",
  );
  await page.screenshot({
    path: `.local/reading-controls-${info.project.name}.png`,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
