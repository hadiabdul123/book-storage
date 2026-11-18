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

  await page.getByRole("button", { name: "Show PDF page" }).click();
  await expect(page.getByRole("img", { name: /Page 1 of Study source/ })).toBeVisible();
  if (info.project.name === "desktop") {
    await page.setViewportSize({ width: 1440, height: 900 });
    const detail = await page.locator(".highlight-study-detail").boundingBox();
    const preview = await page.locator(".highlight-pdf-preview").boundingBox();
    expect(preview!.x).toBeGreaterThan(detail!.x + detail!.width);
  }
  await expect(page.locator(".highlight-pdf-surface svg rect")).toHaveCount(1);
  await page.getByLabel("Highlighted page").selectOption("2");
  const rotated = page.getByRole("img", { name: /Page 2 of Study source/ });
  await expect(rotated).toBeVisible();
  expect(await rotated.evaluate((canvas: HTMLCanvasElement) => canvas.width / canvas.height)).toBeGreaterThan(1);
  await page.getByRole("button", { name: "Close PDF page" }).click();
  await expect(page.locator(".highlight-pdf-preview")).toHaveCount(0);
  const download = page.waitForEvent("download");
  await page.getByLabel("Export notes", { exact: true }).selectOption("json");
  const exported = JSON.parse(await readFile((await (await download).path())!, "utf8"));
  expect(exported.study).toEqual([{ id: ids.id, priority: "important" }]);
  expect(exported.followups.map((note: { text: string }) => note.text)).toEqual(expect.arrayContaining(["Check the updated equation", "Use the course handout"]));

  await page.reload();
  await expect(notes).toContainText("Check the updated equation");
  await page.getByLabel("Filter by priority").selectOption("lower");
  await expect(page.locator(".notes-passage-open")).toHaveCount(0);
  await page.getByLabel("Filter by priority").selectOption("important");
  await page.getByLabel("Search annotations").fill("updated equation");
  await expect(page.locator(".notes-passage-open")).toHaveCount(1);
  await page.evaluate(async id => { const { db } = await import("/src/db.ts"); await db.files.delete(id); }, ids.bookId);
  await page.getByRole("button", { name: "Show PDF page" }).click();
  await expect(page.getByRole("alert")).toContainText("This book is not downloaded on this device");
});
