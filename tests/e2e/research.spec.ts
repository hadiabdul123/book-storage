import { test, expect, type Page } from "@playwright/test";
import { textPdf } from "../helpers/text-pdf";
import { PDFDocument } from "pdf-lib";
import { clickTool, showPassageAction } from "./controls";
import JSZip from "jszip";
import path from "node:path";
async function open(page: Page) {
  await page.addInitScript(() => localStorage.setItem("leafmark-controls-pinned", "true"));
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({ name: "research-universe.pdf", mimeType: "application/pdf", buffer: textPdf(["Big Bang theory", "The universe is expanding."]) });
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".textLayer span").filter({ hasText: /^Big Bang theory$/ })).toBeVisible();
}
async function select(page: Page) {
  await page.locator(".textLayer span").filter({ hasText: /^Big Bang theory$/ }).evaluate(el => {
    const r = document.createRange(); r.selectNodeContents(el); const s = document.getSelection()!; s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event("selectionchange"));
  });
  await showPassageAction(page, "Research");
  await page.getByRole("button", { name: "Research", exact: true }).click();
  await expect(page.getByRole("region", { name: "Research workspace" })).toBeVisible();
}
async function completeSavedJob(page: Page) {
  await expect(page.locator(".research-pending")).toContainText("Connect your private Supabase");
  await page.evaluate(async () => {
    const { db } = await import("/src/db.ts"); const { runResearchQueue } = await import("/src/research.ts");
    const jobs = await db.researchJobs.toArray(); const j = jobs.find(j => j.state === "paused")!;
    await db.researchJobs.update(j.id, { state: "queued" });
    await runResearchQueue(async () => ({ answer: "The Big Bang describes expansion from a hot, dense early universe [S1].\n\nIt does not describe an explosion into empty space [S1].", model: "test-provider", sources: [{ id: "S1", kind: "web", title: "NASA cosmology", excerpt: "Evidence for a hot early universe.", url: "https://science.nasa.gov/universe/", retrievedAt: new Date().toISOString() }] }));
  });
}
test("research keeps follow-up and retry controls reachable in a compact dark panel", async ({ page }, info) => {
  await open(page); await select(page);
  await page.evaluate(async () => {
    const { save } = await import("/src/db.ts"); const { defaults } = await import("/src/model.ts");
    await save("preferences", { ...defaults, theme: "dark" });
  });
  if (info.project.name === "mobile-layout") await page.setViewportSize({ width: 360, height: 640 });
  await page.getByRole("button", { name: "Research", exact: true }).click();
  await expect(page.locator(".research-pending")).toContainText("Connect your private Supabase");
  const panel = page.getByRole("region", { name: "Research workspace" });
  await expect(panel.getByRole("button", { name: "Expand selected passage" })).toHaveAttribute("aria-expanded", "false");
  await panel.getByRole("button", { name: "Expand selected passage" }).click();
  await expect(panel.getByRole("button", { name: "Collect passage" })).toBeVisible();
  await panel.getByRole("button", { name: "Collapse selected passage" }).click();
  const input = page.getByRole("textbox", { name: "Research question" });
  await input.fill("Can you give me an everyday example?");
  expect(await page.locator(".research-send").evaluate(el => {
    const r = el.getBoundingClientRect();
    return r.bottom <= innerHeight && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  })).toBe(true);
  expect(await page.locator(".research-conversation").evaluate(el => el.clientHeight)).toBeGreaterThan(150);
  await page.getByText("Options", { exact: true }).click();
  await page.getByRole("checkbox", { name: "Refresh instead of using a saved answer" }).check();
  await page.getByText("Options", { exact: true }).click();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator(".research-pending")).toContainText("Connect your private Supabase");
  await page.getByRole("button", { name: "Cancel request", exact: true }).click();
  await expect(page.locator(".research-pending")).toHaveCount(0);
  await expect(input).toHaveValue("Can you give me an everyday example?");
  const tab = page.getByRole("tab", { name: "Explain", exact: true });
  await tab.focus(); await tab.press("End");
  await expect(page.getByRole("tab", { name: "Web", exact: true })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Web search query" })).toBeVisible();
});

