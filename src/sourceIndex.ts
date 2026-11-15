import { db, list } from "./db";
import { quoteAt, textNodes } from "./anchors";
import type { Book, Locator } from "./model";
import type { IndexedChunk, SourceRef } from "./researchTypes";

export type TextUnit = { unit: number; text: string; locator: Locator; title: string; missing?: boolean };
const extractionVersion = 1;
export function splitUnit(book: Book, unit: TextUnit): IndexedChunk[] {
  const result: IndexedChunk[] = [];
  for (let start = 0; start < unit.text.length; start += 1000) {
    const text = unit.text.slice(start, start + 1200);
    if (!text.trim()) continue;
    const locator: Locator = { ...unit.locator, quote: quoteAt(unit.text, start, Math.min(start + 100, unit.text.length)) };
    if (locator.type === "docx") { locator.start = start; locator.end = start + Math.min(text.length, 100); }
    result.push({ id: `${book.id}:${unit.unit}:${start}`, bookId: book.id, hash: book.hash, unit: unit.unit, text, locator, title: unit.title });
  }
  return result;
}
export function surroundingText(text: string, selected: string, fallback = "") {
  text = text.replace(/\s+/g, " "); selected = selected.replace(/\s+/g, " ");
  const at = text.indexOf(selected);
  return at >= 0 ? text.slice(Math.max(0, at - 600), Math.min(text.length, at + selected.length + 600)) : fallback || selected;
}

