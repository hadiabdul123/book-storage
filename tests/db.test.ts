import "fake-indexeddb/auto";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { db, save, list, acceptRemote, resolveStoredConflicts } from "../src/db";
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
  it("automatically keeps a later local edit and rebases its durable upload", async () => {
    await save("annotation", mark);
    const remote: Row = { key: "annotation:mark", kind: "annotation", id: "mark",
      value: { ...mark, note: "Older device edit" }, deleted: false, revision: 8,
      updatedAt: "2099-01-01T00:00:00Z", editedAt: "2026-01-02T00:00:00Z" };
    await acceptRemote(remote);
    expect((await list("annotation"))[0].note).toBe("Local thought");
    expect(await db.conflicts.count()).toBe(0);
    expect((await db.outbox.toArray())[0].baseRevision).toBe(8);
    await save("annotation", { ...mark, note: "Can keep editing" });
    expect((await list("annotation"))[0].note).toBe("Can keep editing");
  });
  it("a newer phone deletion removes an older pending PC highlight", async () => {
    await save("annotation", mark);
    const local = (await db.rows.get("annotation:mark"))!;
    const remote = { ...local, revision: 8, deleted: true,
      editedAt: new Date(Date.parse(local.editedAt!) + 1000).toISOString() };
    await acceptRemote(remote);
    expect(await list("annotation")).toHaveLength(0);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.conflicts.count()).toBe(0);
    await acceptRemote({ ...local, revision: 7 });
    expect(await list("annotation")).toHaveLength(0);
    await save("annotation", mark); // deliberate later restoration
    expect(await list("annotation")).toHaveLength(1);
    expect(Date.parse((await db.outbox.toArray())[0].createdAt)).toBeGreaterThan(Date.parse(remote.editedAt));
  });
  it("clears conflicts stored by the old app without a manual choice", async () => {
    await save("annotation", mark, true);
    const local = (await db.rows.get("annotation:mark"))!;
    await db.conflicts.put({ key: local.key, local,
      remote: { ...local, revision: 3, deleted: false, editedAt: "2026-01-01T00:00:00Z" }, detectedAt: "" });
    await resolveStoredConflicts();
    expect(await db.conflicts.count()).toBe(0);
    expect(await list("annotation")).toHaveLength(0);
    expect((await db.outbox.toArray())[0].baseRevision).toBe(3);
  });
  it("an acknowledgement cannot overwrite an edit made while uploading", async () => {
    await save("annotation", mark);
    const old = (await db.rows.get("annotation:mark"))!;
    await save("annotation", mark, true);
    await acceptRemote({ ...old, revision: 1 }, old.editId);
    expect(await list("annotation")).toHaveLength(0);
    expect(await db.outbox.count()).toBe(1);
    expect((await db.outbox.toArray())[0].deleted).toBe(true);
  });
  it("uses deletion then operation ID for equal edit timestamps", async () => {
    await save("annotation", mark);
    const local = (await db.rows.get("annotation:mark"))!;
    await acceptRemote({ ...local, revision: 2, deleted: true, editId: "00000000-0000-0000-0000-000000000000" });
    expect(await list("annotation")).toHaveLength(0);
    expect(await db.outbox.count()).toBe(0);
  });
  it("does not timestamp an unchanged save or an idle old reading position as new", async () => {
    await save("annotation", mark);
    await save("annotation", mark);
    expect(await db.outbox.count()).toBe(1);
    const position = { id: "book", bookId: "book", locator: mark.locator, progress: 0.5,
      readAt: "2026-01-02T00:00:00Z", device: "phone" };
    await save("position", position);
    await save("position", { ...position, progress: 0.1, device: "pc", readAt: "2026-01-01T00:00:00Z" });
    expect((await list("position"))[0]).toEqual(position);
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
});
