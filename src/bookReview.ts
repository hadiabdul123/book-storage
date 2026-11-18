import { db } from "./db";
import type { Book } from "./model";
import type { IndexedChunk, SourceRef } from "./researchTypes";
import { chunkSource, indexBook, sectionIndexKey, type SectionMarker } from "./sourceIndex";

export const reviewBatchSize = 6;
export type ReviewSection = { id: string; book: Book; label: string; excerpts: number; sources: SourceRef[] };
export function reviewQuestion(section: ReviewSection, focus: string) {
  return `Review ${section.label.slice(0, 160)} from “${section.book.title.slice(0, 150)}”. Explain its main ideas, key examples and open questions. Cite the supplied excerpts and flag gaps in coverage.${focus.trim() ? ` Focus on: ${focus.trim().slice(0, 900)}` : ""}`;
}

export async function planBookReview(books: Book[], signal: AbortSignal, progress: (text: string) => void) {
  const sections: ReviewSection[] = [];
  for (const book of books) {
    await indexBook(book, signal, progress);
    signal.throwIfAborted();
    const chunks = (await db.chunks.where("bookId").equals(book.id).toArray()).filter(chunk => chunk.hash === book.hash);
    const position = (chunk: IndexedChunk) => chunk.locator.type === "docx" ? chunk.locator.start : chunk.unit;
    chunks.sort((a, b) => position(a) - position(b) || Number(a.id.split(":").at(-1)) - Number(b.id.split(":").at(-1)));
    const initial = book.format === "pdf" ? 1 : 0;
    const pageCount = book.format === "pdf" ? Number((await db.meta.get(`pdf-page-count:${book.hash}`))?.value) : 0;
    const final = Number.isSafeInteger(pageCount) && pageCount > 0 ? pageCount : (chunks.length ? position(chunks.at(-1)!) : initial);
    const stored: SectionMarker[] = JSON.parse((await db.meta.get(sectionIndexKey(book)))?.value || "[]");
    const markers = stored.filter(marker => marker && typeof marker.title === "string" && Number.isInteger(marker.start) && marker.start >= initial)
      .sort((a, b) => a.start - b.start).filter((marker, i, all) => !i || marker.start !== all[i - 1].start);
    if (!markers.length) {
      const step = book.format === "pdf" ? 12 : book.format === "docx" ? 12000 : 1;
      for (let start = initial; start <= final; start += step) {
        const end = Math.min(final, start + step - 1);
        markers.push({ start, title: book.format === "pdf" ? start === end ? `Page ${start}` : `Pages ${start}–${end}` : `Section ${1 + markers.length}` });
      }
    }
    if (markers[0]?.start > initial) markers.unshift({ start: initial, title: "Opening pages" });
    let cursor = 0;
    for (const [i, marker] of markers.entries()) {
      const end = markers[i + 1]?.start ?? Infinity;
      const begin = cursor;
      while (cursor < chunks.length && position(chunks[cursor]) < end) cursor++;
      const count = cursor - begin;
      const sample: SourceRef[] = [];
      const take = Math.min(count, 7);
      for (let slot = 0; slot < take; slot++) {
        const chunk = chunks[begin + (take === 1 ? 0 : Math.round(slot * (count - 1) / (take - 1)))];
        sample.push({ ...chunkSource(chunk), id: `S${slot + 1}`, title: `${book.title} · ${marker.title}`.slice(0, 1000) });
      }
      sections.push({ id: `${book.id}:${marker.start}`, book, label: marker.title, excerpts: count, sources: sample });
    }
  }
  return sections;
}
