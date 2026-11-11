import Dexie, { type Table } from "dexie";
import {
  type BookFile,
  type Conflict,
  type EntityMap,
  type Kind,
  type Operation,
  type Row,
  type Annotation,
  keyOf,
  now,
  uid,
} from "./model";
import { combineDocuments, plainText, emptyDocument } from "./richText";

class LibraryDB extends Dexie {
  rows!: Table<Row, string>;
  outbox!: Table<Operation, string>;
  files!: Table<BookFile, string>;
  conflicts!: Table<Conflict, string>;
  meta!: Table<{ key: string; value: string }, string>;
  constructor() {
    super("leafmark-v1");
    this.version(1).stores({
      rows: "&key, kind, id",
      outbox: "&opId, key, createdAt, sequence",
      files: "&id",
      conflicts: "&key",
      meta: "&key",
    });
  }
}
export const db = new LibraryDB();
async function nextSequence() {
  const last = Number((await db.meta.get("operationSequence"))?.value || 0);
  await db.meta.put({ key: "operationSequence", value: String(last + 1) });
  return last + 1;
}
export async function list<K extends Kind>(kind: K): Promise<EntityMap[K][]> {
  return (await db.rows.where("kind").equals(kind).toArray())
    .filter((r) => !r.deleted)
    .map((r) => r.value as EntityMap[K]);
}
export async function get<K extends Kind>(
  kind: K,
  id: string,
): Promise<EntityMap[K] | undefined> {
  const row = await db.rows.get(keyOf(kind, id));
  return row && !row.deleted ? (row.value as EntityMap[K]) : undefined;
}
export async function save<K extends Kind>(
  kind: K,
  value: EntityMap[K],
  deleted = false,
) {
  const key = keyOf(kind, value.id);
  await db.transaction(
    "rw",
    [db.rows, db.outbox, db.conflicts, db.meta],
    async () => {
      const prior = await db.rows.get(key);
      if (await db.conflicts.get(key))
        throw new Error(
          "Resolve the conflicting versions before editing this item.",
        );
      const revision = prior?.revision || 0;
      const row: Row = {
        key,
        kind,
        id: value.id,
        value,
        revision,
        deleted,
        updatedAt: now(),
      };
      await db.rows.put(row);
      await db.outbox.add({
        opId: uid(),
        key,
        kind,
        id: value.id,
        value,
        baseRevision: revision,
        deleted,
        createdAt: now(),
        sequence: await nextSequence(),
      });
    },
  );
  window.dispatchEvent(new Event("leafmark-sync"));
}
export async function acceptRemote(row: Row) {
  await db.transaction("rw", [db.rows, db.conflicts, db.outbox], async () => {
    const pending = await db.outbox.where("key").equals(row.key).count();
    const local = await db.rows.get(row.key);
    if (pending && local && row.revision > local.revision) {
      await db.conflicts.put({
        key: row.key,
        local,
        remote: row,
        detectedAt: now(),
      });
    } else if (!pending && (!local || row.revision > local.revision))
      await db.rows.put(row);
  });
}
export async function resolveConflict(
  conflict: Conflict,
  choice: "local" | "remote" | "both",
) {
  const { local, remote, key } = conflict;
  await db.transaction(
    "rw",
    [db.rows, db.outbox, db.conflicts, db.meta],
    async () => {
      await db.outbox.where("key").equals(key).delete();
      await db.rows.put(remote);
      await db.conflicts.delete(key);
      if (choice !== "remote") {
        const pageBoth =
          choice === "both" &&
          local.kind === "annotation" &&
          (local.value as Annotation).type === "page-note" &&
          (remote.value as Annotation).type === "page-note";
        let value =
          choice === "both" ? { ...local.value, id: uid() } : local.value;
        if (pageBoth) {
          const document = combineDocuments(
            (local.value as Annotation).content?.document || emptyDocument(),
            (remote.value as Annotation).content?.document || emptyDocument(),
          );
          value = {
            ...local.value,
            id: local.id,
            content: { version: 1, document },
            note: plainText(document),
            updatedAt: now(),
          } as Annotation;
        }
        const id = value.id,
          chosenKey = keyOf(local.kind, id);
        const revision = choice === "both" && !pageBoth ? 0 : remote.revision;
        await db.rows.put({
          ...local,
          id,
          key: chosenKey,
          value,
          revision,
          deleted: choice === "both" ? false : local.deleted,
        });
        await db.outbox.add({
          opId: uid(),
          key: chosenKey,
          kind: local.kind,
          id,
          value,
          baseRevision: revision,
          deleted: choice === "both" ? false : local.deleted,
          createdAt: now(),
          sequence: await nextSequence(),
        });
      }
    },
  );
  window.dispatchEvent(new Event("leafmark-sync"));
}
export async function clearPrivateData() {
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
}
