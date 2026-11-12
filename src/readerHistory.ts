import { db, save } from "./db";
import type { Annotation, Bookmark } from "./model";
type Kind = "annotation" | "bookmark";
type Value = Annotation | Bookmark;
type State = { value: Value; deleted: boolean } | null;
export type ReaderChange = {
  kind: Kind;
  value: Value;
  deleted?: boolean;
  expected?: Value;
};
type Entry = {
  kind: Kind;
  id: string;
  before: State;
  after: State;
  undone?: State;
};
type Action = { label: string; entries: Entry[] };
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
async function read(kind: Kind, id: string): Promise<State> {
  const row = await db.rows.get(`${kind}:${id}`);
  return row ? { value: row.value as Value, deleted: row.deleted } : null;
}
export class ReaderHistory {
  undoStack: Action[] = [];
  redoStack: Action[] = [];
  busy = false;
  async perform(label: string, changes: ReaderChange[]) {
    if (this.busy) throw new Error("Wait for the current change to finish.");
    this.busy = true;
    try {
      const entries = await db.transaction(
        "rw",
        [db.rows, db.outbox, db.conflicts, db.meta],
        async () => {
          const result: Entry[] = [];
          for (const change of changes) {
            const before = await read(change.kind, change.value.id);
            if (
              change.expected &&
              (!before ||
                before.deleted ||
                !equal(before.value, change.expected))
            )
              throw new Error(
                "This item changed elsewhere. Reopen it before editing.",
              );
            await save(change.kind, change.value, !!change.deleted);
            result.push({
              kind: change.kind,
              id: change.value.id,
              before,
              after: await read(change.kind, change.value.id),
            });
          }
          return result;
        },
      );
      this.undoStack.push({ label, entries });
      if (this.undoStack.length > 50) this.undoStack.shift();
      this.redoStack = [];
    } finally {
      this.busy = false;
    }
  }
  async move(direction: "undo" | "redo") {
    if (this.busy) throw new Error("Wait for the current change to finish.");
    const from = direction === "undo" ? this.undoStack : this.redoStack;
    const to = direction === "undo" ? this.redoStack : this.undoStack;
    const action = from.at(-1);
    if (!action) return;
    this.busy = true;
    try {
      const states = await db.transaction(
        "rw",
        [db.rows, db.outbox, db.conflicts, db.meta],
        async () => {
          const result: State[] = [];
          for (const entry of action.entries) {
            const actual = await read(entry.kind, entry.id);
            const expected = direction === "undo" ? entry.after : entry.undone;
            if (!equal(actual, expected))
              throw new Error(
                "This item changed elsewhere. Undo/redo cannot overwrite the newer edit.",
              );
            const target = direction === "undo" ? entry.before : entry.after;
            await save(
              entry.kind,
              (target || actual)!.value,
              target ? target.deleted : true,
            );
            result.push(await read(entry.kind, entry.id));
          }
          return result;
        },
      );
      action.entries.forEach((entry, i) => {
        if (direction === "undo") entry.undone = states[i];
        else entry.after = states[i];
      });
      from.pop();
      to.push(action);
      return action.label;
    } finally {
      this.busy = false;
    }
  }
}
