import { db, list, save } from "./db";
import type { Book } from "./model";
import { validAnnotation } from "./validation";

export async function restoreAnnotationBackup(data: unknown, books: Book[]) {
  if (
    !data || typeof data !== "object" ||
    !("schema" in data) || data.schema !== "leafmark.annotations" ||
    !("version" in data) || data.version !== 1 ||
    !("annotations" in data) || !Array.isArray(data.annotations)
  ) throw new Error("This is not a Leafmark annotation backup.");
  const annotations = data.annotations;
  if (!annotations.every(validAnnotation))
    throw new Error("The backup contains an invalid annotation.");

  return db.transaction("rw", [db.rows, db.outbox, db.conflicts, db.meta], async () => {
    const existing = new Set((await list("annotation")).map((a) => a.id));
    let restored = 0, skipped = 0;
    for (const annotation of annotations) {
      const book = books.find((b) => b.hash === annotation.locator.hash);
      if (!book || existing.has(annotation.id)) {
        skipped++;
        continue;
      }
      await save("annotation", { ...annotation, bookId: book.id });
      existing.add(annotation.id);
      restored++;
    }
    return { restored, skipped };
  });
}
