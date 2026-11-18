import { db, get, list, save } from "./db";
import type { EntityMap, Kind, RichNode } from "./model";
import { validRichDocument, markdown } from "./richText";
import { validSourceRef, sourceMarkdown } from "./sourceReferences";
import { downloadText } from "./export";
import type { SourceRef } from "./researchTypes";
import { validInkStroke, type InkStroke } from "./inkTypes";
import { validMedia, validOverlay } from "./notebookAssets";
const kinds = ["notebook", "notebook-section", "notebook-note", "notebook-overlay", "notebook-media", "ink-stroke", "research-thread", "research-message"] as const;
export function validResearchEntity(kind: string, v: any): boolean {
  if (!v || typeof v !== "object" || typeof v.id !== "string" || !v.id || v.id.length > 100 || typeof v.createdAt !== "string" || !Number.isFinite(Date.parse(v.createdAt))) return false;
  if (kind === "notebook") return typeof v.title === "string" && !!v.title.trim() && v.title.length <= 200;
  if (kind === "notebook-section") return typeof v.notebookId === "string" && typeof v.title === "string" && !!v.title.trim() && v.title.length <= 200 && Number.isFinite(v.order);
  if (kind === "ink-stroke") return validInkStroke(v);
  if (kind === "notebook-overlay") return validOverlay(v);
  if (kind === "notebook-media") return !v.purgedAt && validMedia(v);
  if (kind === "notebook-note") return typeof v.notebookId === "string" && (v.sectionId === undefined || typeof v.sectionId === "string") && (v.order === undefined || Number.isFinite(v.order)) && typeof v.title === "string" && !!v.title.trim() && v.title.length <= 200 && validRichDocument(v.document) && Array.isArray(v.tags) && v.tags.every((t: unknown) => typeof t === "string") && typeof v.updatedAt === "string" && Number.isFinite(Date.parse(v.updatedAt));
  if (kind === "research-thread") return typeof v.title === "string" && v.title.length <= 200 && (v.bookId === undefined || typeof v.bookId === "string") && (v.notebookId === undefined || typeof v.notebookId === "string") && (v.selection === undefined || validSourceRef(v.selection));
  if (kind === "research-message") return typeof v.threadId === "string" && typeof v.question === "string" && v.question.length <= 1500 && ["explain", "sources", "web"].includes(v.mode) && typeof v.answer === "string" && v.answer.length <= 12000 && typeof v.model === "string" && Array.isArray(v.sources) && v.sources.length <= 20 && v.sources.every(validSourceRef);
  return false;
}
export async function researchBackup() {
  const books = (await list("book")).map(({ id, hash }) => ({ id, hash }));
  const notebooks = await list("notebook"), threads = await list("research-thread"), notes = await list("notebook-note");
  const activeThreads = threads.filter(t => !t.notebookId || notebooks.some(n => n.id === t.notebookId));
  const records = (await Promise.all(kinds.map(async kind => (await list(kind)).filter(value => {
    if (kind === "notebook-note") return notebooks.some(n => n.id === (value as EntityMap["notebook-note"]).notebookId);
    if (kind === "notebook-media" || kind === "notebook-overlay") return notes.some(n => n.id === (value as EntityMap["notebook-media" | "notebook-overlay"]).noteId && notebooks.some(b => b.id === n.notebookId));
    if (kind === "notebook-section") return notebooks.some(n => n.id === (value as EntityMap["notebook-section"]).notebookId);
    if (kind === "ink-stroke") { const target = (value as EntityMap["ink-stroke"]).target; return target.type === "pdf" ? books.some(b => b.id === target.bookId && b.hash === target.hash) : notes.some(n => n.id === target.noteId && notebooks.some(b => b.id === n.notebookId)); }
    if (kind === "research-thread") return activeThreads.some(t => t.id === value.id);
    if (kind === "research-message") return activeThreads.some(t => t.id === (value as EntityMap["research-message"]).threadId);
    return true;
  }).map(value => ({ kind, value }))))).flat();
  return { schema: "leafmark.research", version: 3, exportedAt: new Date().toISOString(), books, records };
}
export async function restoreResearchBackup(value: unknown) {
  const data = value as Awaited<ReturnType<typeof researchBackup>>;
  if (!data || data.schema !== "leafmark.research" || ![1, 2, 3].includes(data.version) || !Array.isArray(data.records) || data.records.length > 200000 || !Array.isArray(data.books) ||
    !data.books.every(b => typeof b?.id === "string" && typeof b.hash === "string" && /^[a-f0-9]{64}$/.test(b.hash)) ||
    !data.records.every(r => kinds.includes(r?.kind) && validResearchEntity(r.kind, r.value))) throw new Error("This is not a valid Leafmark research backup.");
  const books = await list("book");
  const map = new Map(data.books.map(b => [b.id, books.find(current => current.hash === b.hash)?.id]));
  const source = (s: SourceRef): SourceRef => s.kind === "book" ? { ...s, bookId: map.get(s.bookId!) || `missing:${s.locator!.hash}` } : s;
  const document = (n: RichNode): RichNode => ({ ...n, ...(n.type === "citation" ? { attrs: { source: source(n.attrs!.source) } } : {}), ...(n.content ? { content: n.content.map(document) } : {}) });
  return db.transaction("rw", db.rows, db.outbox, db.conflicts, db.meta, async () => {
    let restored = 0, skipped = 0;
    for (const kind of kinds) for (const r of data.records.filter(r => r.kind === kind)) {
      if (await db.rows.get(`${kind}:${r.value.id}`)) { skipped++; continue; }
      const v: any = structuredClone(r.value);
      if (kind === "notebook-section" && !(await get("notebook", v.notebookId))) throw new Error("A section’s notebook is missing.");
      if (kind === "notebook-note") {
        if (!(await get("notebook", v.notebookId))) throw new Error("A note’s parent notebook is missing from the backup.");
        v.document = document(v.document);
      }
      if ((kind === "notebook-media" || kind === "notebook-overlay") && !(await get("notebook-note", v.noteId))) throw new Error("An attachment’s notebook page is missing.");
      if (kind === "research-thread") {
        if (v.notebookId && !(await get("notebook", v.notebookId))) throw new Error("A conversation’s parent notebook is missing.");
        if (v.bookId) v.bookId = map.get(v.bookId) || undefined;
        if (v.selection) v.selection = source(v.selection);
      }
      if (kind === "ink-stroke") {
        if (v.target.type === "pdf") { const bookId = map.get(v.target.bookId); if (!bookId) { skipped++; continue; } v.target.bookId = bookId; }
        else if (!(await get("notebook-note", v.target.noteId))) throw new Error("A drawing’s notebook page is missing.");
      }
      if (kind === "research-message") {
        if (!(await get("research-thread", v.threadId))) throw new Error("An answer’s conversation is missing.");
        v.sources = v.sources.map(source);
      }
      await save(kind as Kind, v as EntityMap[Kind]); restored++;
    }
    return { restored, skipped };
  });
}
export async function exportResearch(format: "json" | "md") {
  if (format === "json") { downloadText(`leafmark-research-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await researchBackup(), null, 2), "application/json"); return; }
  const notebooks = await list("notebook"), notes = await list("notebook-note"), threads = await list("research-thread"), messages = await list("research-message");
  const overlays = await list("notebook-overlay"), media = await list("notebook-media");
  let text = "# Leafmark notebooks and research\n\n";
  for (const notebook of notebooks) {
    text += `## ${notebook.title}\n\n`;
    for (const note of notes.filter(n => n.notebookId === notebook.id)) {
      text += `### ${note.title}\n\n${markdown(note.document).replace(/\]\(drawings\//g, `](drawings/${encodeURIComponent(note.id)}-`)}\n${note.tags.length ? `Tags: ${note.tags.join(", ")}\n\n` : ""}`;
      for (const drawing of overlays.filter(d => d.noteId === note.id)) text += `![Drawing](drawings/${encodeURIComponent(note.id)}-${drawing.id}.svg)\n\n`;
      for (const item of media.filter(m => m.noteId === note.id)) text += `Attachment: ${item.title.replace(/[<>\r\n]/g, " ")}\n\n`;
    }
  }
  for (const thread of threads) {
    text += `## Conversation: ${thread.title}\n\n`;
    for (const m of messages.filter(m => m.threadId === thread.id)) text += `### ${m.question}\n\n${m.answer}\n\n${m.sources.map(s => `- [${s.id}] ${sourceMarkdown(s)}`).join("\n")}\n\n`;
  }
  const strokes = (await list("ink-stroke")).filter(s => s.target.type === "notebook" && notes.some(n => n.id === (s.target.type === "notebook" ? s.target.noteId : "")));
  if (!strokes.length && !notes.some(n => JSON.stringify(n.document).includes('"drawing"'))) { downloadText(`leafmark-research-${new Date().toISOString().slice(0, 10)}.md`, text, "text/markdown"); return; }
  const [{ default: JSZip }, { inkPath }] = await Promise.all([import("jszip"), import("./ink")]);
  const zip = new JSZip(); zip.file("notebooks.md", text);
  for (const note of notes) {
    const blocks = new Set<string>();
    const walk = (n: RichNode) => { if (n.type === "drawing") blocks.add(n.attrs!.blockId); n.content?.forEach(walk); }; walk(note.document);
    const pageOverlays = new Set(overlays.filter(d => d.noteId === note.id).map(d => d.id));
    for (const id of pageOverlays) blocks.add(id);
    for (const id of blocks) {
      const group = strokes.filter(s => s.target.type === "notebook" && s.target.noteId === note.id && s.target.blockId === id);
      const content = group.map(s => `<path d="${inkPath(s)}" fill="${s.color}" opacity="${s.tool === "highlighter" ? .3 : 1}"/>`).join("");
      let viewBox = "0 0 1000 600";
      if (pageOverlays.has(id) && group.length) {
        let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
        for (const stroke of group) for (const [x, y] of stroke.points) {
          left = Math.min(left, x - stroke.width); top = Math.min(top, y - stroke.width);
          right = Math.max(right, x + stroke.width); bottom = Math.max(bottom, y + stroke.width);
        }
        viewBox = `${left} ${top} ${right - left} ${bottom - top}`;
      }
      zip.file(`drawings/${encodeURIComponent(note.id)}-${id}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${content}</svg>`);
    }
  }
  const blob = await zip.generateAsync({ type: "blob" }), url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = "leafmark-notebooks.zip"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export async function exportInkBackup(strokes: InkStroke[]) {
  const backup = await researchBackup(), ids = new Set(strokes.map(s => s.id));
  const notes = (await list("notebook-note")).filter(n => strokes.some(s => s.target.type === "notebook" && s.target.noteId === n.id));
  const groupIds = new Set(strokes.flatMap(s => s.target.type === "notebook" ? [s.target.blockId] : []));
  backup.records = backup.records.filter(r => r.kind === "ink-stroke" ? ids.has(r.value.id) : r.kind === "notebook-overlay" ? groupIds.has(r.value.id) : r.kind === "notebook-note" ? notes.some(n => n.id === r.value.id) : r.kind === "notebook" ? notes.some(n => n.notebookId === r.value.id) : r.kind === "notebook-section" ? notes.some(n => n.sectionId === r.value.id) : false);
  downloadText(`leafmark-drawings-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(backup, null, 2), "application/json");
}
