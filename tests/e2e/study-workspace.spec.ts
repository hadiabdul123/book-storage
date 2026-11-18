import { expect, test } from "@playwright/test";
import { textPdf } from "../helpers/text-pdf";
import { showPassageAction } from "./controls";

test("manual book order supports a held drag and menu moves across reload", async ({ page }, info) => {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles(["Algebra", "Biology", "History"].map(name => ({
    name: `${name}.pdf`, mimeType: "application/pdf", buffer: textPdf([`Notes on ${name}.`]),
  })));
  await page.getByRole("button", { name: "List view" }).click();
  const headings = page.locator(".book-card h3");
  await expect(headings).toHaveText(["History", "Biology", "Algebra"]);
  if (info.project.name === "desktop") {
    await headings.last().scrollIntoViewIfNeeded();
    const source = (await page.locator(".book-card").last().boundingBox())!;
    const row = (await page.locator(".book-card").first().boundingBox())!;
    await page.mouse.move(source.x + 140, source.y + 35);
    await page.mouse.down();
    await expect(page.locator("[data-reordering]")).toBeVisible();
    await page.mouse.move(row.x + 140, row.y + 12, { steps: 6 });
    await page.mouse.up();
  } else {
    await page.getByRole("button", { name: "More actions for Algebra" }).click();
    await page.getByRole("menuitem", { name: "Move to top" }).click();
  }
  await expect(headings).toHaveText(["Algebra", "History", "Biology"]);
  await page.reload();
  await expect(page.getByLabel("Sort books")).toHaveValue("manual");
  await expect(headings).toHaveText(["Algebra", "History", "Biology"]);
  await page.getByRole("button", { name: "More actions for Algebra" }).press("Shift+F10");
  await page.getByRole("menuitem", { name: "Move to bottom" }).press("Enter");
  await expect(headings).toHaveText(["History", "Biology", "Algebra"]);
});

test("a fast PDF drag into the paragraph gap keeps the highlight on the first line", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Mouse range regression.");
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "Paragraphs.pdf", mimeType: "application/pdf",
    buffer: textPdf(["First paragraph about a river.", "Second paragraph about a forest."]),
  });
  await page.locator(".book-cover-link").click();
  const first = page.locator(".textLayer span").filter({ hasText: /First paragraph/ }).first();
  const second = page.locator(".textLayer span").filter({ hasText: /Second paragraph/ }).first();
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  const a = (await first.boundingBox())!, b = (await second.boundingBox())!;
  await page.mouse.move(a.x + 1, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width - 4, a.y + a.height / 2);
  await page.mouse.move(b.x + b.width / 2, (a.y + a.height + b.y) / 2);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).not.toContain("Second");
  await showPassageAction(page, "yellow highlight");
  await page.getByRole("button", { name: "yellow highlight", exact: true }).click();
  const quote = await page.evaluate(async () => (await (await import("/src/db.ts")).list("annotation"))[0]?.text);
  expect(quote).toContain("First paragraph");
  expect(quote).not.toContain("Second paragraph");

  await page.mouse.move(a.x + 3, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 4, b.y + b.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toContain("Second paragraph");
});
