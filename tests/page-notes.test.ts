import "fake-indexeddb/auto";
import { beforeEach, expect, it, vi } from "vitest";
import { db, get, save, acceptRemote } from "../src/db";
import { savePageNote, pageNoteId } from "../src/pageNotes";
import {
  paragraph,
  emptyDocument,
  markdown,
  validRichDocument,
} from "../src/richText";
import { restoreAnnotationBackup } from "../src/backup";
import { type Book, type RichNode, type Row } from "../src/model";
import { validAnnotation } from "../src/validation";
vi.stubGlobal("window", new EventTarget());
const book = { id: "book", format: "pdf", hash: "a".repeat(64) } as Book;
const document = (text: string): RichNode => ({
  type: "doc",
  content: [paragraph(text)],
});
beforeEach(async () => {
  for (const table of db.tables) await table.clear();
});
it("does not manufacture empty notebooks and preserves a stable notebook across edits", async () => {
  await savePageNote(book, 2, emptyDocument());
  expect(await db.rows.count()).toBe(0);
  await savePageNote(book, 2, document("First"));
  await savePageNote(book, 2, document("Second"));
  expect(await db.rows.count()).toBe(1);
  expect(await get("annotation", pageNoteId(book.id, 2))).toMatchObject({
    note: "Second",
    type: "page-note",
    locator: { page: 2 },
  });
  await expect(savePageNote(book, 0, document("Invalid"))).rejects.toThrow(
    "Invalid",
  );
});
it("restores rich notebooks by file hash without duplicating the page or overwriting existing writing", async () => {
  const note = (await savePageNote(book, 3, document("My note")))!;
  for (const table of db.tables) await table.clear();
  const target = { ...book, id: "new-book" };
  const backup = {
    schema: "leafmark.annotations",
    version: 2,
    annotations: [note, note],
  };
  expect(await restoreAnnotationBackup(backup, [target])).toEqual({
    restored: 1,
    skipped: 1,
  });
  expect(await get("annotation", pageNoteId(target.id, 3))).toMatchObject({
    note: "My note",
    bookId: target.id,
  });
  expect(await restoreAnnotationBackup(backup, [target])).toEqual({
    restored: 0,
    skipped: 2,
  });
});
it("uses the newer page notebook without creating duplicate notes", async () => {
  const note = (await savePageNote(book, 1, document("Local writing")))!;
  const remote: Row = {
    key: `annotation:${note.id}`,
    kind: "annotation",
    id: note.id,
    value: {
      ...note,
      note: "Other writing",
      content: { version: 1, document: document("Other writing") },
    },
    revision: 3,
    deleted: false,
    updatedAt: note.createdAt,
    editedAt: "2099-01-01T00:00:00Z",
  };
  await acceptRemote(remote);
  expect(await db.rows.count()).toBe(1);
  const merged = (await get("annotation", note.id))!;
  expect(merged.note).toContain("Other writing");
  expect(await db.outbox.count()).toBe(0);
  expect(await db.conflicts.count()).toBe(0);
});
it("preserves lists and checkboxes in export and rejects unsupported imported content", async () => {
  const rich: RichNode = {
    type: "doc",
    content: [
      {
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: true },
            content: [paragraph("Read again")],
          },
        ],
      },
      {
        type: "bulletList",
        content: [{ type: "listItem", content: [paragraph("Important")] }],
      },
    ],
  };
  expect(validRichDocument(rich)).toBe(true);
  expect(markdown(rich)).toContain("- [x] Read again");
  expect(markdown(rich)).toContain("- Important");
  const note = (await savePageNote(book, 1, rich))!;
  expect(validAnnotation(note)).toBe(true);
  expect(
    validAnnotation({
      ...note,
      content: {
        version: 1,
        document: {
          type: "doc",
          content: [{ type: "image", attrs: { src: "https://example.com" } }],
        },
      },
    }),
  ).toBe(false);
  await save("annotation", note, true);
  expect(await get("annotation", note.id)).toBeUndefined();
  await save("annotation", note);
  expect((await get("annotation", note.id))?.content).toEqual(note.content);
});
