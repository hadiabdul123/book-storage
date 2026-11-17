import "fake-indexeddb/auto";
import { beforeEach, expect, it, vi } from "vitest";
import type { PDFPageProxy } from "pdfjs-dist";
import { db, get, save, saveBookFile } from "../src/db";
import type { Book } from "../src/model";
import { pageText, ocrKey, textKey, preparationKey, savePageCache } from "../src/pdfText";
import { publishPreparedText, restorePreparedText } from "../src/preparedText";

const book: Book = { id: "prepared", title: "Saved text", author: "Reader", description: "", format: "pdf", filename: "saved.pdf",
  hash: "a".repeat(64), bytes: 8, tags: [], status: "unread", addedAt: "2026-11-17T00:00:00Z", sourcePath: "prepared/source.pdf" };
const content = { items: [{ str: "Stored native text", dir: "ltr", width: 100, height: 10,
  transform: [1, 0, 0, 1, 10, 100], fontName: "f1", hasEOL: false }], styles: { f1: { fontFamily: "sans-serif", ascent: 1, descent: 0, vertical: false } }, lang: "en" };
beforeEach(async () => {
  vi.stubGlobal("window", new EventTarget());
  for (const table of db.tables) await table.clear();
  await save("book", book);
  await saveBookFile({ id: book.id, source: new Blob(["original"]), uploaded: true });
});

it("coalesces extraction and reuses saved native text across page instances", async () => {
  const extract = vi.fn().mockResolvedValue(content);
  const page = { pageNumber: 1, getTextContent: extract } as unknown as PDFPageProxy;
  const [a, b] = await Promise.all([pageText(book, page), pageText(book, page)]);
  expect(a).toEqual(content); expect(b).toEqual(content); expect(extract).toHaveBeenCalledTimes(1);
  const reopened = { pageNumber: 1, getTextContent: vi.fn().mockRejectedValue(new Error("Must not extract twice")) } as unknown as PDFPageProxy;
  expect(await pageText(book, reopened)).toEqual(content);
  expect(reopened.getTextContent).not.toHaveBeenCalled();
});

it("transfers native and OCR pages to a clean device without changing original upload state", async () => {
  await db.meta.bulkPut([
    { key: textKey(book, 1), value: JSON.stringify(content) },
    { key: textKey(book, 2), value: JSON.stringify({ items: [], styles: {} }) },
    { key: ocrKey(book, 2), value: JSON.stringify([{ text: "Saved recognition", rect: [10, 100, 90, 115] }]) },
  ]);
  await publishPreparedText(book, 2);
  const prepared = (await db.files.get(book.id))!;
  const remoteBook = (await get("book", book.id))!;
  expect(prepared.uploaded).toBe(true); expect(prepared.preparedTextUploaded).toBe(false);
  expect(await prepared.source.text()).toBe("original");
  await db.meta.clear();
  await restorePreparedText(remoteBook, prepared.preparedText!);
  expect(JSON.parse((await db.meta.get(ocrKey(book, 2)))!.value)[0].text).toBe("Saved recognition");
  expect(JSON.parse((await db.meta.get(preparationKey(book)))!.value)).toEqual({ status: "ready", done: 2, total: 2 });
  expect(await pageText(book, { pageNumber: 1, getTextContent: () => { throw new Error("Unneeded extraction"); } } as unknown as PDFPageProxy)).toEqual(content);
  // A details form opened before preparation finished must retain its reference.
  await save("book", { ...book, title: "Edited title" });
  expect((await get("book", book.id))!.preparedTextPath).toBe(remoteBook.preparedTextPath);
});

it("rejects damaged bundles before restoring text and prevents late writes after removal", async () => {
  await db.meta.put({ key: textKey(book, 1), value: JSON.stringify(content) });
  await publishPreparedText(book, 1);
  const remote = (await get("book", book.id))!;
  const packed = (await db.files.get(book.id))!.preparedText!;
  await db.meta.clear();
  await expect(restorePreparedText({ ...remote, hash: "b".repeat(64) }, packed)).rejects.toThrow("another document");
  await expect(restorePreparedText(remote, new Blob(["damaged"]))).rejects.toThrow("did not match");
  expect(await db.meta.count()).toBe(0);
  await db.rows.clear();
  expect(await savePageCache(book, [{ key: textKey(book, 1), value: "private text" }])).toBe(false);
  expect(await db.meta.count()).toBe(0);
});
