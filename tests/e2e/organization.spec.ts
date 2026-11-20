import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { textPdf } from "../helpers/text-pdf";
import { clickTool } from "./controls";
test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem("leafmark-controls-pinned", "true")); });
async function openBook(page: import("@playwright/test").Page) {
  await page.goto("/"); await page.locator("input[type=file]").setInputFiles({ name: "Stable reading.pdf", mimeType: "application/pdf", buffer: textPdf(["Reading stays comfortable.", "Keep the final settings."]) });
  await expect(page.locator(".book-card")).toHaveCount(1); await page.locator(".book-cover-link").click();
  await expect(page.locator(".reader-shell")).toHaveAttribute("data-loading", "false");
}
test("mixed zoom and settings settle at the latest view under Android CPU pressure", async ({ page, browserName }) => {
  await openBook(page); const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const cdp = browserName === "chromium" ? await page.context().newCDPSession(page) : undefined;
  await cdp?.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await clickTool(page, "Reading settings");
  await page.getByRole("combobox", { name: "Pages across", exact: true }).selectOption("2");
  await page.getByRole("combobox", { name: "Fit", exact: true }).selectOption("page");
  await page.getByRole("combobox", { name: "Navigation", exact: true }).selectOption("paginated");
  for (const value of ["2", "1.25", "2.5", "1.5"]) {
    await page.getByRole("combobox", { name: "Zoom", exact: true }).selectOption(value);
    await page.getByRole("button", { name: value === "2.5" ? "Dark" : "Warm paper", exact: true }).click();
  }
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(page.locator(".reader-host")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".reader-host")).not.toHaveClass(/pdf-zooming/);
  await expect(page.locator(".pdf-zoom-preview")).toHaveCount(0);
  await expect(page.locator(".reader-host")).toHaveAttribute("data-columns", "2");
  await cdp?.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await page.reload(); await clickTool(page, "Reading settings");
  await expect(page.getByRole("combobox", { name: "Zoom", exact: true })).toHaveValue("1.5");
  await expect(page.getByRole("combobox", { name: "Fit", exact: true })).toHaveValue("page");
  await expect(page.getByRole("combobox", { name: "Pages across", exact: true })).toHaveValue("2");
  expect(errors).toEqual([]);
});
test("large libraries use source IDs, bounded lists, complete exports and research history", async ({ page }) => {
  // Creating 5,502 IndexedDB fixture records is slow on Windows WebKit.
  // Interactive assertions below retain their normal per-action timeouts.
  test.setTimeout(150_000);
  await openBook(page);
  // Populate an isolated, inactive library atomically; removing the current
  // book while its reader is saving can race WebKit's database cleanup.
  await page.goto("/#/notes"); await expect(page.getByRole("heading", { name: "Highlights & notes" })).toBeVisible();
  await page.evaluate(async () => {
    const { db } = await import("/src/db.ts"), { defaultSectionId } = await import("/src/notebookSections.ts");
    const original = (await db.rows.where("kind").equals("book").first())!.value as any;
    const timestamp = new Date().toISOString(), rows: any[] = [];
    const row = (kind: string, value: any) => rows.push({ key: `${kind}:${value.id}`, kind, id: value.id, value, revision: 0, deleted: false });
    for (let b = 0; b < 100; b++) {
      row("book", { ...original, id: `book${b}`, title: b < 2 ? "Shared title" : `Book ${b}`, author: `Author ${b}` });
      for (let i = 0; i < 50; i++) row("annotation", { id: `a${b}-${i}`, bookId: `book${b}`, locator: { v: 1, type: "pdf", hash: original.hash, page: 1, y: 0 }, text: `Passage ${i} in book ${b}.`, note: "A useful idea", tags: ["study"], color: "yellow", createdAt: timestamp });
      row("research-thread", { id: `thread${b}`, title: `Question ${b}`, bookId: `book${b}`, createdAt: timestamp });
      row("research-message", { id: `message${b}`, threadId: `thread${b}`, question: `Question ${b}`, answer: `Saved answer ${b}`, model: "test", sources: [], mode: "web", createdAt: timestamp });
    }
    row("notebook", { id: "notebook", title: "Study pages", createdAt: timestamp });
    const section = defaultSectionId("notebook"); row("notebook-section", { id: section, notebookId: "notebook", title: "Notes", order: 0, createdAt: timestamp });
    for (let i = 0; i < 200; i++) row("notebook-note", { id: `note${i}`, notebookId: "notebook", sectionId: section, title: `Study page ${i}`, order: i, document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `Important idea ${i}` }] }] }, tags: [], createdAt: timestamp, updatedAt: timestamp });
    await db.transaction("rw", db.rows, async () => {
      await db.rows.clear();
      for (let i = 0; i < rows.length; i += 250) await db.rows.bulkPut(rows.slice(i, i + 250));
    });
  });
  await page.goto("/#/"); await expect(page.locator(".book-card")).toHaveCount(50);
  await expect(page.getByRole("navigation", { name: "Books pagination" })).toContainText("100");
  await page.getByRole("button", { name: "Next books page" }).click(); await expect(page).toHaveURL(/page=2/);
  await page.goto("/#/notes"); await expect(page.locator(".notes-passage-open")).toHaveCount(50);
  await expect(page.locator(".annotation-card")).toHaveCount(1);
  const download = page.waitForEvent("download"); await page.getByLabel("Export notes", { exact: true }).selectOption("json");
  const backup = JSON.parse(await readFile((await (await download).path())!, "utf8")); expect(backup.annotations).toHaveLength(5000);
  if (await page.getByRole("button", {name:"Filters & collections", expanded:false}).isVisible()) await page.getByRole("button", {name:"Filters & collections"}).click();
  await page.getByRole("navigation", { name: "Books & notebooks", exact: true }).getByRole("button").filter({ has: page.getByText("Author 0", { exact: true }) }).click();
  await expect(page).toHaveURL(/book=book0/); await page.locator(".notes-passage-open").first().click();
  await expect(page.getByRole("dialog", { name: "Quote card" })).toContainText("in book 0");
  await page.reload(); await expect(page.locator(".annotation-card")).toContainText("in book 0");
  await page.goto("/#/notebooks");
  const noteRows = page.getByRole("complementary", { name: "Notebook pages" }).locator("nav .workspace-item > button:first-child");
  await expect(noteRows).toHaveCount(50);
  await noteRows.first().click();
  await expect(page.getByLabel("Topic note content")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("notebook-workspace.png"), fullPage: true });
  await page.getByRole("button", { name: "Pages", exact: true }).click();
  await page.getByRole("tab", { name: "Research", exact: true }).click();
  const studyRows = page.getByRole("navigation", { name: "Saved studies" }).locator(".workspace-item > button:first-child");
  await expect(studyRows).toHaveCount(50);
  await page.getByLabel("Search studies").fill("Question 99");
  await expect(studyRows).toHaveCount(1);
  await studyRows.click();
  await expect(page.locator(".research-answer")).toContainText("Saved answer 99");
  expect((await page.locator(".research-conversation").boundingBox())!.height).toBeGreaterThan(150);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("research-workspace.png"), fullPage: true });
});
