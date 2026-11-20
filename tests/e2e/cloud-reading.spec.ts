import { openTools, clickTool } from "./controls";
import { test, expect } from "@playwright/test";
import path from "node:path";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("leafmark-controls-pinned", "true"),
  );
});
test("reading mode, local zoom, and panels preserve a scrollable PDF", async ({
  page,
}, info) => {
  await page.goto("/");
  await page
    .locator("input[type=file]")
    .setInputFiles(path.resolve("tests/fixtures/tracemonkey.pdf"));
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.getByRole("button", { name: /^Details for/ }).click();
  await expect(page.locator(".book-sync-status")).toContainText(
    "Saved on this device",
  );
  await page.getByRole("dialog", { name: "Book details" }).getByRole("button", { name: "Close", exact: true }).click();
  await page.locator(".book-cover-link").click();
  await openTools(page);
  await expect(page.locator(".pdf-page .textLayer span").first()).toBeVisible();
  await clickTool(page, "Contents");
  const contents = page.getByRole("navigation", { name: "Book contents" });
  await contents.getByLabel("Go to page").fill("1");
  await contents.getByRole("button", { name: "Go", exact: true }).click();
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
  await expect(page.getByRole("button", { name: "Enter reading mode" })).toHaveCount(0);
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
  await openTools(page);
  await clickTool(page, "Page notes");
  await page.getByRole("button", { name: "Close panel" }).click();
  const afterPanel = await host.evaluate((el) => el.scrollTop);
  await host.evaluate((el) => {
    el.scrollTop += el.clientHeight;
  });
  await expect
    .poll(() => host.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(afterPanel);
  await page.reload();
  await openTools(page);
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
