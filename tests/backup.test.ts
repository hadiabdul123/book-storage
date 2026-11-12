import "fake-indexeddb/auto";
import { beforeEach, expect, it, vi } from "vitest";
import { db, list, save } from "../src/db";
import { restoreAnnotationBackup } from "../src/backup";
import type { Annotation, Book, Row } from "../src/model";

vi.stubGlobal("window", new EventTarget());
const book = { id: "local-book", hash: "a".repeat(64) } as Book;
const annotation: Annotation = {
  id: "note", bookId: "old-book", text: "Passage", note: "Keep me",
  tags: [], color: "yellow", createdAt: "2026-01-01T00:00:00Z",
  locator: { v: 1, type: "pdf", hash: book.hash, page: 1, y: 0 },
};
const backup = (annotations: unknown[]) => ({ schema: "leafmark.annotations", version: 1, annotations });
beforeEach(async () => { for (const table of db.tables) await table.clear(); });

it("validates the entire backup before writing any notes or pending changes", async () => {
  await expect(restoreAnnotationBackup(backup([annotation, { invalid: true }]), [book])).rejects.toThrow("invalid annotation");
  expect(await db.rows.count()).toBe(0);
  expect(await db.outbox.count()).toBe(0);
});

it("matches file hashes and skips duplicates within a backup and existing notes", async () => {
  await save("annotation", { ...annotation, id: "existing", note: "Original" });
  const result = await restoreAnnotationBackup(backup([
    annotation, { ...annotation, note: "Duplicate" },
    { ...annotation, id: "existing", note: "Overwrite" },
    { ...annotation, id: "unknown", locator: { ...annotation.locator, hash: "b".repeat(64) } },
  ]), [book]);
  expect(result).toEqual({ restored: 1, skipped: 3 });
  expect(await list("annotation")).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "note", bookId: "local-book", note: "Keep me" }),
    expect.objectContaining({ id: "existing", note: "Original" }),
  ]));
  expect(await db.outbox.count()).toBe(2);
});

it("rolls back all writes when a later note cannot be stored", async () => {
  const add = db.outbox.add.bind(db.outbox);
  const write = vi.spyOn(db.outbox, "add").mockImplementationOnce(add)
    .mockRejectedValueOnce(new Error("Storage full"));
  try {
    await expect(restoreAnnotationBackup(backup([annotation, { ...annotation, id: "second" }]), [book])).rejects.toThrow("Storage full");
    expect(await db.rows.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.meta.count()).toBe(0);
  } finally { write.mockRestore(); }
});

it("restores deleted annotations and rejects malformed backup envelopes", async () => {
  await save("annotation", annotation, true);
  expect(await restoreAnnotationBackup(backup([annotation]), [book])).toEqual({ restored: 1, skipped: 0 });
  expect(await list("annotation")).toHaveLength(1);
  for (const invalid of [null, [], { schema: "leafmark.annotations", version: 0, annotations: [] }])
    await expect(restoreAnnotationBackup(invalid, [book])).rejects.toThrow("not a Leafmark");
});
