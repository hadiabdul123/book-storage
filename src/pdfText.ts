import type { PDFPageProxy, TextContent } from "pdfjs-dist/types/src/display/api";
import { db } from "./db";
import type { Book, Rect } from "./model";
import { normalizeRect } from "./anchors";
import type { PageOcr } from "./reader/ocr";

export type OcrWord = { text: string; rect: Rect };
type Edition = Pick<Book, "id" | "hash">;
export const pdfPageCountPrefix = "pdf-page-count:";
export const pdfPageCountKey = (hash: string) => pdfPageCountPrefix + hash;
export const ocrKey = (book: Edition, page: number) => `ocr-v2:${book.id}:${book.hash}:${page}`;
export const textKey = (book: Edition, page: number) => `pdf-text-v1:${book.id}:${book.hash}:${page}`;
export const preparationKey = (book: Edition) => `pdf-preparation:${book.id}:${book.hash}`;
export async function savePageCache(book: Edition, rows: { key: string; value: string }[]) {
  return db.transaction("rw", [db.rows, db.meta], async () => {
    const row = await db.rows.get(`book:${book.id}`);
    if (!row || row.deleted || (row.value as Book).hash !== book.hash) return false;
    await db.meta.bulkPut(rows); return true;
  });
}
export function validPageText(value: any): value is TextContent {
  return Array.isArray(value?.items) && value.styles && typeof value.styles === "object" &&
    value.items.every((item: any) => item && (typeof item.str === "string" ?
      typeof item.fontName === "string" && Array.isArray(item.transform) && item.transform.length === 6 && item.transform.every(Number.isFinite) &&
      Number.isFinite(item.width) && Number.isFinite(item.height) : ["beginMarkedContent", "beginMarkedContentProps", "endMarkedContent"].includes(item.type)));
}
export function validWords(value: unknown): value is OcrWord[] {
  return Array.isArray(value) && value.every(w => typeof w?.text === "string" &&
    Array.isArray(w.rect) && w.rect.length === 4 && w.rect.every(Number.isFinite));
}
export async function savedOcr(book: Edition, page: number): Promise<OcrWord[] | undefined> {
  const row = await db.meta.get(ocrKey(book, page)) || await db.meta.get(`ocr-v1:${book.id}:${page}`);
  try { const words: unknown = JSON.parse(row?.value || "null"); return validWords(words) ? words : undefined; }
  catch { return undefined; }
}
const extracting = new Map<string, Promise<TextContent>>();
const cancelled = (error: any) => ["AbortError", "AbortException", "RenderingCancelledException"].includes(error?.name) ||
  /reader closed|worker was (?:destroyed|terminated)/i.test(error?.message || "");
/** Persist the PDF's own text too: resizing and reopening need no re-extraction. */
export function pageText(book: Edition, page: PDFPageProxy): Promise<TextContent> {
  const key = textKey(book, page.pageNumber);
  const existing = extracting.get(key);
  if (existing) return existing.catch(error => {
    // A different PDF owner may have closed while we shared its extraction.
    if (cancelled(error)) return pageText(book, page);
    throw error;
  });
  const task = (async () => {
    const row = await db.meta.get(key);
    try {
      const value = JSON.parse(row?.value || "null");
      if (validPageText(value)) return value;
    } catch { /* Rebuild an incomplete cache entry. */ }
    const content = await page.getTextContent();
    // A full cache must not prevent the original document from being read.
    await savePageCache(book, [{ key, value: JSON.stringify(content) }]).catch(() => {});
    return content;
  })().finally(() => extracting.delete(key));
  extracting.set(key, task);
  return task;
}
export const hasPageText = (text: TextContent) => text.items.some(item => "str" in item && !!item.str.trim());
const recognizing = new Map<string, Promise<OcrWord[] | undefined>>();
/** A library job and an opening reader share any page already in flight. */
export function preparePageText(book: Edition, page: PDFPageProxy, ocr: PageOcr,
  progress: (percent: number) => void = () => {}, check: () => void = () => {}): Promise<OcrWord[] | undefined> {
  const key = ocrKey(book, page.pageNumber);
  const existing = recognizing.get(key);
  if (existing) return existing.catch(error => {
    // The joining caller has its own page/worker and cancellation check. Only
    // an abandoned owner's job is retried, never a genuine recognition error.
    if (cancelled(error)) { check(); return preparePageText(book, page, ocr, progress, check); }
    throw error;
  });
  const task = (async () => {
    const cached = await savedOcr(book, page.pageNumber);
    if (cached !== undefined) { await pageText(book, page); return cached; }
    check();
    if (hasPageText(await pageText(book, page))) return undefined;
    check();
    const canvas = document.createElement("canvas");
    try {
      const base = page.getViewport({ scale: 1, rotation: 0 });
      const viewport = page.getViewport({ scale: Math.min(2.5, 1800 / base.width, 2400 / base.height), rotation: 0 });
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;
      check();
      const words = (await ocr.recognize(canvas, progress)).map(({ text, box }) => {
        const a = viewport.convertToPdfPoint(box.x0, box.y0), b = viewport.convertToPdfPoint(box.x1, box.y1);
        return { text, rect: normalizeRect([a[0], a[1], b[0], b[1]]) };
      });
      // Finish saving an in-flight page even if the library was just left.
      await savePageCache(book, [{ key, value: JSON.stringify(words) }]);
      return words;
    } finally { canvas.width = canvas.height = 0; }
  })().finally(() => recognizing.delete(key));
  recognizing.set(key, task);
  return task;
}
