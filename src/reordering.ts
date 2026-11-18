import { db, list, save } from "./db";
import type { Book, EntityMap } from "./model";
import type { Notebook } from "./researchTypes";
import { noteOrder, noteSection } from "./notebookSections";
import type { ItemAction } from "./ItemMenu";

export type Move = -1 | 1 | "first" | "last" | { id: string; after: boolean };

export const recentBooks = (a: Book, b: Book) => b.addedAt.localeCompare(a.addedAt) || a.id.localeCompare(b.id);
export const orderedBooks = (a: Book, b: Book) => manual(a, b) || recentBooks(a, b);
export const orderedNotebooks = (a: Notebook, b: Notebook) => manual(a, b) || a.id.localeCompare(b.id);
export const orderedSections = (a: EntityMap["notebook-section"], b: EntityMap["notebook-section"]) => a.order - b.order || a.id.localeCompare(b.id);
export const orderedPages = (a: EntityMap["notebook-note"], b: EntityMap["notebook-note"]) => noteOrder(a) - noteOrder(b) || a.id.localeCompare(b.id);

function manual(a: { manualOrder?: number }, b: { manualOrder?: number }) {
  return (a.manualOrder ?? Infinity) - (b.manualOrder ?? Infinity);
}

export function moveActions(items: { id: string }[], id: string, move: (target: Move) => void, enabled = true): ItemAction[] {
  const index = items.findIndex(item => item.id === id);
  return [
    { label: "Move up", disabled: !enabled || index <= 0, run: () => move(-1) },
    { label: "Move down", disabled: !enabled || index < 0 || index >= items.length - 1, run: () => move(1) },
    { label: "Move to top", disabled: !enabled || index <= 0, run: () => move("first") },
    { label: "Move to bottom", disabled: !enabled || index < 0 || index >= items.length - 1, run: () => move("last") },
  ];
}

export async function reorder(kind: "book" | "notebook" | "notebook-section" | "notebook-note", id: string, target: Move) {
  await db.transaction("rw", db.rows, db.outbox, db.conflicts, db.meta, async () => {
    async function apply<K extends typeof kind>(
      kind: K, items: EntityMap[K][], rank: (item: EntityMap[K]) => number | undefined,
      withRank: (item: EntityMap[K], order: number) => EntityMap[K],
    ) {
      const from = items.findIndex(item => item.id === id);
      if (from < 0) return;
      const [item] = items.splice(from, 1);
      const to = typeof target === "number" ? from + target : target === "first" ? 0 :
        target === "last" ? items.length : items.findIndex(other => other.id === target.id);
      const insert = typeof target === "object" && target.after && to >= 0 ? to + 1 : to;
      if (insert < 0 || insert > items.length || insert === from) return;
      items.splice(insert, 0, item);
      for (const [index, entry] of items.entries()) {
        const order = index * 1024;
        if (rank(entry) !== order) await save(kind, withRank(entry, order));
      }
    }
    if (kind === "book") await apply(kind, (await list(kind)).sort(orderedBooks), b => b.manualOrder, (b, manualOrder) => ({ ...b, manualOrder }));
    if (kind === "notebook") await apply(kind, (await list(kind)).sort(orderedNotebooks), b => b.manualOrder, (b, manualOrder) => ({ ...b, manualOrder }));
    if (kind === "notebook-section") {
      const items = await list(kind), parent = items.find(item => item.id === id)?.notebookId;
      await apply(kind, items.filter(item => item.notebookId === parent).sort(orderedSections), b => b.order, (b, order) => ({ ...b, order }));
    }
    if (kind === "notebook-note") {
      const items = await list(kind), item = items.find(item => item.id === id);
      if (item) await apply(kind, items.filter(b => b.notebookId === item.notebookId && noteSection(b) === noteSection(item)).sort(orderedPages), b => b.order, (b, order) => ({ ...b, order }));
    }
  });
}
