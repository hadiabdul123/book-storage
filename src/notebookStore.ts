import { db, get, list, save } from "./db";
import { now, uid, type Annotation, type Locator, type RichNode } from "./model";
import type { NotebookNote, SourceRef } from "./researchTypes";
import { citationNode, validSourceRef } from "./sourceReferences";
import { emptyDocument, paragraph, plainText, validRichDocument } from "./richText";
import { samePassage } from "./reader/passages";
import { pageNoteId, savePageNote } from "./pageNotes";

const flushers = new Map<string, () => Promise<boolean>>();
export function registerNoteFlusher(id: string, flush: () => Promise<boolean>) {
  flushers.set(id, flush); return () => { if (flushers.get(id) === flush) flushers.delete(id); };
}
export async function flushTopicNote(id: string) { return (await flushers.get(id)?.()) ?? true; }
export async function saveNotebookNote(note: NotebookNote, expectedUpdatedAt?: string) {
  if (!note.title.trim() || !validRichDocument(note.document) || !Array.isArray(note.tags)) throw new Error("A title and valid note are required.");
  const value = { ...note, updatedAt: now() };
  await db.transaction("rw", db.rows, db.outbox, db.conflicts, db.meta, async () => {
    const prior = await get("notebook-note", note.id);
    if (prior?.sectionId && value.sectionId === undefined) value.sectionId = prior.sectionId;
    if (prior?.order !== undefined && value.order === undefined) value.order = prior.order;
    if (prior && expectedUpdatedAt && prior.updatedAt !== expectedUpdatedAt)
      await db.meta.put({ key: `note-version:${note.id}:local-${uid()}`, value: JSON.stringify({ value: prior }) });
    await save("notebook-note", value);
  });
  return value;
}
export async function recoverNotebookNote(note: NotebookNote, notebookId: string) {
  const section = note.sectionId ? await get("notebook-section", note.sectionId) : undefined;
  const recovered = await saveNotebookNote({ ...note, id: uid(), notebookId, sectionId: section?.notebookId === notebookId ? section.id : undefined, title: `${note.title} (recovered)`.slice(0, 200), createdAt: now(), updatedAt: now() });
  for (const stroke of (await list("ink-stroke")).filter(s => s.target.type === "notebook" && s.target.noteId === note.id))
    await save("ink-stroke", { ...stroke, id: uid(), target: { ...stroke.target, type: "notebook", noteId: recovered.id, blockId: stroke.target.type === "notebook" ? stroke.target.blockId : "" } });
  return recovered;
}
export type ClipTarget = { kind: "note"; noteId: string } |
  { kind: "new"; notebookId?: string; notebookTitle?: string; title: string } |
  { kind: "page"; bookId: string; page: number } |
  { kind: "passage"; bookId: string; locator: Locator; quote: string };