test("selection research saves a partial cited answer into a chosen PDF page and topic notebook", async ({ page }, info) => {
  await open(page); await select(page);
  await expect(page.locator(".research-passage")).toContainText("Big Bang theory");
  await page.getByRole("tab", { name: "Web", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Web search query" })).toHaveValue("Big Bang theory");
  await page.getByRole("button", { name: "Research", exact: true }).click(); await completeSavedJob(page);
  await expect(page.locator(".research-answer")).toContainText("hot, dense");
  await page.locator(".research-answer-text").evaluate(el => {
    const r = document.createRange(); r.selectNodeContents(el.querySelector("p")!); const s = document.getSelection()!; s.removeAllRanges(); s.addRange(r); el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Save selected excerpt…" }).click();
  await page.getByLabel("Save destination").selectOption("page");
  await page.getByRole("button", { name: "Save excerpt", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Excerpt and sources saved"); await page.getByRole("button", { name: "Done", exact: true }).click();
  expect(await page.evaluate(async () => {
    const { list } = await import("/src/db.ts"); const a = (await list("annotation"))[0]; return { text: a.note, nodes: a.content?.document.content?.map(n => n.type) };
  })).toMatchObject({ text: expect.stringContaining("hot, dense"), nodes: expect.arrayContaining(["citation"]) });
  await page.getByRole("button", { name: "Save answer…" }).click();
  await page.getByLabel("Save destination").selectOption("new");
  await page.getByLabel("Notebook name").fill("Science"); await page.getByLabel("Note title").fill("Universe research");
  await page.getByRole("button", { name: "Save excerpt", exact: true }).click(); await expect(page.getByRole("dialog")).toContainText("Excerpt and sources saved"); await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.screenshot({ path: `.local/research-${info.project.name}.png` });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth); expect(overflow).toBe(false);
  await page.goto("/#/notebooks"); await page.locator(".notebook-pages .workspace-item > button:first-child").filter({ hasText: "Universe research" }).click();
  await expect(page.getByRole("textbox", { name: "Topic note content" })).toContainText("hot, dense");
  await expect(page.getByRole("link", { name: /NASA cosmology/ }).first()).toHaveAttribute("href", "https://science.nasa.gov/universe/");
});
test("topic writing autosaves and remains editable after reload, with valid JSON export and trash recovery", async ({ page }) => {
  await page.goto("/#/notebooks"); await page.getByRole("button", { name: "New notebook", exact: true }).click();
  await page.getByLabel("Notebook name").fill("My ideas"); await page.getByRole("button", { name: "Create notebook", exact: true }).click();
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await page.getByRole("textbox", { name: "Topic note title" }).fill("Questions about the universe");
  await page.getByRole("textbox", { name: "Topic note content" }).fill("A thought that should survive a restart.");
  await page.getByRole("button", { name: "Save now", exact: true }).click(); await expect(page.locator(".topic-save-status")).toContainText("Saved on this device");
  await page.reload(); await expect(page.getByRole("textbox", { name: "Topic note content" })).toContainText("survive a restart");
  const downloaded = page.waitForEvent("download"); await page.getByLabel("Export notebooks").selectOption("json");
  const download = await downloaded; expect(download.suggestedFilename()).toMatch(/leafmark-research.*json/);
  page.once("dialog", d => d.accept()); await page.getByRole("button", { name: "Trash note", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Topic note content" })).toHaveCount(0);
  await page.goto("/#/settings"); const row = page.locator(".trash-row").filter({ hasText: "Questions about the universe" }); await row.getByRole("button", { name: "Restore" }).click();
  await page.goto("/#/notebooks"); await page.locator(".notebook-pages .workspace-item > button:first-child").filter({ hasText: "Questions about the universe" }).click(); await expect(page.getByRole("textbox", { name: "Topic note content" })).toContainText("survive a restart");
});
test("chosen-source research indexes text locally and offline questions preserve their passage", async ({ page, context }) => {
  await open(page); await select(page);
  await page.getByRole("tab", { name: "My sources", exact: true }).click();
  await page.getByRole("textbox", { name: "Research question" }).fill("What does this book say about the universe?");
  await page.getByRole("button", { name: "Research", exact: true }).click();
  await expect(page.locator(".research-pending")).toBeVisible();
  expect(await page.evaluate(async () => (await (await import("/src/db.ts")).db.chunks.toArray()).some(c => c.text.includes("universe")))).toBe(true);
  await context.setOffline(true);
  await page.getByRole("textbox", { name: "Research question" }).fill("How does expansion connect to this passage?");
  await page.getByRole("button", { name: "Save question for later" }).click();
  await expect.poll(() => page.evaluate(async () => (await (await import("/src/db.ts")).db.researchJobs.toArray()).filter(j => j.state === "queued").length)).toBe(1);
  await page.screenshot({ path: `.local/research-offline-${test.info().project.name}.png` });
});

test("book study queues separate cited reviews and compares evidence from every selected book", async ({ page }) => {
  const alpha = await PDFDocument.create();
  for (const text of ["River ecology depends on biodiversity.", "River restoration adds habitat."])
    alpha.addPage([500, 650]).drawText(text, { x: 40, y: 580, size: 20 });
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles([
    { name: "Study Alpha.pdf", mimeType: "application/pdf", buffer: Buffer.from(await alpha.save()) },
    { name: "Study Beta.pdf", mimeType: "application/pdf", buffer: textPdf(["River restoration also needs community support."]) },
  ]);
  await expect(page.getByRole("heading", { name: "Study Alpha", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Study Beta", exact: true })).toBeVisible();
  await page.goto("/#/notebooks?view=research");
  await page.getByRole("button", { name: "Start a study", exact: true }).click();
  await page.getByRole("checkbox", { name: "Study Alpha", exact: true }).check();
  await page.getByRole("checkbox", { name: "Study Beta", exact: true }).check();
  await page.getByRole("button", { name: "Start study", exact: true }).click();
  await page.getByRole("button", { name: "Review chapters" }).click();
  await expect(page.getByRole("dialog")).toContainText("Pages 1–2");
  await page.getByRole("button", { name: "Review 2 sections" }).click();
  await expect(page.getByRole("dialog")).toContainText("2 sections queued");
  await page.getByRole("button", { name: "Back to study", exact: true }).click();
  await page.context().setOffline(true);
  await page.getByLabel("Research question").fill("restoration");
  await page.getByRole("button", { name: "Find passages", exact: true }).click();
  await expect(page.locator(".study-passages")).toContainText("community support");
  await page.getByRole("button", { name: "Compare sources", exact: true }).click();
  await page.getByLabel("Comparison question").fill("How do these books compare river restoration?");
  await page.getByRole("button", { name: "Start comparison", exact: true }).click();
  await expect.poll(async () => page.evaluate(async () => {
    const { db } = await import("/src/db.ts");
    const jobs = await db.researchJobs.toArray();
    return { reviews: jobs.filter(job => job.request.question.startsWith("Review ")).length,
      books: jobs.find(job => job.request.comparison)?.request.comparison?.books.length };
  })).toEqual({ reviews: 2, books: 2 });
  await page.evaluate(async () => {
    const { db, list, save } = await import("/src/db.ts");
    const pending = (await db.researchJobs.toArray()).find(job => job.request.comparison)!;
    const books = await list("book");
    const sources = pending.request.comparison!.books.map((item, index) => ({
      id: `S${index + 1}`, kind: "book" as const, bookId: item.bookId, title: item.title,
      excerpt: "A supporting passage about river restoration.",
      locator: { v: 1 as const, type: "pdf" as const, page: 1, y: .1, hash: books.find(book => book.id === item.bookId)!.hash },
    }));
    await save("research-message", {
      id: pending.id, threadId: pending.threadId, question: pending.request.question, mode: "sources",
      answer: "Both discuss river restoration. [S1] [S2]", sources, model: "test", createdAt: new Date().toISOString(),
      comparison: {
        columns: pending.request.comparison!.books.map((item, index) => ({
          ...item, answer: item.title === "Study Alpha" ? "Habitat matters." : "Community support matters.", gap: "", sourceIds: [sources[index].id],
        })),
        synthesis: { text: "They emphasize different parts of restoration.", sourceIds: sources.map(source => source.id) },
      },
    });
    await db.researchJobs.update(pending.id, { state: "done" });
  });
  const comparison = page.getByRole("article", { name: "Book comparison" });
  await expect(comparison.getByRole("region", { name: "Study Alpha" })).toContainText("Habitat matters");
  await expect(comparison.getByRole("region", { name: "Study Beta" })).toContainText("Community support matters");
  await comparison.getByRole("region", { name: "Study Beta" }).getByRole("button", { name: "Evidence on page 1" }).click();
  const evidence = page.getByRole("complementary", { name: "Supporting evidence" });
  await expect(evidence.getByRole("link")).toContainText("Study Beta");
  await expect(evidence.getByRole("link")).toHaveAttribute("href", /#\/read\/.+\?source=/);
  await page.screenshot({ path: test.info().outputPath("study-evidence.png"), fullPage: true });
  await comparison.getByRole("button", { name: "Save finding" }).first().click();
  await expect(page.getByRole("dialog")).toContainText("1 source reference");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Sources (2)", exact: true }).click();
  await page.getByRole("checkbox", { name: "Study Alpha", exact: true }).uncheck();
  await page.getByRole("button", { name: "Save sources", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Study sources" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sources (1)", exact: true })).toBeVisible();
  await page.getByLabel("Research question").fill("What supports the ecosystem?");
  await page.getByRole("button", { name: "Queue question", exact: true }).click();
  await expect(page.locator(".research-pending")).toContainText("What supports the ecosystem?");
  const queued = await page.evaluate(async () => {
    const { db } = await import("/src/db.ts");
    const job = (await db.researchJobs.toArray()).find(job => job.request.question === "What supports the ecosystem?")!;
    return { titles: [...new Set(job.request.sources.map(source => source.title))], history: job.request.history };
  });
  expect(queued).toEqual({ titles: ["Study Beta"], history: [] });
  await page.context().setOffline(false);
  await page.reload();
  await expect(page.getByRole("button", { name: "Sources (1)", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Study results", exact: true }).selectOption({ label: "Comparison · How do these books compare river restoration?" });
  await expect(comparison.getByRole("region", { name: "Study Alpha" })).toContainText("Habitat matters");
  await page.context().setOffline(true);
  await page.getByRole("button", { name: "Ask a follow-up", exact: true }).click();
  await page.getByLabel("Research question").fill("What is the strongest support?");
  await page.getByRole("button", { name: "Queue question", exact: true }).click();
  await expect(page.locator(".research-pending")).toContainText("What is the strongest support?");
  expect(await page.evaluate(async () => {
    const { db } = await import("/src/db.ts");
    const job = (await db.researchJobs.toArray()).find(job => job.request.question === "What is the strongest support?")!;
    return job.request.history.map(item => item.question);
  })).toEqual(["How do these books compare river restoration?"]);
  await page.getByRole("button", { name: "All studies", exact: true }).click();
  await page.getByRole("button", { name: "Search library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Search library" });
  await library.getByLabel("Search prepared book text").fill("community");
  await library.getByRole("button", { name: "Search", exact: true }).click();
  await expect(library.getByText("River restoration also needs community support.", { exact: true })).toBeVisible();
});

for (const format of ["epub", "docx"] as const) test(`${format} contextual research retains a navigable source and locally indexes its text`, async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("leafmark-controls-pinned", "true"));
  await page.goto("/");
  if (format === "epub") await page.locator("input[type=file]").setInputFiles(path.resolve("tests/fixtures/alice.epub"));
  else {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Thoughtful reading connects questions with evidence and context.</w:t></w:r></w:p></w:body></w:document>');
    await page.locator("input[type=file]").setInputFiles({ name: "Research.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: await zip.generateAsync({ type: "nodebuffer" }) });
  }
  await expect(page.locator(".book-card")).toHaveCount(1); await page.locator(".book-cover-link").click();
  if (format === "epub") { await clickTool(page, "Contents"); await page.locator(".toc-item").filter({ hasText: /rabbit|chapter|down/i }).first().click(); }
  const body = format === "epub" ? page.frameLocator(".reader-host iframe").first().locator("body") : page.locator(".docx-content");
  await expect(body).toContainText(format === "epub" ? "Alice was beginning" : "Thoughtful reading");
  await body.evaluate(root => {
    const p = [...root.querySelectorAll("p")].find(p => (p.textContent?.trim().length || 0) > 30)!;
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); let node = walker.nextNode(); while (node && !node.textContent?.trim()) node = walker.nextNode();
    const r = document.createRange(); r.setStart(node!, 0); r.setEnd(node!, Math.min(50, node!.textContent!.length)); const s = document.getSelection()!; s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event("selectionchange"));
  });
  await showPassageAction(page, "Research");
  await page.getByRole("button", { name: "Research", exact: true }).click(); await expect(page.locator(".research-passage")).toBeVisible();
  await page.getByRole("button", { name: "Collect passage", exact: true }).click(); await page.getByLabel("Save destination").selectOption("new");
  await page.getByRole("button", { name: "Save excerpt", exact: true }).click(); await expect(page.getByRole("dialog")).toContainText("Excerpt and sources saved"); await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("tab", { name: "My sources", exact: true }).click(); await page.getByRole("textbox", { name: "Research question" }).fill(format === "epub" ? "What did Alice read?" : "How does reading connect questions and evidence?");
  await page.getByRole("button", { name: "Research", exact: true }).click(); await expect(page.locator(".research-pending")).toBeVisible();
  expect(await page.evaluate(async format => {
    const { list, db } = await import("/src/db.ts"); const notes = await list("notebook-note"); const source = notes[0].document.content?.find(n => n.type === "citation")?.attrs?.source;
    return source?.locator.type === format && (await db.chunks.count()) > 0;
  }, format)).toBe(true);
  const saved = await page.evaluate(async () => {
    const { list, save } = await import("/src/db.ts");
    const note = (await list("notebook-note"))[0];
    const source = note.document.content!.find(node => node.type === "citation")!.attrs!.source;
    const text = source.locator.quote?.exact || source.excerpt;
    await save("annotation", { id: "format-quote", bookId: source.bookId, locator: source.locator, text,
      note: "", tags: [], color: "yellow", createdAt: new Date().toISOString() });
    return { noteId: note.id, sourceTitle: source.title };
  });
  await page.goto(`/#/notebooks?note=${saved.noteId}`);
  await page.getByRole("button", { name: "Insert quote", exact: true }).click();
  await page.getByRole("dialog", { name: "Insert quote" }).locator(".quote-picker-list button").click();
  const citations = page.getByRole("textbox", { name: "Topic note content" }).getByRole("link", { name: saved.sourceTitle, exact: true });
  await expect(citations).toHaveCount(2);
  await citations.first().click();
  await expect(page).toHaveURL(/#\/read\/.+\?source=/);
  await expect(body).toContainText(format === "epub" ? "Alice was beginning" : "Thoughtful reading");
});
