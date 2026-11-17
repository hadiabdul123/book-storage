import { db, get, save } from "./db";
import type { Book } from "./model";
import { hasPageText, ocrKey, preparationKey, savedOcr, textKey, validWords, validPageText, savePageCache } from "./pdfText";

const digest = async (data: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)))
  .map(byte => byte.toString(16).padStart(2, "0")).join("");
export function validPreparedPath(book: Book) {
  return !!book.preparedTextPath && book.preparedTextPath.startsWith(`${book.id}/text-v1-`) &&
    /^[a-f0-9]{64}\.ndjson\.gz$/.test(book.preparedTextPath.slice(`${book.id}/text-v1-`.length));
}
/** Package completed pages incrementally; never build one giant parsed book. */
export async function publishPreparedText(book: Book, total: number) {
  const parts: BlobPart[] = [JSON.stringify({ v: 1, hash: book.hash, total }) + "\n"];
  let size = 0;
  for (let n = 1; n <= total; n++) {
    const text = await db.meta.get(textKey(book, n));
    if (!text) throw new Error("Some book text is not prepared yet.");
    const words = await savedOcr(book, n);
    const line = `{"page":${n},"text":${text.value},"words":${JSON.stringify(words ?? null)}}\n`;
    size += line.length;
    if (size > 120_000_000 || line.length > 4_000_000) throw new Error("Text is saved on this device, but this book is too large to sync its prepared text.");
    parts.push(line);
    if (n % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  const packed = await new Response(new Blob(parts).stream().pipeThrough(new CompressionStream("gzip"))).blob();
  const data = await packed.arrayBuffer();
  const path = `${book.id}/text-v1-${await digest(data)}.ndjson.gz`;
  await db.transaction("rw", [db.files, db.rows, db.outbox, db.conflicts, db.meta], async () => {
    const current = await get("book", book.id);
    if (!current || current.hash !== book.hash || !(await db.files.get(book.id))) return;
    // Bytes work in WebKit and this updates neither the original nor its upload flag.
    await db.files.update(book.id, { preparedText: { data, type: "application/gzip" } as unknown as Blob,
      preparedTextPath: path, preparedTextUploaded: false });
    await db.meta.put({ key: `prepared-text-applied:${book.id}:${book.hash}`, value: path });
    await save("book", { ...current, preparedTextPath: path });
  });
}

/** Check the immutable bundle before restoring page caches on another device. */
export async function restorePreparedText(book: Book, blob: Blob) {
  if (!validPreparedPath(book)) throw new Error("This book's prepared-text path is invalid.");
  const expected = book.preparedTextPath!.slice(`${book.id}/text-v1-`.length, -".ndjson.gz".length);
  if (await digest(await blob.arrayBuffer()) !== expected) throw new Error("The prepared text did not match its saved version.");
  const reader = blob.stream().pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "", size = 0, total = 0, next = 1, header = false;
  try {
    while (true) {
      const { value = "", done } = await reader.read();
      size += value.length; buffer += value;
      if (size > 128_000_000 || buffer.length > 4_000_000) throw new Error("The prepared text is too large to restore.");
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        if (!line) continue;
        const record = JSON.parse(line);
        if (!header) {
          if (record.v !== 1 || record.hash !== book.hash || !Number.isInteger(record.total) || record.total < 1 || record.total > 100_000)
            throw new Error("The prepared text belongs to another document.");
          total = record.total; header = true; continue;
        }
        if (record.page !== next || next > total || !validPageText(record.text) ||
          (record.words !== null && !validWords(record.words)) || (!hasPageText(record.text) && !validWords(record.words)))
          throw new Error("A saved text page is incomplete.");
        const rows = [{ key: textKey(book, next), value: JSON.stringify(record.text) }];
        if (record.words !== null && await savedOcr(book, next) === undefined)
          rows.push({ key: ocrKey(book, next), value: JSON.stringify(record.words) });
        if (!await savePageCache(book, rows)) throw new Error("The book is no longer in this library.");
        next++;
        if (next % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (done) break;
    }
    if (!header || buffer.trim() || next !== total + 1) throw new Error("The prepared text download was incomplete.");
    await savePageCache(book, [
      { key: preparationKey(book), value: JSON.stringify({ status: "ready", done: total, total }) },
      { key: `pdf-page-count:${book.hash}`, value: String(total) },
      { key: `prepared-text-applied:${book.id}:${book.hash}`, value: book.preparedTextPath! },
    ]);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
