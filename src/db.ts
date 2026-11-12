import Dexie, { type Table } from "dexie";
import {
  type BookFile,
  type Conflict,
  type EntityMap,
  type Kind,
  type Operation,
  type Row,
  keyOf,
  uid,
} from "./model";
import { compareEdits, editTime } from "./syncOrder";

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
      const conflict = await db.conflicts.get(key);
      if (!conflict && prior?.deleted === deleted &&
          JSON.stringify(prior.value) === JSON.stringify(value)) return;
      // A hidden/closing reader must not publish its old location as a new edit.
      const readTime = kind === "position" ? Date.parse((value as EntityMap["position"]).readAt) : undefined;
      if (readTime !== undefined && prior && readTime <= editTime(prior)) return;
      const editedAt = new Date(readTime ?? Math.max(Date.now(), editTime(prior) + 1,
        editTime(conflict?.remote) + 1)).toISOString();
      const opId = uid();
      const revision = Math.max(prior?.revision || 0, conflict?.remote.revision || 0);
      await db.conflicts.delete(key);
      const row: Row = {
        key,
        kind,
        id: value.id,
        value,
        revision,
        deleted,
        updatedAt: editedAt,
        editedAt,
        editId: opId,
      };
      await db.rows.put(row);
      await db.outbox.add({
        opId,
        key,
        kind,
        id: value.id,
        value,
        baseRevision: revision,
        deleted,
        createdAt: editedAt,
        sequence: await nextSequence(),
      });
    },
  );
  window.dispatchEvent(new Event("leafmark-sync"));
}
export async function acceptRemote(row: Row, acknowledgedOpId?: string) {
  await db.transaction("rw", [db.rows, db.conflicts, db.outbox], async () => {
    if (acknowledgedOpId) await db.outbox.delete(acknowledgedOpId);
    const local = await db.rows.get(row.key);
    if (local && row.revision < local.revision) {
      await db.conflicts.delete(row.key);
      return;
    }
    const pending = await db.outbox.where("key").equals(row.key).sortBy("sequence");
    const last = pending.at(-1);
    // Old stored rows did not include their operation's edit timestamp.
    const candidate = local && last ? { ...local, editedAt: last.createdAt, editId: last.opId } : local;
    if (candidate && last && compareEdits(candidate, row) > 0) {
      await db.rows.put({ ...candidate, revision: row.revision });
      for (const op of pending) await db.outbox.update(op.opId, { baseRevision: row.revision });
    } else {
      await db.outbox.where("key").equals(row.key).delete();
      await db.rows.put(row);
    }
    await db.conflicts.delete(row.key);
  });
}

// Upgrade conflicts left by older app versions, including while offline.
export async function resolveStoredConflicts() {
  for (const conflict of await db.conflicts.toArray()) await acceptRemote(conflict.remote);
}
export async function clearPrivateData() {
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
}
