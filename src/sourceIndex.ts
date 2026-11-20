import { db, list } from "./db";
import { quoteAt, textNodes } from "./anchors";
import type { Book, Locator } from "./model";
import type { IndexedChunk, ResearchScope, SourceRef } from "./researchTypes";
import { ocrKey, textKey, validPageText, validWords } from "./pdfText";
import { downloadBook } from "./sync";

export type TextUnit = { unit: number; text: string; locator: Locator; title: string; missing?: boolean };
const extractionVersion = 2;
export type SectionMarker = { start: number; title: string };
export const sectionIndexKey = (book: Book) => `research-sections:${book.id}:${book.hash}`;
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
  let file = await db.files.get(book.id);
  if (!file) {
    try { file = await downloadBook(book); }
    catch { throw new Error(`Download “${book.title}” before researching its text.`); }
  }
  signal.throwIfAborted();
  if (book.format === "pdf") {
    const { pdfLibrary, pdfOptions } = await import("./pdf");
    const pdf = await pdfLibrary();
    const task = pdf.getDocument(pdfOptions(await file.source.arrayBuffer()));
    const abort = () => { void task.destroy(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const doc = await task.promise;
      await db.meta.put({ key: `pdf-page-count:${book.hash}`, value: String(doc.numPages) });
      const markers: SectionMarker[] = [];
      try {
        const outline = await doc.getOutline() || [];
        const entries = outline.length === 1 && outline[0].items.length ? outline[0].items : outline;
        for (const item of entries) {
          signal.throwIfAborted();
          const dest = typeof item.dest === "string" ? await doc.getDestination(item.dest) : item.dest;
          const target = dest?.[0];
          if (target == null) continue;
          const start = 1 + (typeof target === "number" ? target : await doc.getPageIndex(target));
          if (start <= doc.numPages && item.title.trim()) markers.push({ start, title: item.title.trim().slice(0, 200) });
        }
      } catch (e) { if (signal.aborted) throw e; }
      await db.meta.put({ key: sectionIndexKey(book), value: JSON.stringify(markers) });
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
    const nodes = textNodes(root), markers: SectionMarker[] = [];
    let offset = 0, previous: Element | null | undefined;
    for (const node of nodes) {
      const heading = node.parentElement?.closest("h1,h2,h3");
      if (heading && heading !== previous && heading.textContent?.trim()) markers.push({ start: offset, title: heading.textContent.trim().slice(0, 200) });
      previous = heading;
      offset += node.length;
    }
    await db.meta.put({ key: sectionIndexKey(book), value: JSON.stringify(markers) });
    const text = nodes.map(n => n.data).join("");
    yield { unit: 0, text, title: book.title, locator: { v: 1, type: "docx", hash: book.hash, start: 0, end: Math.min(100, text.length) } };
  } else {
    const { default: ePub } = await import("epubjs");
    const epub = ePub(await file.source.arrayBuffer());
    try {
      await epub.ready;
      const sections: any[] = [];
      epub.spine.each((section: any) => sections.push(section));
      const markers: SectionMarker[] = startUnit ? JSON.parse((await db.meta.get(sectionIndexKey(book)))?.value || "[]") : [];
      for (let i = startUnit; i < sections.length; i++) {
        signal.throwIfAborted();
        const section = sections[i];
        await section.load(epub.load.bind(epub));
        const root = section.document.body as HTMLElement;
        root.querySelectorAll("script,style,iframe,object,embed,form").forEach(el => el.remove());
        const heading = root.querySelector("h1,h2,h3")?.textContent?.trim();
        markers[i] = { start: i, title: heading?.slice(0, 200) || `Section ${i + 1}` };
        await db.meta.put({ key: sectionIndexKey(book), value: JSON.stringify(markers) });
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

const activeIndexes = new Map<string, { signal: AbortSignal; task: Promise<number> }>();
export function indexBook(book: Book, signal: AbortSignal, progress?: (message: string) => void): Promise<number> {
  const existing = activeIndexes.get(book.id);
  if (existing) return existing.task.catch(error => {
    signal.throwIfAborted();
    if (!existing.signal.aborted) throw error;
    return indexBook(book,signal,progress);
  });
  const task = (async () => {
    const key = `text-index:${book.id}`;
    let state = { hash: book.hash, version: extractionVersion, next: 0, missing: 0, complete: false };
    try { const cached = JSON.parse((await db.meta.get(key))?.value || "null");
      if (cached?.hash === book.hash && cached?.version === extractionVersion) state = cached;
      else await db.chunks.where("bookId").equals(book.id).delete();
    } catch { await db.chunks.where("bookId").equals(book.id).delete(); }
    // Recheck previously blank scanned pages: new local OCR may now be cached.
    if (state.complete && !state.missing) { progress?.("Text ready on this device"); return 0; }
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
    return state.missing;
  })().finally(() => activeIndexes.delete(book.id));
  activeIndexes.set(book.id, { signal,task });
  return task;
}
const ignored = new Set("the a an and or to of in is it this that what how why are does do from with about explain me my".split(" "));
function rankText<T>(query: string, items: T[], getText: (item: T) => string, limit: number): T[] {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])].filter(t => !ignored.has(t));
  if (!terms.length) return [];
  const wanted = new Set(terms);
  const frequencies = new Map<string, number>();
  let totalLength = 0;
  const docs = items.map(item => {
    const tokens = getText(item).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    totalLength += tokens.length;
    const counts = new Map<string, number>();
    for (const token of tokens) {
      if (wanted.has(token)) counts.set(token, (counts.get(token) || 0) + 1);
    }
    for (const term of counts.keys()) frequencies.set(term, (frequencies.get(term) || 0) + 1);
    return { item, counts, length: tokens.length };
  });
  const average = totalLength / Math.max(1, docs.length);
  return docs.map(({ item, counts, length }) => {
    const score = terms.reduce((sum, term) => {
      const f = counts.get(term) || 0, df = frequencies.get(term) || 0;
      return sum + Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)) * f * 2.2 / (f + 1.2 * (0.25 + 0.75 * length / Math.max(1, average)));
    }, 0);
    return { item, score };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(({ item }) => item);
}

export function rankChunks(query: string, chunks: IndexedChunk[], limit = 6): SourceRef[] {
  return rankText(query, chunks, chunk => chunk.text, limit).map((chunk, i) => ({
    id: `S${i + 1}`, kind: "book", title: chunk.title, excerpt: chunk.text, bookId: chunk.bookId, locator: chunk.locator,
  }));
}

async function personalSources(noteIds: string[], highlightIds: string[], full = false) {
  const [notes, annotated, followups] = await Promise.all([
    noteIds.length ? list("notebook-note") : [],
    highlightIds.length ? list("annotation") : [],
    highlightIds.length && !full ? list("highlight-followup") : [],
  ]);
  const { plainText } = await import("./richText");
  const selected = new Set(highlightIds);
  const refs: SourceRef[] = notes.filter(n => noteIds.includes(n.id))
    .map(n => ({ id: `N${n.id}`, kind: "note", noteId: n.id, title: n.title, excerpt: full ? plainText(n.document) : plainText(n.document).slice(0, 1500) }));
  const highlights: SourceRef[] = annotated.filter(a => selected.has(a.id) && a.type !== "page-note")
    .map(a => ({ id: `A${a.id}`, kind: "book", bookId: a.bookId, annotationId: a.id, title: `Highlight: ${a.text.slice(0, 80)}`,
      excerpt: full ? a.text : [a.text, a.note, ...followups.filter(note => note.annotationId === a.id).map(note => note.text)].filter(Boolean).join("\n\n").slice(0, 1800), locator: a.locator }));
  return [...highlights, ...refs].filter(ref => ref.excerpt.trim());
}

export function scopedChunks(chunks: IndexedChunk[], ranges: ResearchScope["ranges"]): IndexedChunk[] {
  if (!ranges?.length) return chunks;
  return chunks.flatMap(chunk => {
    const loc = chunk.locator;
    if (loc.type !== "docx") return inBookRange(chunk,ranges) ? [chunk] : [];
    const limits = ranges.filter(r => r.bookId === chunk.bookId);
    if (!limits.length) return [chunk];
    return limits.flatMap(r => {
      const start = Math.max(loc.start,r.start), end = Math.min(loc.start + chunk.text.length,r.end + 1);
      if (start >= end) return [];
      const text = chunk.text.slice(start - loc.start,end - loc.start);
      return [{ ...chunk,text,locator:{ ...loc,start,end,quote:quoteAt(text,0,Math.min(100,text.length)) } }];
    });
  });
}
export function inBookRange(chunk: IndexedChunk, ranges: ResearchScope["ranges"]) {
  const limits = ranges?.filter(range => range.bookId === chunk.bookId);
  const unit = chunk.locator.type === "docx" ? chunk.locator.start : chunk.unit;
  return !limits?.length || limits.some(r => unit >= r.start && unit <= r.end);
}
async function currentBookChunks(books: Book[]) {
  if (!books.length) return [];
  const editions = new Map(books.map(book => [book.id, book.hash]));
  const chunks = await db.chunks.where("bookId").anyOf([...editions.keys()]).toArray();
  return chunks.filter(chunk => editions.get(chunk.bookId) === chunk.hash);
}

export async function searchPreparedPassages(query: string, books: Book[], scope: ResearchScope, signal?: AbortSignal) {
  const [chunks, personal] = await Promise.all([currentBookChunks(books), personalSources(scope.noteIds, scope.highlightIds, true)]);
  const indexed = new Map<string, Set<number>>();
  for (const chunk of chunks) {
    const pages = indexed.get(chunk.bookId) || new Set<number>();
    pages.add(chunk.unit);
    indexed.set(chunk.bookId, pages);
  }
  for (const book of books) {
    signal?.throwIfAborted();
    if (book.format !== "pdf") continue;
    const pages = indexed.get(book.id);
    const prefixes = [textKey(book, 0).slice(0, -1), ocrKey(book, 0).slice(0, -1)];
    const cached = new Map<number, string>();
    for (const [kind, prefix] of prefixes.entries()) {
      await db.meta.where("key").startsWith(prefix).each(row => {
        const page = Number(row.key.slice(prefix.length));
        if (!Number.isSafeInteger(page) || page < 1 || pages?.has(page) || cached.has(page)) return;
        try {
          const value: unknown = JSON.parse(row.value);
          const text = kind === 0 && validPageText(value) ? value.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("")
            : kind === 1 && validWords(value) ? value.map(word => word.text).join(" ") : "";
          if (text.trim()) cached.set(page, text);
        } catch { /* Malformed cache entries are skipped. */ }
      });
      signal?.throwIfAborted();
    }
    for (const [page, text] of cached) chunks.push(...splitUnit(book, {
      unit: page, text, title: book.title, locator: { v: 1, type: "pdf", hash: book.hash, page, y: 0 },
    }));
  }
  const passages = personal.flatMap(source => {
    if (source.kind !== "note" || source.excerpt.length <= 1800) return [source];
    const excerpts: SourceRef[] = [];
    for (let start = 0; start < source.excerpt.length; start += 1500) {
      excerpts.push({ ...source, id: `${source.id}:${start}`, excerpt: source.excerpt.slice(start, start + 1800) });
    }
    return excerpts;
  });
  const ranked = rankText(query, [...scopedChunks(chunks,scope.ranges).map(chunkSource), ...passages], source => source.excerpt, 12 + passages.length - personal.length);
  const seenNotes = new Set<string>();
  const hits = ranked.filter(source => {
    if (!source.noteId) return true;
    if (seenNotes.has(source.noteId)) return false;
    seenNotes.add(source.noteId);
    return true;
  }).slice(0, 12);
  return { hits, indexedBooks: new Set(chunks.map(chunk => chunk.bookId)) };
}

export async function retrieveSources(query: string, bookIds: string[], noteIds: string[] = [], highlightIds: string[] = [], studyBooks?: Book[], ranges?: ResearchScope["ranges"]) {
  const [chunks, personal, annotated] = await Promise.all([
    studyBooks ? currentBookChunks(studyBooks) : db.chunks.where("bookId").anyOf(bookIds).toArray(),
    personalSources(noteIds, highlightIds),
    !studyBooks && bookIds.length ? list("annotation") : [],
  ]);
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
  const annotations: SourceRef[] = annotated.filter(a => !highlightIds.includes(a.id) && bookIds.includes(a.bookId) && a.note && terms.some(t => `${a.text} ${a.note}`.toLowerCase().includes(t))).slice(0, 2)
    .map(a => ({ id: `A${a.id}`, kind: "book", bookId: a.bookId, title: `Reader note: ${a.text.slice(0, 80)}`, excerpt: `${a.text}\n${a.note}`.slice(0, 1500), locator: a.locator }));
  const books = bookIds.map(bookId => {
    const local = scopedChunks(chunks.filter(chunk => chunk.bookId === bookId), ranges);
    const ranked = rankChunks(query, local, 7);
    if (ranked.length || !local.length) return ranked;
    const middle = Math.floor(local.length / 2);
    return [...new Set([middle, Math.floor(local.length / 5), Math.floor(local.length * .8)])].map(index => chunkSource(local[index]));
  });
  const first = books.flatMap(refs => refs.slice(0, 1));
  const more = books.flatMap(refs => refs.slice(1));
  return [...first, ...personal, ...annotations, ...more].filter(ref => !!ref.excerpt.trim()).slice(0, 7)
    .map((ref, i) => ({ ...ref, id: `S${i + 1}` }));
}

export function chunkSource(chunk: IndexedChunk): SourceRef {
  return { id: chunk.id.slice(0, 200), kind: "book", bookId: chunk.bookId, title: chunk.title, locator: chunk.locator, excerpt: chunk.text };
}

export async function comparisonSources(
  question: string, bookIds: string[], signal: AbortSignal, progress: (message: string) => void,
) {
  const books = await list("book");
  const perBook: SourceRef[][] = [];
  for (const id of bookIds) {
    signal.throwIfAborted();
    const book = books.find(book => book.id === id);
    if (!book) continue;
    try { await indexBook(book, signal, progress); }
    catch { signal.throwIfAborted(); }
    const chunks = (await db.chunks.where("bookId").equals(id).toArray()).filter(chunk => chunk.hash === book.hash);
    perBook.push(rankChunks(question, chunks, 3));
  }
  // Give each book evidence before allocating extra passages from any book.
  return [0, 1, 2].flatMap(i => perBook.flatMap(refs => refs[i] ? [refs[i]] : [])).slice(0, 7)
    .map((source, i) => ({ ...source, id: `S${i + 1}` }));
}
