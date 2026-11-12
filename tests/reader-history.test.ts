import "fake-indexeddb/auto";
import { beforeEach, expect, it, vi } from "vitest";
import { db, get, save } from "../src/db";
import { ReaderHistory } from "../src/readerHistory";
import type { Annotation, Bookmark } from "../src/model";
vi.stubGlobal("window", new EventTarget());
const mark: Annotation = {
  id: "mark",
  bookId: "book",
  locator: { v: 1, type: "docx", hash: "hash", start: 2, end: 12 },
  text: "some words",
  note: "Retain this note",
  color: "yellow",
  tags: ["ideas"],
  createdAt: "2026-11-12",
};
beforeEach(async () => {
  for (const table of db.tables) await table.clear();
});
it("undoes and redoes create, recolor, note edit and removal without losing metadata", async () => {
  const h = new ReaderHistory();
  await h.perform("create", [{ kind: "annotation", value: mark }]);
  await h.perform("recolor", [
    { kind: "annotation", value: { ...mark, color: "blue" }, expected: mark },
  ]);
  await h.move("undo");
  expect(await get("annotation", "mark")).toEqual(mark);
  await h.move("redo");
  expect((await get("annotation", "mark"))?.color).toBe("blue");
  const blue = (await get("annotation", "mark"))!;
  await h.perform("note", [
    { kind: "annotation", value: { ...blue, note: "Updated" }, expected: blue },
  ]);
  await h.move("undo");
  expect((await get("annotation", "mark"))?.note).toBe(mark.note);
  await h.perform("remove", [
    { kind: "annotation", value: blue, expected: blue, deleted: true },
  ]);
  expect(await get("annotation", "mark")).toBeUndefined();
  await h.move("undo");
  expect(await get("annotation", "mark")).toEqual(blue);
  await h.move("undo");
  await h.move("undo");
  expect(await get("annotation", "mark")).toBeUndefined();
  await h.move("redo");
  expect(await get("annotation", "mark")).toEqual(mark);
  expect(await db.outbox.count()).toBeGreaterThan(5);
});
it("refuses newer edits and conflicts while keeping history intact", async () => {
  const h = new ReaderHistory();
  await h.perform("create", [{ kind: "annotation", value: mark }]);
  await save("annotation", { ...mark, note: "Other tab" });
  await expect(h.move("undo")).rejects.toThrow("changed elsewhere");
  expect(h.undoStack).toHaveLength(1);
  await expect(
    h.perform("stale", [{ kind: "annotation", value: mark, expected: mark }]),
  ).rejects.toThrow("changed elsewhere");
  const row = (await db.rows.get("annotation:mark"))!;
  await db.conflicts.put({
    key: row.key,
    local: row,
    remote: { ...row, revision: 2 },
    detectedAt: "now",
  });
  await expect(
    h.perform("conflict", [
      { kind: "annotation", value: row.value as Annotation },
    ]),
  ).rejects.toThrow("conflicting");
  expect(h.undoStack).toHaveLength(1);
});
it("removes duplicate page bookmarks as one atomic undoable operation", async () => {
  const first: Bookmark = {
    id: "one",
    bookId: "book",
    label: "Page 1",
    locator: { v: 1, type: "pdf", hash: "hash", page: 1, y: 0 },
    createdAt: "now",
  };
  const second = { ...first, id: "two" };
  await save("bookmark", first);
  await save("bookmark", second);
  const h = new ReaderHistory();
  await h.perform(
    "remove duplicates",
    [first, second].map((value) => ({
      kind: "bookmark",
      value,
      deleted: true,
    })),
  );
  await h.move("undo");
  expect(await get("bookmark", "one")).toEqual(first);
  expect(await get("bookmark", "two")).toEqual(second);
  await save("bookmark", { ...second, label: "Remote edit" });
  const count = await db.outbox.count();
  await expect(h.move("redo")).rejects.toThrow("changed elsewhere");
  expect(await get("bookmark", "one")).toEqual(first);
  expect(await db.outbox.count()).toBe(count);
});
it("bounds history to 50 actions and clears redo on a new action", async () => {
  const h = new ReaderHistory();
  for (let i = 0; i < 51; i++)
    await h.perform("create", [
      { kind: "annotation", value: { ...mark, id: String(i) } },
    ]);
  expect(h.undoStack).toHaveLength(50);
  await h.move("undo");
  expect(h.redoStack).toHaveLength(1);
  await h.perform("new", [{ kind: "annotation", value: mark }]);
  expect(h.redoStack).toHaveLength(0);
});

it("queues rapid create, removal and undo without waiting for cloud sync", async () => {
  const h = new ReaderHistory();
  const create = h.perform("create", [{ kind: "annotation", value: mark }]);
  const remove = h.perform("remove", [{ kind: "annotation", value: mark, expected: mark, deleted: true }]);
  const undo = h.move("undo");
  await Promise.all([create, remove, undo]);
  expect(await get("annotation", mark.id)).toEqual(mark);
  expect(await db.outbox.count()).toBe(3);
  await h.move("redo");
  expect(await get("annotation", mark.id)).toBeUndefined();
});
