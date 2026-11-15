import { db, get, list, save } from "./db";
import type { EntityMap, Kind, RichNode } from "./model";
import { validRichDocument, markdown } from "./richText";
import { validSourceRef, sourceMarkdown } from "./sourceReferences";
import { downloadText } from "./export";
import type { SourceRef } from "./researchTypes";
const kinds = ["notebook", "notebook-note", "research-thread", "research-message"] as const;
export function validResearchEntity(kind: string, v: any): boolean {
  if (!v || typeof v !== "object" || typeof v.id !== "string" || !v.id || v.id.length > 100 || typeof v.createdAt !== "string" || !Number.isFinite(Date.parse(v.createdAt))) return false;
  if (kind === "notebook") return typeof v.title === "string" && !!v.title.trim() && v.title.length <= 200;
  if (kind === "notebook-note") return typeof v.notebookId === "string" && typeof v.title === "string" && !!v.title.trim() && v.title.length <= 200 && validRichDocument(v.document) && Array.isArray(v.tags) && v.tags.every((t: unknown) => typeof t === "string") && typeof v.updatedAt === "string" && Number.isFinite(Date.parse(v.updatedAt));
  if (kind === "research-thread") return typeof v.title === "string" && v.title.length <= 200 && (v.bookId === undefined || typeof v.bookId === "string") && (v.notebookId === undefined || typeof v.notebookId === "string") && (v.selection === undefined || validSourceRef(v.selection));
  if (kind === "research-message") return typeof v.threadId === "string" && typeof v.question === "string" && v.question.length <= 1500 && ["explain", "sources", "web"].includes(v.mode) && typeof v.answer === "string" && v.answer.length <= 12000 && typeof v.model === "string" && Array.isArray(v.sources) && v.sources.length <= 20 && v.sources.every(validSourceRef);
  return false;
}
export async function researchBackup() {
  const books = (await list("book")).map(({ id, hash }) => ({ id, hash }));
  const notebooks = await list("notebook"), threads = await list("research-thread");
  const activeThreads = threads.filter(t => !t.notebookId || notebooks.some(n => n.id === t.notebookId));
  const records = (await Promise.all(kinds.map(async kind => (await list(kind)).filter(value => {
    if (kind === "notebook-note") return notebooks.some(n => n.id === (value as EntityMap["notebook-note"]).notebookId);
    if (kind === "research-thread") return activeThreads.some(t => t.id === value.id);
    if (kind === "research-message") return activeThreads.some(t => t.id === (value as EntityMap["research-message"]).threadId);
    return true;
  }).map(value => ({ kind, value }))))).flat();
  return { schema: "leafmark.research", version: 1, exportedAt: new Date().toISOString(), books, records };
}
export async function restoreResearchBackup(value: unknown) {
  const data = value as Awaited<ReturnType<typeof researchBackup>>;
  if (!data || data.schema !== "leafmark.research" || data.version !== 1 || !Array.isArray(data.records) || data.records.length > 20000 || !Array.isArray(data.books) ||
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
      if (kind === "notebook-note") {
        if (!(await get("notebook", v.notebookId))) throw new Error("A note’s parent notebook is missing from the backup.");
        v.document = document(v.document);
      }
      if (kind === "research-thread") {
        if (v.notebookId && !(await get("notebook", v.notebookId))) throw new Error("A conversation’s parent notebook is missing.");
        if (v.bookId) v.bookId = map.get(v.bookId) || undefined;
        if (v.selection) v.selection = source(v.selection);
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
  let text = "# Leafmark notebooks and research\n\n";
  for (const notebook of notebooks) {
    text += `## ${notebook.title}\n\n`;
    for (const note of notes.filter(n => n.notebookId === notebook.id)) text += `### ${note.title}\n\n${markdown(note.document)}\n${note.tags.length ? `Tags: ${note.tags.join(", ")}\n\n` : ""}`;
  }
  for (const thread of threads) {
    text += `## Conversation: ${thread.title}\n\n`;
    for (const m of messages.filter(m => m.threadId === thread.id)) text += `### ${m.question}\n\n${m.answer}\n\n${m.sources.map(s => `- [${s.id}] ${sourceMarkdown(s)}`).join("\n")}\n\n`;
  }
  downloadText(`leafmark-research-${new Date().toISOString().slice(0, 10)}.md`, text, "text/markdown");
}
