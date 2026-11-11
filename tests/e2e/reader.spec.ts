import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import JSZip from "jszip";

async function importFile(page: Page, file: string) {
  await page.goto("/");
  await page
    .locator("input[type=file]")
    .setInputFiles(path.resolve("tests/fixtures", file));
  await expect(page.locator(".book-card")).toHaveCount(1, { timeout: 45000 });
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".reader-loading")).toHaveCount(0, {
    timeout: 45000,
  });
}
test("library starts empty without manufactured content", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "A little space for a lot of reading" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New collection" }).click();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Research");
  await page.getByRole("button", { name: "Create collection" }).click();
  await page.reload();
  await expect(page.locator("select[aria-label=Collection]")).toContainText(
    "Research",
  );
});
test("real EPUB highlight survives reload, typography changes and passage navigation", async ({
  page,
}) => {
  await importFile(page, "alice.epub");
  await page.getByRole("button", { name: "Contents", exact: true }).click();
  const chapter = page
    .locator(".toc-item")
    .filter({ hasText: /rabbit|chapter|down/i })
    .first();
  await expect(chapter).toBeVisible();
  await chapter.click();
  // Resolve the current iframe after EPUB.js replaces the cover with the chapter.
  const frame = page.frameLocator(".reader-host iframe").first();
  await expect(frame.locator("body")).toContainText("Alice was beginning");
  await frame.locator("body").evaluate((body) => {
    const paragraph = Array.from(body.querySelectorAll("p")).find(
      (p) => (p.textContent?.length || 0) > 100,
    )!;
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text && !text.textContent?.trim()) text = walker.nextNode();
    if (!text) throw new Error("Fixture paragraph contains no selectable text");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(text.textContent!.length, 60));
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(
    page.getByRole("region", { name: "Save selected passage" }),
  ).toBeVisible();
  const quote = await page.locator(".selection-excerpt").textContent();
  await page
    .getByRole("textbox", { name: "Note for selected passage" })
    .fill("A note that must survive.");
  await page.getByRole("button", { name: "blue", exact: true }).click();
  await page
    .getByRole("button", { name: "Save highlight", exact: true })
    .click();
  await page.reload();
  await expect(page.locator(".reader-loading")).toHaveCount(0, {
    timeout: 45000,
  });
  await page
    .getByRole("button", { name: "Reading settings", exact: true })
    .click();
  await page.getByLabel("Text size").focus();
  await page.getByLabel("Text size").press("End");
  await page.getByRole("button", { name: "Close panel" }).click();
  await page
    .getByRole("button", { name: "Highlights and notes", exact: true })
    .click();
  await expect(page.locator(".annotation-card blockquote")).toHaveText(quote!);
  await expect(page.getByText("A note that must survive.")).toBeVisible();
  await page.getByRole("button", { name: "Go to passage" }).click();
  await expect(page.locator(".reader-error")).toHaveCount(0);
  await page.getByRole("link", { name: "Back to library" }).click();
  await page.context().setOffline(true);
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".reader-loading")).toHaveCount(0, {
    timeout: 45000,
  });
  await expect(page.locator(".reader-error")).toHaveCount(0);
});
test("real PDF selection persists at document coordinates after zoom and rotation", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await importFile(page, "tracemonkey.pdf");
  await expect(page.locator(".pdf-page .textLayer span").first()).toBeVisible();
  await page
    .locator(".pdf-page .textLayer")
    .first()
    .evaluate((layer) => {
      const span = Array.from(layer.querySelectorAll("span")).find(
        (s) => (s.textContent?.length || 0) > 20,
      )!;
      const range = document.createRange();
      range.selectNodeContents(span);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
  await expect(
    page.getByRole("region", { name: "Save selected passage" }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Note for selected passage" })
    .fill("PDF coordinate regression");
  await page
    .getByRole("button", { name: "Save highlight", exact: true })
    .click();
  await expect(page.locator(".pdf-highlight").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Reading settings", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Zoom", exact: true })
    .selectOption("1.5");
  await page.getByRole("button", { name: "Rotate page", exact: true }).click();
  await page.getByRole("button", { name: "Close panel" }).click();
  await expect(page.locator(".pdf-highlight").first()).toBeVisible();
  await page.reload();
  await expect(page.locator(".reader-loading")).toHaveCount(0, {
    timeout: 45000,
  });
  await page
    .getByRole("button", { name: "Highlights and notes", exact: true })
    .click();
  await expect(page.getByText("PDF coordinate regression")).toBeVisible();
  await page.getByRole("button", { name: "Go to passage" }).click();
  await expect(page.locator(".pdf-highlight").first()).toBeVisible();
  await page.getByRole("link", { name: "Back to library" }).click();
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".pdf-highlight").first()).toBeVisible();
  expect(pageErrors).toEqual([]);
});
test("DOCX imports semantic text and keeps linked notes", async ({ page }) => {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>A paragraph worth remembering across every device.</w:t></w:r></w:p></w:body></w:document>',
  );
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "Reading.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: await zip.generateAsync({ type: "nodebuffer" }),
  });
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".docx-content")).toContainText(
    "worth remembering",
  );
  await page.locator(".docx-content p").evaluate((p) => {
    const range = document.createRange();
    range.selectNodeContents(p);
    const s = document.getSelection()!;
    s.removeAllRanges();
    s.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page
    .getByRole("button", { name: "Save highlight", exact: true })
    .click();
  await page.reload();
  await expect(page.locator(".docx-highlights span").first()).toBeVisible();
});
