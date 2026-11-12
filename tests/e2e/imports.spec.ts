import { openTools, clickTool } from "./controls";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("leafmark-controls-pinned", "true"),
  );
});
test("mixed imports reject bad files, retain good files, and allow retry without duplicates", async ({
  page,
}) => {
  await page.goto("/");
  const fixture = await readFile("tests/fixtures/tracemonkey.pdf");
  await page.locator("input[type=file]").setInputFiles([
    { name: "empty.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(0) },
    {
      name: "broken.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("not a PDF"),
    },
    { name: "valid.pdf", mimeType: "application/pdf", buffer: fixture },
  ]);
  await expect(page.locator(".book-card")).toHaveCount(1, { timeout: 45_000 });
  await expect(page.getByRole("alert")).toContainText("This file is empty");
  await expect(page.getByRole("alert")).toContainText("valid PDF header");
  await page
    .locator("input[type=file]")
    .setInputFiles(path.resolve("tests/fixtures/tracemonkey.pdf"));
  await expect(page.getByRole("alert")).toContainText(
    "already in your library",
  );
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator("input[type=file]").setInputFiles({
    name: "corrupt.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7\ninvalid contents"),
  });
  await expect(page.getByRole("alert")).toContainText("damaged or incomplete");
  await expect(page.locator(".book-card")).toHaveCount(1);
});

test("JBIG2 images produce real covers and pages without decoder failures", async ({
  page,
}) => {
  const decoderErrors: string[] = [];
  page.on("console", (message) => {
    if (
      /failed to initialize|Unable to decode|wasmUrl.*provided|cover generation failed/i.test(
        message.text(),
      )
    ) {
      decoderErrors.push(message.text());
    }
  });
  await page.goto("/");
  await page
    .locator("input[type=file]")
    .setInputFiles(path.resolve("tests/fixtures/jbig2-symbol-offset.pdf"));
  await expect(page.locator(".book-card")).toHaveCount(1, { timeout: 45_000 });
  await expect(page.locator(".book-card .cover img")).toBeVisible();
  await page.locator(".book-cover-link").click();
  await openTools(page);
  await expect(page.locator(".pdf-page canvas").first()).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".pdf-page canvas")
        .first()
        .evaluate((canvas: HTMLCanvasElement) => {
          const pixels = canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          let dark = 0;
          for (let i = 0; i < pixels.length; i += 4)
            if (pixels[i + 3] && pixels[i] < 150) dark++;
          return dark;
        }),
    )
    .toBeGreaterThan(10);
  expect(decoderErrors).toEqual([]);
  await expect(page.locator(".reader-error")).toHaveCount(0);
});

test("a failed PDF thumbnail keeps the book and displays an import warning", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.toDataURL;
    let first = true;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      if (first) {
        first = false;
        throw new Error("Simulated thumbnail encoder failure");
      }
      return original.apply(this, args);
    };
  });
  await page.goto("/");
  await page
    .locator("input[type=file]")
    .setInputFiles(path.resolve("tests/fixtures/tracemonkey.pdf"));
  await expect(page.locator(".book-card")).toHaveCount(1, { timeout: 45_000 });
  await expect(
    page.getByRole("status", { name: "Import warnings" }),
  ).toContainText("cover could not be created");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.locator(".book-cover-link").click();
  await openTools(page);
  await expect(page.locator(".pdf-page .textLayer span").first()).toBeVisible();
});
