import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { numberedPdf } from "../helpers/numbered-pdf";
import { clickTool } from "./controls";

const bytes = numberedPdf(3);
const note = "Margin note.\nSecond line α.";

async function openPdf(page: Page) {
  await page.addInitScript(() => localStorage.setItem("leafmark-controls-pinned", "true"));
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "Text box example.pdf", mimeType: "application/pdf", buffer: bytes,
  });
  await page.locator(".book-cover-link").click();
  await expect(page.locator('.pdf-page[data-page="1"] .textLayer')).toBeVisible();
}

test("PDF text box stays on its page through editing, zoom, rotation and a spread", async ({ page, context }, info) => {
  await openPdf(page);
  const paper = page.locator('.pdf-page[data-page="1"]');
  const box = paper.locator(".pdf-text-box");
  await context.setOffline(true);
  await clickTool(page, "Text box");
  const bounds = (await paper.boundingBox())!;
  await paper.click({ position: { x: bounds.width * 0.2, y: Math.min(bounds.height * 0.35, 280) } });
  const editor = page.getByRole("textbox", { name: "Text box on page 1" });
  await editor.fill(note);
  const draft = paper.locator(".pdf-text-box-edit");
  const beforeMove = await draft.evaluate(el => el.style.transform);
  await page.getByRole("button", { name: "Move text box", exact: true }).press("ArrowRight");
  await expect.poll(() => draft.evaluate(el => el.style.transform)).not.toBe(beforeMove);
  await page.getByRole("button", { name: "Resize text box", exact: true }).press("ArrowDown");
  await expect(draft).toHaveCSS("height", "86px");
  if (info.project.name === "desktop") {
    const grip = page.getByRole("button", { name: "Resize text box", exact: true });
    await grip.scrollIntoViewIfNeeded();
    const target = (await grip.boundingBox())!;
    const x = target.x + target.width / 2, y = target.y + target.height / 2;
    const width = await draft.evaluate(el => Number.parseFloat(el.style.width));
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 25, y + 18, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => draft.evaluate(el => Number.parseFloat(el.style.width))).toBeGreaterThan(width);
  }
  await expect(page.getByRole("combobox", { name: "Background", exact: true })).toHaveValue("transparent");
  await page.getByRole("combobox", { name: "Text size", exact: true }).selectOption("14");
  await page.getByRole("combobox", { name: "Weight", exact: true }).selectOption("light");
  await expect(editor).toHaveCSS("font-weight", "300");
  await page.getByRole("combobox", { name: "Weight", exact: true }).selectOption("bold");
  await page.getByRole("button", { name: "Underline", exact: true }).click();
  await page.getByRole("button", { name: "Save text box", exact: true }).click();
  await expect(box).toContainText("Second line α.");
  await context.setOffline(false);
  await page.reload();
  await expect(box).toContainText("Margin note.");

  await expect(box).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(box).toHaveCSS("font-weight", "700");
  await expect(box).toHaveCSS("font-size", "14px");
  await expect(box).toHaveCSS("text-decoration-line", "underline");
  const before = await box.evaluate(el => el.style.transform);
  const zoom = page.getByRole("button", { name: "Zoom in", exact: true });
  await zoom.click();
  await expect.poll(() => box.evaluate(el => el.style.transform)).not.toBe(before);
  await clickTool(page, "Reading settings");
  await page.getByRole("button", { name: "Rotate page", exact: true }).click();
  await expect(paper).toHaveAttribute("data-pdf-rotation", "90");
  await page.getByRole("combobox", { name: "Pages across", exact: true }).selectOption("2");
  await page.getByRole("combobox", { name: "Navigation", exact: true }).selectOption("paginated");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(page.locator(".reader-host")).toHaveAttribute("data-columns", "2");
  await expect(page.locator(".reader-host")).not.toHaveAttribute("aria-busy", "true");
  await expect(box).toContainText("Margin note.");
  await expect(page.locator('.pdf-page[data-page="2"] .pdf-text-box')).toHaveCount(0);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(box).toBeHidden();
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  await expect(box).toBeVisible();

  await clickTool(page, "Reading mode");
  await expect(page.locator(".reader-header")).toBeHidden();
  await expect(box).toBeVisible();
  await clickTool(page, "Text box");
  await box.click();
  await expect(editor).toHaveValue(note);
  await editor.fill("Edited margin note.");
  await page.getByRole("button", { name: "Save text box", exact: true }).click();
  await expect(box).toHaveText("Edited margin note.");
  await page.screenshot({ path: info.outputPath("pdf-text-box.png") });
  await clickTool(page, "Text box");
  await box.click();
  await page.getByRole("button", { name: "Delete text box", exact: true }).click();
  await expect(box).toHaveCount(0);
});