export async function saveResearchClip(target: ClipTarget, text: string, sources: SourceRef[]) {
  if (!text.trim() || text.length > 20000 || sources.length > 20 || !sources.every(validSourceRef)) throw new Error("Choose a shorter excerpt with valid sources.");
  if (target.kind === "note" && (await flushers.get(target.noteId)?.()) === false) throw new Error("Save the open note before adding research.");
  const blocks: RichNode[] = [...text.split(/\n\s*\n/).map(paragraph), ...sources.map(citationNode)];
  if (target.kind === "page") {
    const book = await get("book", target.bookId);
    if (!book || book.format !== "pdf") throw new Error("Choose an available PDF.");
    let pages = Number((await db.meta.get(`pdf-page-count:${book.hash}`))?.value || 0);
    if (!pages) {
      const file = await db.files.get(book.id);
      if (!file) throw new Error("Download this PDF before choosing a page.");
      const { pdfLibrary, pdfOptions } = await import("./pdf");
      const pdf = await pdfLibrary(); const task = pdf.getDocument(pdfOptions(await file.source.arrayBuffer()));
      try { pages = (await task.promise).numPages; await db.meta.put({ key: `pdf-page-count:${book.hash}`, value: String(pages) }); }
      finally { await task.destroy(); }
    }
    if (!Number.isInteger(target.page) || target.page < 1 || target.page > pages) throw new Error(`Choose a page between 1 and ${pages}.`);
  }
  let savedId = "";
  await db.transaction("rw", db.rows, db.outbox, db.conflicts, db.meta, async () => {
    if (target.kind === "note" || target.kind === "new") {
      let note: NotebookNote | undefined;
      if (target.kind === "note") note = await get("notebook-note", target.noteId);
      else {
        let notebookId = target.notebookId;
        if (!notebookId) { notebookId = uid(); await save("notebook", { id: notebookId, title: target.notebookTitle?.trim() || "Research", createdAt: now() }); }
        if (!(await get("notebook", notebookId))) throw new Error("This notebook is no longer available.");
        note = { id: uid(), notebookId, title: target.title.trim() || "Research note", document: emptyDocument(), tags: [], createdAt: now(), updatedAt: now() };
      }
      if (!note) throw new Error("This note is no longer available.");
      const recovery = await db.meta.get(`topic-draft:${note.id}`);
      if (recovery) { const draft = JSON.parse(recovery.value); if (draft.id === note.id && validRichDocument(draft.document)) note = { ...note, document: draft.document }; }
      await saveNotebookNote({ ...note, document: { type: "doc", content: [...(note.document.content || []), ...blocks] } });
      await db.meta.delete(`topic-draft:${note.id}`);
      savedId = note.id;
    } else {
      const book = await get("book", target.bookId);
      if (!book) throw new Error("This book is no longer available.");
      if (target.kind === "page") {
        const old = await get("annotation", pageNoteId(book.id, target.page));
        const recovery = await db.meta.get(`page-note-draft:${book.id}:${target.page}`);
        let doc = old?.content?.document || emptyDocument(), tags = old?.tags;
        if (recovery) { const draft = JSON.parse(recovery.value); if (validRichDocument(draft.document)) doc = draft.document; if (Array.isArray(draft.tags) && draft.tags.every((t: unknown) => typeof t === "string")) tags = draft.tags; }
        await savePageNote(book, target.page, { type: "doc", content: [...(doc.content || []), ...blocks] }, tags);
        await db.meta.delete(`page-note-draft:${book.id}:${target.page}`);
        savedId = pageNoteId(book.id, target.page);
      } else {
        if (target.locator.hash !== book.hash) throw new Error("The passage belongs to another edition.");
        const prior = (await list("annotation")).find(a => a.bookId === book.id && a.type !== "page-note" && samePassage(a.locator, target.locator));
        const key = `passage-drafts:${book.id}`;
        let drafts: Record<string, { text: string; selection: { locator: Locator } }> = {};
        try { drafts = JSON.parse((await db.meta.get(key))?.value || "{}"); } catch { /* No recovery data. */ }
        const draftEntry = Object.entries(drafts).find(([, d]) => d?.selection?.locator && samePassage(d.selection.locator, target.locator));
        const note = [draftEntry?.[1].text || prior?.note, text].filter(Boolean).join("\n\n");
        const annotation: Annotation = { ...(prior || { id: uid(), bookId: book.id, locator: target.locator, text: target.quote, color: "blue", tags: [], createdAt: now() }),
          note, updatedAt: now(), sources: [...(prior?.sources || []), ...sources].slice(-100) };
        await save("annotation", annotation);
        if (draftEntry) { delete drafts[draftEntry[0]]; await db.meta.put({ key, value: JSON.stringify(drafts) }); }
        savedId = annotation.id;
      }
    }
  });
  window.dispatchEvent(new CustomEvent("leafmark-clipped", { detail: { id: savedId } }));
  return savedId;
}
export function noteExcerpt(note: NotebookNote) { return `${note.title}\n${plainText(note.document)}`; }