/** Extract without a rendition or OCR job. Read just one page/section per turn. */
export async function* extractBookText(book: Book, signal: AbortSignal, startUnit = 0): AsyncGenerator<TextUnit> {
  const file = await db.files.get(book.id);
  if (!file) throw new Error(`Download “${book.title}” before researching its text.`);
  if (book.format === "pdf") {
    const { pdfLibrary, pdfOptions } = await import("./pdf");
    const pdf = await pdfLibrary();
    const task = pdf.getDocument(pdfOptions(await file.source.arrayBuffer()));
    const abort = () => { void task.destroy(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const doc = await task.promise;
      await db.meta.put({ key: `pdf-page-count:${book.hash}`, value: String(doc.numPages) });
      for (let n = Math.max(1, startUnit); n <= doc.numPages; n++) {
        signal.throwIfAborted();
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        let text = content.items.map(i => "str" in i ? i.str + (i.hasEOL ? "\n" : " ") : "").join("");
        if (!text.trim()) {
          const cached = await db.meta.get(`ocr-v2:${book.id}:${book.hash}:${n}`) || await db.meta.get(`ocr-v1:${book.id}:${n}`);
          try {
            const words = JSON.parse(cached?.value || "null");
            // OCR cache is versioned JSON, not a reason to trigger recognition.
            const rows = Array.isArray(words) ? words : words?.words;
            if (Array.isArray(rows)) text = rows.map(w => typeof w.text === "string" ? w.text : "").join(" ");
          } catch { /* A bad cache leaves this page unindexed. */ }
        }
        yield { unit: n, text, title: book.title, locator: { v: 1, type: "pdf", hash: book.hash, page: n, y: 0 }, missing: !text.trim() };
        page.cleanup();
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } finally { signal.removeEventListener("abort", abort); await task.destroy(); }
  } else if (book.format === "docx") {
    if (!file.derived) throw new Error("The converted document is missing. Download this book again.");
    const { sanitize } = await import("./import");
    const root = document.createElement("article");
    root.innerHTML = sanitize(await file.derived.text());
    const text = textNodes(root).map(n => n.data).join("");
    yield { unit: 0, text, title: book.title, locator: { v: 1, type: "docx", hash: book.hash, start: 0, end: Math.min(100, text.length) } };
  } else {
    const { default: ePub } = await import("epubjs");
    const epub = ePub(await file.source.arrayBuffer());
    try {
      await epub.ready;
      const sections: any[] = [];
      epub.spine.each((section: any) => sections.push(section));
      for (let i = startUnit; i < sections.length; i++) {
        signal.throwIfAborted();
        const section = sections[i];
        await section.load(epub.load.bind(epub));
        const root = section.document.body as HTMLElement;
        root.querySelectorAll("script,style,iframe,object,embed,form").forEach(el => el.remove());
        const nodes = textNodes(root);
        const text = nodes.map(n => n.data).join("");
        const range = section.document.createRange() as Range;
        if (nodes[0]) { range.setStart(nodes[0], 0); range.collapse(true); }
        else range.selectNodeContents(root);
        yield { unit: i, text, title: book.title, missing: !text.trim(), locator: { v: 1, type: "epub", hash: book.hash, cfi: section.cfiFromRange(range), href: section.href } };
        section.unload();
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } finally { epub.destroy(); }
  }
}

const activeIndexes = new Map<string, Promise<void>>();
export function indexBook(book: Book, signal: AbortSignal, progress?: (message: string) => void): Promise<void> {
  const existing = activeIndexes.get(book.id);
  if (existing) return existing;
  const task = (async () => {
    const key = `text-index:${book.id}`;
    let state = { hash: book.hash, version: extractionVersion, next: 0, missing: 0, complete: false };
    try { const cached = JSON.parse((await db.meta.get(key))?.value || "null");
      if (cached?.hash === book.hash && cached?.version === extractionVersion) state = cached;
      else await db.chunks.where("bookId").equals(book.id).delete();
    } catch { await db.chunks.where("bookId").equals(book.id).delete(); }
    // Recheck previously blank scanned pages: new local OCR may now be cached.
    if (state.complete && !state.missing) { progress?.("Text ready on this device"); return; }
    if (state.complete) state = { ...state, next: 0, missing: 0, complete: false };
    for await (const unit of extractBookText(book, signal, state.next)) {
      signal.throwIfAborted();
      state.next = unit.unit + 1;
      if (unit.missing) state.missing++;
      await db.transaction("rw", db.chunks, db.meta, async () => {
        await db.chunks.where("[bookId+unit]").equals([book.id, unit.unit]).delete();
        await db.chunks.bulkPut(splitUnit(book, unit));
        await db.meta.put({ key, value: JSON.stringify(state) });
      });
      progress?.(`Preparing ${book.title}: ${book.format === "pdf" ? "page" : "section"} ${unit.unit + (book.format === "pdf" ? 0 : 1)}`);
    }
    state.complete = true;
    await db.meta.put({ key, value: JSON.stringify(state) });
    progress?.(state.missing ? `Text ready; ${state.missing} blank or scanned pages/sections have no cached text` : "Text ready on this device");
  })().finally(() => activeIndexes.delete(book.id));
  activeIndexes.set(book.id, task);
  return task;
}
const ignored = new Set("the a an and or to of in is it this that what how why are does do from with about explain me my".split(" "));
export function rankChunks(query: string, chunks: IndexedChunk[], limit = 6): SourceRef[] {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])].filter(t => !ignored.has(t));
  if (!terms.length) return [];
  const docs = chunks.map(chunk => ({ chunk, tokens: (chunk.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) as string[] }));
  const average = docs.reduce((n, d) => n + d.tokens.length, 0) / Math.max(1, docs.length);
  const frequencies = new Map(terms.map(term => [term, docs.filter(d => d.tokens.includes(term)).length]));
  return docs.map(({ chunk, tokens }) => {
    const counts = new Map<string, number>();
    tokens.forEach(t => counts.set(t, (counts.get(t) || 0) + 1));
    const score = terms.reduce((sum, term) => {
      const f = counts.get(term) || 0, df = frequencies.get(term) || 0;
      return sum + Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)) * f * 2.2 / (f + 1.2 * (0.25 + 0.75 * tokens.length / Math.max(1, average)));
    }, 0);
    return { chunk, score };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(({ chunk }, i) => ({
    id: `S${i + 1}`, kind: "book", title: chunk.title, excerpt: chunk.text, bookId: chunk.bookId, locator: chunk.locator,
  }));
}
export async function retrieveSources(query: string, bookIds: string[], noteIds: string[] = []) {
  const chunks = await db.chunks.where("bookId").anyOf(bookIds).toArray();
  const notes = (await list("notebook-note")).filter(n => noteIds.includes(n.id));
  const { plainText } = await import("./richText");
  const ranked = rankChunks(query, chunks);
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
  const refs: SourceRef[] = notes.slice(0, 3)
    .map(n => ({ id: `N${n.id}`, kind: "note", noteId: n.id, title: n.title, excerpt: plainText(n.document).slice(0, 1500) }));
  const annotations: SourceRef[] = (await list("annotation")).filter(a => bookIds.includes(a.bookId) && a.note && terms.some(t => `${a.text} ${a.note}`.toLowerCase().includes(t))).slice(0, 2)
    .map(a => ({ id: `A${a.id}`, kind: "book", bookId: a.bookId, title: `Reader note: ${a.text.slice(0, 80)}`, excerpt: `${a.text}\n${a.note}`.slice(0, 1500), locator: a.locator }));
  return [...refs, ...annotations, ...ranked].slice(0, 7);
}