test("marked PDF includes the text box and ink on their original page", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The export rendering is independent of viewport size.");
  await openPdf(page);
  await clickTool(page, "Text box");
  await page.getByRole("button", { name: "Place on current page", exact: true }).click();
  await page.getByRole("textbox", { name: "Text box on page 1" }).fill(note);
  await page.getByRole("combobox", { name: "Background", exact: true }).selectOption("tint");
  await page.getByRole("button", { name: "Save text box", exact: true }).click();
  await expect(page.locator(".pdf-text-box")).toContainText("Second line α.");
  const geometry = await page.evaluate(async () => {
    const { list, save } = await import("/src/db.ts");
    const [book] = await list("book"), [box] = await list("pdf-text-box");
    await save("ink-stroke", { id: "example-stroke", target: { type: "pdf", bookId: book.id, hash: book.hash, page: 1 },
      tool: "pen", color: "#FF0022", width: 12, points: [[45, 450, 0.5], [130, 450, 0.5]], createdAt: new Date().toISOString() });
    return box;
  });
  await expect(page.locator(".pdf-ink-layer path")).toHaveCount(1);
  await clickTool(page, "Text box");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export marked PDF", exact: true }).click();
  const download = await downloadPromise;
  const path = info.outputPath("text-box-marked.pdf");
  await download.saveAs(path);
  const pixels = await page.evaluate(async ({ bytes, box }) => {
    const { pdfLibrary, pdfOptions } = await import("/src/pdf.ts");
    const { boxPoint } = await import("/src/pdfTextBoxes.ts");
    const library = await pdfLibrary();
    const task = library.getDocument(pdfOptions(Uint8Array.from(bytes).buffer));
    const file = await task.promise;
    try {
      const original = await file.getPage(1);
      const viewport = original.getViewport({ scale: 1 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width; canvas.height = viewport.height;
      await original.render({ canvas, viewport }).promise;
      const context = canvas.getContext("2d")!;
      const [x, y] = viewport.convertToViewportPoint(...boxPoint(box, box.width - 4, box.height - 4));
      const fill = [...context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data];
      const [left, top] = viewport.convertToViewportPoint(box.x, box.y);
      const hasText = (line: number) => {
        const row = context.getImageData(Math.floor(left) + 6, Math.floor(top) + 7 + line * 21, Math.floor(box.width) - 12, 20).data;
        return row.some((channel, i) => i % 4 === 0 && channel < 100 && row[i + 1] < 100 && row[i + 2] < 100);
      };
      const ink = context.getImageData(40, 140, 100, 20).data;
      const red = ink.some((channel, i) => i % 4 === 0 && channel > 210 && ink[i + 1] < 60);
      return { fill, red, text: [hasText(0), hasText(1)], pages: file.numPages };
    } finally { await task.destroy(); }
  }, { bytes: [...await readFile(path)], box: geometry });
  expect(pixels).toEqual({ fill: [255, 240, 183, 255], red: true, text: [true, true], pages: 3 });
  expect(await page.evaluate(async () => {
    const { db, list } = await import("/src/db.ts");
    const [book] = await list("book");
    const source = (await db.files.get(book.id))!.source;
    return [...new Uint8Array(await source.arrayBuffer())];
  })).toEqual([...bytes]);
});
