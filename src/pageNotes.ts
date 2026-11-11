import { db, save } from "./db";
import { type Annotation, type Book, type RichNode, now } from "./model";
import { plainText, validRichDocument } from "./richText";
export const pageNoteId = (bookId: string, page: number) =>
  `page-note:${bookId}:${page}`;
export async function savePageNote(
  book: Book,
  page: number,
  document: RichNode,
  tags?: string[],
) {
  if (
    book.format !== "pdf" ||
    !Number.isInteger(page) ||
    page < 1 ||
    !validRichDocument(document)
  )
    throw new Error("Invalid page notebook.");
  const id = pageNoteId(book.id, page);
  return db.transaction(
    "rw",
    [db.rows, db.outbox, db.conflicts, db.meta],
    async () => {
      const prior = await db.rows.get(`annotation:${id}`);
      const note = plainText(document).trim();
      if (!note && !prior) return;
      const previous = prior?.value as Annotation | undefined;
      const value: Annotation = {
        id,
        bookId: book.id,
        type: "page-note",
        text: `Page ${page} notebook`,
        note,
        locator: { v: 1, type: "pdf", hash: book.hash, page, y: 0 },
        content: { version: 1, document },
        color: previous?.color || "blue",
        tags: tags ?? previous?.tags ?? [],
        createdAt: previous?.createdAt || now(),
        updatedAt: now(),
      };
      await save("annotation", value);
      return value;
    },
  );
}
