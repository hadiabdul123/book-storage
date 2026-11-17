import { db, get, list, save } from "./db";
import { now, type EntityMap } from "./model";
export const defaultSectionId = (notebookId: string) => `section:${notebookId}:notes`;
export const noteSection = (note: EntityMap["notebook-note"]) => note.sectionId || defaultSectionId(note.notebookId);
export const noteOrder = (note: EntityMap["notebook-note"]) => note.order ?? -Date.parse(note.createdAt);
export async function ensureNotebookSection(notebookId: string) {
  const id = defaultSectionId(notebookId);
  return db.transaction("rw", db.rows, db.outbox, db.conflicts, db.meta, async () => {
    const notebook = await get("notebook", notebookId); if (!notebook) return;
    if (!(await get("notebook-section", id))) await save("notebook-section", { id, notebookId, title: "Notes", order: 0, createdAt: notebook.createdAt });
  });
}
export async function deleteNotebookSection(id: string) {
  await db.transaction("rw", db.rows, db.outbox, db.conflicts, db.meta, async () => {
    const section = await get("notebook-section", id); if (!section) return;
    if (id === defaultSectionId(section.notebookId)) throw new Error("The Notes section keeps pages safe and cannot be deleted.");
    await ensureNotebookSection(section.notebookId);
    for (const note of (await list("notebook-note")).filter(n => noteSection(n) === id)) await save("notebook-note", { ...note, sectionId: defaultSectionId(section.notebookId), updatedAt: now() });
    await save("notebook-section", section, true);
  });
}
