import { db, list, save } from "./db";
import type { Book } from "./model";
import { validAnnotation } from "./validation";
import { pageNoteId } from "./pageNotes";
import { remapSourceBooks, remapDocumentBooks } from "./sourceReferences";
import { validInkStroke, type InkStroke } from "./inkTypes";

export async function restoreAnnotationBackup(data: unknown, books: Book[]) {
  if (
    !data ||
    typeof data !== "object" ||
    !("schema" in data) ||
    data.schema !== "leafmark.annotations" ||
    !("version" in data) ||
    ![1, 2, 3, 4].includes(data.version as number) ||
    !("annotations" in data) ||
    !Array.isArray(data.annotations)
  )
    throw new Error("This is not a Leafmark annotation backup.");
  const annotations = data.annotations;
  const ink: InkStroke[] = "ink" in data && Array.isArray(data.ink) ? data.ink : [];
  if (data.version === 4 && (!("ink" in data) || !Array.isArray(data.ink) || !ink.every(s => validInkStroke(s) && s.target.type === "pdf"))) throw new Error("The backup contains an invalid drawing.");
  if (!annotations.every(validAnnotation))
    throw new Error("The backup contains an invalid annotation.");

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
      return { restored, skipped };
    },
  );
}
