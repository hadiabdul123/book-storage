import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { degrees, PDFDocument } from "pdf-lib";

test("a highlight keeps follow-ups, study labels and an on-demand full PDF preview", async ({ page }, info) => {
  const pdf = await PDFDocument.create();
  for (const caption of ["Review the marked statement", "Turn to the second page"]) {
    const sheet = pdf.addPage([260, 340]);
    sheet.drawText(caption, { x: 20, y: 260, size: 12 });
    if (caption.startsWith("Turn")) sheet.setRotation(degrees(90));
  }
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({ name: "Study source.pdf", mimeType: "application/pdf", buffer: Buffer.from(await pdf.save()) });
  await expect(page.getByRole("heading", { name: "Study source", exact: true })).toBeVisible({ timeout: 15_000 });
  const ids = await page.evaluate(async () => {
    const { list, save } = await import("/src/db.ts");
    const book = (await list("book"))[0];
    const id = crypto.randomUUID();
    await save("annotation", { id, bookId: book.id, locator: { v: 1, type: "pdf", page: 1, y: 0.2, hash: book.hash,
      regions: [1, 2].map(page => ({ page, rects: [[20, 255, 175, 275]] })) },
      text: "Review the marked statement", note: "Original observation", color: "yellow", tags: ["chapter one"], createdAt: new Date().toISOString() });
    return { id, bookId: book.id };
  });
  await page.goto(`/#/notes?item=${ids.id}`);
  await expect(page.locator(".annotation-card")).toContainText("Original observation");
  await expect(page.locator(".highlight-pdf-preview")).toHaveCount(0);
  if (info.project.name === "desktop") await page.locator(".notes-passage-open").click({ button: "right" });
  else await page.getByRole("button", { name: "More actions for selected highlight" }).click();
  await page.getByRole("menuitem", { name: "Mark important" }).click();
  await expect(page.locator(".highlight-study-detail .highlight-priority")).toHaveText("Important");
  await page.getByRole("button", { name: "More actions for selected highlight" }).click();
  await page.getByRole("menuitem", { name: "Edit tags" }).click();
  await page.getByRole("dialog").getByLabel("Tags", { exact: true }).fill("chapter one, revision");
  await page.getByRole("button", { name: "Save tags", exact: true }).click();
  await expect(page.locator(".highlight-study-detail .highlight-tag")).toHaveText(["chapter one", "revision"]);
  for (const text of ["Check the derivation", "Use the course handout"]) {
    await page.getByRole("button", { name: "Add follow-up note", exact: true }).click();
    await page.getByLabel("New follow-up note").fill(text);
    await page.getByRole("button", { name: "Save follow-up note" }).click();
  }
  const notes = page.getByRole("region", { name: "Follow-up notes" });
  await expect(notes.locator("article")).toHaveCount(2);
  await notes.locator("article").filter({ hasText: "Check the derivation" }).getByRole("button").click();
  await page.getByRole("menuitem", { name: "Edit follow-up" }).click();
  await page.getByLabel("Edit follow-up note").fill("Check the updated equation");
  await page.getByRole("button", { name: "Save follow-up note" }).click();
  await expect(notes).toContainText("Check the updated equation");
  await expect(page.locator(".annotation-card")).toContainText("Original observation");

  if (info.project.name === "desktop") await page.setViewportSize({ width: 1950, height: 900 });
  const detailBefore = await page.locator(".highlight-study-detail").boundingBox();
  const listBefore = await page.locator(".notes-passage-list").boundingBox();
  await page.getByRole("button", { name: "Show PDF page" }).click();
  await expect(page.getByRole("img", { name: /Page 1 of Study source/ })).toBeVisible();
  if (info.project.name === "desktop") {
    await expect(page.locator(".with-pdf-preview")).toBeVisible();
    const detail = await page.locator(".highlight-study-detail").boundingBox();
    const preview = await page.locator(".highlight-pdf-preview").boundingBox();
    expect(preview!.x).toBeGreaterThan(detail!.x + detail!.width);
    expect(detail!.width).toBeCloseTo(detailBefore!.width);
    expect((await page.locator(".notes-passage-list").boundingBox())!.width).toBeCloseTo(listBefore!.width);
  } else await expect(page.getByRole("dialog", { name: "Source PDF page" })).toBeVisible();
  await expect(page.locator(".highlight-pdf-surface svg rect")).toHaveCount(1);
  await page.getByLabel("Highlighted page").selectOption("2");
  const rotated = page.getByRole("img", { name: /Page 2 of Study source/ });
  await expect(rotated).toBeVisible();
  expect(await rotated.evaluate((canvas: HTMLCanvasElement) => canvas.width / canvas.height)).toBeGreaterThan(1);
  await page.getByRole("button", { name: "Close PDF page" }).click();
  await expect(page.locator(".highlight-pdf-preview")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show PDF page" })).toBeFocused();
  const download = page.waitForEvent("download");
  await page.getByLabel("Export notes", { exact: true }).selectOption("json");
  const exported = JSON.parse(await readFile((await (await download).path())!, "utf8"));
  expect(exported.study).toEqual([{ id: ids.id, priority: "important" }]);
  expect(exported.followups.map((note: { text: string }) => note.text)).toEqual(expect.arrayContaining(["Check the updated equation", "Use the course handout"]));

  await page.reload();
  await expect(notes).toContainText("Check the updated equation");
  await page.getByText("More filters", { exact:true }).click();
  await page.getByLabel("Filter by priority").selectOption("lower");
  await expect(page.locator(".notes-passage-open")).toHaveCount(0);
  await page.getByLabel("Filter by priority").selectOption("important");
  await page.getByLabel("Search annotations").fill("updated equation");
  await expect(page.locator(".notes-passage-open")).toHaveCount(1);
  await page.evaluate(async id => { const { db } = await import("/src/db.ts"); await db.files.delete(id); }, ids.bookId);
  await page.getByRole("button", { name: "Show PDF page" }).click();
  await expect(page.getByRole("alert")).toContainText("This book is not downloaded on this device");
});

test("a scoped page and notebook comparison becomes a reusable filed card", async ({ page }) => {
  const pdf = await PDFDocument.create();
  for (const text of ["Outside the selection", "Build a regular practice"]) pdf.addPage([320,400]).drawText(text);
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({ name:"Practice.pdf", mimeType:"application/pdf", buffer:Buffer.from(await pdf.save()) });
  await expect(page.getByRole("heading",{name:"Practice",exact:true})).toBeVisible();
  await page.evaluate(async () => {
    const { save } = await import("/src/db.ts");
    const createdAt = new Date().toISOString();
    await save("notebook",{id:"journal",title:"Journal",createdAt});
    await save("notebook-note",{id:"monday",notebookId:"journal",title:"Monday",tags:[],createdAt,updatedAt:createdAt,
      document:{type:"doc",content:[{type:"paragraph",content:[{type:"text",text:"A short practice was easier to repeat."}]}]}});
  });
  await page.goto("/#/notebooks?view=research");
  await page.getByRole("button",{name:"Start a study"}).click();
  await page.getByRole("checkbox",{name:"Practice",exact:true}).check();
  await page.getByRole("button",{name:"Practice · Whole book"}).click();
  await page.getByLabel("From page").fill("2");
  await page.getByRole("button",{name:"Add pages"}).click();
  await page.getByRole("button",{name:"Notebook pages",exact:true}).click();
  await page.getByRole("checkbox",{name:/Monday/}).check();
  await page.getByRole("button",{name:"Start study",exact:true}).click();
  await page.getByLabel("Research question").fill("Which practices repeat?");
  await page.getByRole("button",{name:"Compare sources",exact:true}).click();
  await expect.poll(() => page.evaluate(async () => (await (await import("/src/db.ts")).db.researchJobs.count()))).toBe(1);
  await page.evaluate(async () => {
    const { db,save } = await import("/src/db.ts");
    const [job] = await db.researchJobs.toArray();
    const book = job.request.sources.find(s => s.kind === "book");
    if (!book || book.locator?.type !== "pdf" || book.locator.page !== 2 || job.request.sources.some(s => s.excerpt.includes("Outside the selection"))
      || !job.request.sources.some(s => s.noteId === "monday")) throw new Error("Incorrect comparison scope");
    await save("research-message",{id:job.id,threadId:job.threadId,createdAt:new Date().toISOString(),question:job.request.question,mode:"sources",
      model:"fixture",answer:"Repetition helps establish a practice. [S1] [S2]",sources:job.request.sources});
  });
  await page.getByRole("button",{name:"Save finding or selection"}).click();
  await page.getByLabel("Save destination").selectOption("card");
  await page.getByRole("dialog").getByRole("button",{name:"Save card",exact:true}).click();
  await page.getByRole("button",{name:"Done",exact:true}).click();
  await page.goto("/#/notes");
  await page.locator(".notes-passage-open").first().click();
  const card = page.getByRole("dialog",{name:"Research note",exact:true});
  await expect(card.locator(".source-citation")).toHaveCount(2);
  await card.getByRole("button",{name:"Edit categories"}).click();
  await page.getByLabel("Find or create a category").fill("Practice");
  await page.getByRole("button",{name:"Create “Practice”"}).click();
  await page.getByRole("button",{name:"Save categories"}).click();
  await expect(card.locator(".card-chips")).toContainText("Practice");
  await page.screenshot({path:test.info().outputPath("filed-card.png")});
  await card.getByRole("button",{name:"Close",exact:true}).click();
  await page.getByRole("navigation",{name:"Categories",exact:true}).getByRole("button",{name:"Practice",exact:true}).click();
  await page.reload();
  await expect(page.locator(".notes-passage-open")).toHaveCount(1);
  await page.getByRole("button",{name:"Board",exact:true}).click();
  const tile=page.locator(".category-board [data-card]");
  await expect(tile).toHaveCount(1);
  const before=await tile.getAttribute("style");
  await tile.press("ArrowRight");
  await expect(tile).not.toHaveAttribute("style",before!);
  const moved=await tile.getAttribute("style");
  await page.reload();await expect(tile).toHaveAttribute("style",moved!);
  await page.getByRole("button",{name:"Gallery",exact:true}).click();
  await page.getByText("More filters",{exact:true}).click();
  await page.getByLabel("View name",{exact:true}).fill("Practice cards");
  await page.getByRole("button",{name:"Save view",exact:true}).click();
  await expect(page.getByLabel("Saved views").locator("option",{hasText:"Practice cards"})).toHaveCount(1);
  await page.getByRole("button",{name:"Clear filters",exact:true}).click();
  await page.getByLabel("Saved views").selectOption({label:"Practice cards"});
  await expect(page.getByRole("navigation",{name:"Categories",exact:true}).getByRole("button",{name:"Practice",exact:true})).toHaveAttribute("aria-pressed","true");
  await page.getByText("More filters",{exact:true}).click();
  await page.locator(".notes-passage-open").click();
  await card.getByRole("link",{name:"Open study"}).click();
  await expect(page.locator(".study-answer")).toContainText("Repetition helps");
});
