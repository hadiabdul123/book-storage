import { emptyCards, validCardLibrary } from "./cardStore";
import { db, get, list, save } from "./db";
import type { Book } from "./model";
import { validAnnotation } from "./validation";
import { pageNoteId } from "./pageNotes";
import { remapSourceBooks, remapDocumentBooks } from "./sourceReferences";
import { validInkStroke, type InkStroke } from "./inkTypes";
import { validHighlightFollowup, validHighlightStudy } from "./highlightStudy";
import { validPdfTextBox, type PdfTextBox } from "./pdfTextBoxes";

export async function restoreAnnotationBackup(data: unknown, books: Book[]) {
  if (
    !data ||
    typeof data !== "object" ||
    !("schema" in data) ||
    data.schema !== "leafmark.annotations" ||
    !("version" in data) ||
    ![1, 2, 3, 4, 5, 6].includes(data.version as number) ||
    !("annotations" in data) ||
    !Array.isArray(data.annotations)
  )
    throw new Error("This is not a Leafmark annotation backup.");
  const annotations = data.annotations;
  const ink: InkStroke[] = "ink" in data && Array.isArray(data.ink) ? data.ink : [];
  if (Number(data.version) >= 4 && (!("ink" in data) || !Array.isArray(data.ink) || !ink.every(s => validInkStroke(s) && s.target.type === "pdf"))) throw new Error("The backup contains an invalid drawing.");
  if (!annotations.every(validAnnotation))
    throw new Error("The backup contains an invalid annotation.");
  const boxes: unknown = "pdfTextBoxes" in data ? data.pdfTextBoxes : [];
  if (!Array.isArray(boxes) || !boxes.every(validPdfTextBox)) throw new Error("The backup contains an invalid PDF text box.");
  const study = Number(data.version) >= 5 && "study" in data ? data.study : [];
  const followups = Number(data.version) >= 5 && "followups" in data ? data.followups : [];
  if (!Array.isArray(study) || !study.every(validHighlightStudy) || !Array.isArray(followups) || !followups.every(validHighlightFollowup))
    throw new Error("The backup contains invalid highlight study records.");

  const library = data.version === 6 && "cardLibrary" in data ? data.cardLibrary : emptyCards;
  if (!validCardLibrary(library)) throw new Error("The backup contains invalid cards.");
  return db.transaction(
    "rw",
    [db.rows, db.outbox, db.conflicts, db.meta],
    async () => {
      const existing = new Set((await list("annotation")).map((a) => a.id));
      let restored = 0,
        skipped = 0;
      for (const annotation of annotations) {
        const book = books.find((b) => b.hash === annotation.locator.hash);
        const id =
          book &&
          annotation.type === "page-note" &&
          annotation.locator.type === "pdf"
            ? pageNoteId(book.id, annotation.locator.page)
            : annotation.id;
        if (!book || existing.has(id)) {
          skipped++;
          continue;
        }
        await save("annotation", { ...annotation, id, bookId: book.id,
          ...(annotation.sources ? { sources: annotation.sources.map(s => remapSourceBooks(s, books)) } : {}),
          ...(annotation.content ? { content: { version: 1, document: remapDocumentBooks(annotation.content.document, books) } } : {}),
        });
        existing.add(id);
        restored++;
      }
      for (const stroke of ink) {
        if (stroke.target.type !== "pdf") continue;
        const target = stroke.target, book = books.find(b => b.hash === target.hash);
        if (!book || await db.rows.get(`ink-stroke:${stroke.id}`)) { skipped++; continue; }
        await save("ink-stroke", { ...stroke, target: { ...target, bookId: book.id } }); restored++;
      }
      for (const box of boxes as PdfTextBox[]) {
        const book = books.find(candidate => candidate.format === "pdf" && candidate.hash === box.hash);
        if (!book || await db.rows.get("pdf-text-box:" + box.id)) { skipped++; continue; }
        await save("pdf-text-box", { ...box, bookId: book.id }); restored++;
      }
      const backedUp = new Map(annotations.filter(a => a.type !== "page-note").map(a => [a.id, a]));
      const matches = async (id: string) => {
        const local = await get("annotation", id), imported = backedUp.get(id);
        return !!(local && imported && local.type !== "page-note" && local.locator.hash === imported.locator.hash && local.text === imported.text);
      };
      for (const item of study) {
        if (!(await matches(item.id)) || await db.rows.get(`highlight-study:${item.id}`)) { skipped++; continue; }
        await save("highlight-study", item); restored++;
      }
      for (const item of followups) {
        if (!(await matches(item.annotationId)) || await db.rows.get(`highlight-followup:${item.id}`)) { skipped++; continue; }
        await save("highlight-followup", item); restored++;
      }
      for (const c of library.categories) {
        if (await db.rows.get("quote-category:" + c.id)) { skipped++; continue; }
        await save("quote-category",c); restored++;
      }
      for (const c of library.cards) {
        if (await db.rows.get("research-card:" + c.id)) { skipped++; continue; }
        await save("research-card",{ ...c, sources:c.sources.map(s => remapSourceBooks(s,books)) }); restored++;
      }
      for (const f of library.filings) {
        if (!(await get("quote-category",f.categoryId)) || (!(await get("research-card",f.cardId)) && !(await matches(f.cardId))) || await db.rows.get("card-filing:" + f.id)) { skipped++; continue; }
        await save("card-filing",f); restored++;
      }
      return { restored, skipped };
    },
  );
}
