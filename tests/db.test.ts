import "fake-indexeddb/auto";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { db, save, list, acceptRemote, resolveConflict } from "../src/db";
import { type Row, type Annotation } from "../src/model";
vi.stubGlobal("window", new EventTarget());
const mark: Annotation = {
  id: "mark",
  bookId: "book",
  locator: {
    v: 1,
    type: "epub",
    hash: "a".repeat(64),
    cfi: "epubcfi(/6/2!/4/2:0)",
    href: "c1.xhtml",
  },
  text: "A real passage",
  note: "Local thought",
  tags: [],
  color: "yellow",
  createdAt: "2026-01-01T00:00:00Z",
};
beforeEach(async () => {
  for (const table of db.tables) await table.clear();
});
describe("offline-first edits", () => {
  it("atomically stores the highlight and its durable pending operation", async () => {
    await save("annotation", mark);
    expect(await list("annotation")).toEqual([mark]);
    const operations = await db.outbox.toArray();
    expect(operations).toHaveLength(1);
    expect(operations[0].value).toEqual(mark);
    expect(operations[0].baseRevision).toBe(0);
  });
  it("persists tombstones and allows restoring annotations", async () => {
    await save("annotation", mark);
    await save("annotation", mark, true);
    expect(await list("annotation")).toEqual([]);
    expect((await db.rows.get("annotation:mark"))?.deleted).toBe(true);
    await save("annotation", mark);
    expect(await list("annotation")).toHaveLength(1);
  });
  it("orders rapid changes by a durable sequence, independent of timestamp ties", async () => {
    await save("annotation", mark);
    await save("annotation", { ...mark, note: "Second" });
    await save("annotation", mark, true);
    const queue = await db.outbox.orderBy("sequence").toArray();
    expect(queue.map((op) => op.sequence)).toEqual([1, 2, 3]);
    expect(queue[2].deleted).toBe(true);
  });
  it("preserves both sides of a conflict and does not silently overwrite local notes", async () => {
    await save("annotation", mark);
    const remote: Row = {
      key: "annotation:mark",
      kind: "annotation",
      id: "mark",
      value: { ...mark, note: "Other device" },
      deleted: false,
      revision: 8,
      updatedAt: "2026-01-02T00:00:00Z",
    };
    await acceptRemote(remote);
    expect((await list("annotation"))[0].note).toBe("Local thought");
    const conflict = (await db.conflicts.toArray())[0];
    expect(conflict.remote).toEqual(remote);
    await expect(save("annotation", { ...mark, note: "More" })).rejects.toThrow(
      "Resolve",
    );
    await resolveConflict(conflict, "both");
    expect((await list("annotation")).map((a) => a.note).sort()).toEqual([
      "Local thought",
      "Other device",
    ]);
    expect(await db.conflicts.count()).toBe(0);
    expect(await db.outbox.count()).toBe(1);
  });
  it("applies newer remote tombstones but not older records", async () => {
    const row: Row = {
      key: "annotation:mark",
      kind: "annotation",
      id: "mark",
      value: mark,
      revision: 5,
      deleted: true,
      updatedAt: "",
    };
    await acceptRemote(row);
    await acceptRemote({ ...row, revision: 4, deleted: false });
    expect(await list("annotation")).toHaveLength(0);
  });
  it("keeping a local deletion preserves its tombstone", async () => {
    await save("annotation", mark, true);
    await acceptRemote({
      key: "annotation:mark",
      kind: "annotation",
      id: "mark",
      value: { ...mark, note: "Remote edit" },
      revision: 4,
      deleted: false,
      updatedAt: "",
    });
    await resolveConflict((await db.conflicts.toArray())[0], "local");
    expect(await list("annotation")).toHaveLength(0);
    expect((await db.outbox.toArray())[0].deleted).toBe(true);
  });
});
