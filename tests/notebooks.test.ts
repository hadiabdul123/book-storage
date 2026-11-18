import "fake-indexeddb/auto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { db, save, get, list, acceptRemote } from "../src/db";
import { saveResearchClip, saveNotebookNote } from "../src/notebookStore";
import { citationNode, documentSources, sourceHref } from "../src/sourceReferences";
import { plainText, validRichDocument, markdown, paragraph } from "../src/richText";
import { researchBackup, restoreResearchBackup } from "../src/researchBackup";
import { rankChunks, retrieveSources, sectionIndexKey, splitUnit, surroundingText } from "../src/sourceIndex";
import { planBookReview } from "../src/bookReview";
import type { SourceRef } from "../src/researchTypes";
import type { Book } from "../src/model";
const book: Book = { id: "book", title: "Universe", author: "Author", hash: "a".repeat(64), format: "pdf", bytes: 100, filename: "universe.pdf", description: "", tags: [], status: "reading", addedAt: "2026-01-01T00:00:00Z", sourcePath: "book/source.pdf" };
const source: SourceRef = { id: "S1", kind: "book", title: book.title, excerpt: "The universe is expanding.", bookId: book.id, locator: { v: 1, type: "pdf", hash: book.hash, page: 1, y: 0 } };
beforeEach(async () => { vi.stubGlobal("window", new EventTarget()); for (const table of db.tables) await table.clear(); await save("book", book); await db.meta.put({ key: `pdf-page-count:${book.hash}`, value: "2" }); });
afterEach(() => vi.unstubAllGlobals());
it("saves a sourced excerpt into a new topic notebook with valid rich content and export links", async () => {
  const id = await saveResearchClip({ kind: "new", title: "Cosmology", notebookTitle: "Science" }, "Expansion is evidence [S1].", [source]);
  const note = (await get("notebook-note", id))!;
  expect((await list("notebook"))[0].title).toBe("Science"); expect(validRichDocument(note.document)).toBe(true);
  expect(documentSources(note.document)).toEqual([source]); expect(markdown(note.document)).toContain("Universe");
  expect(sourceHref(source)).toContain("source=");
});
it("appends to the recovered PDF page draft and rejects nonexistent pages", async () => {
  await db.meta.put({ key: "page-note-draft:book:1", value: JSON.stringify({ document: { type: "doc", content: [paragraph("Unfinished thought")] }, tags: [] }) });
  await saveResearchClip({ kind: "page", bookId: "book", page: 1 }, "Research excerpt", [source]);
  const note = (await list("annotation"))[0]; expect(note.note).toContain("Unfinished thought"); expect(note.note).toContain("Research excerpt"); expect(documentSources(note.content!.document)).toEqual([source]);
  await expect(saveResearchClip({ kind: "page", bookId: "book", page: 3 }, "Invalid", [source])).rejects.toThrow("between 1 and 2");
});
it("preserves sources on passage notes without changing the quoted text", async () => {
  await saveResearchClip({ kind: "passage", bookId: "book", locator: source.locator!, quote: "Selected quotation" }, "My explanation", [source]);
  const a = (await list("annotation"))[0]; expect(a.text).toBe("Selected quotation"); expect(a.sources).toEqual([source]);
});
it("keeps a losing concurrent topic document as a recoverable version", async () => {
  const id = await saveResearchClip({ kind: "new", title: "Cosmology" }, "Local writing", [source]);
  const row = (await db.rows.get(`notebook-note:${id}`))!;
  await acceptRemote({ ...row, revision: 7, editId: crypto.randomUUID(), editedAt: "2099-01-01T00:00:00Z", value: { ...row.value, document: { type: "doc", content: [paragraph("Other device")] } } as any });
  const versions = await db.meta.where("key").startsWith(`note-version:${id}:`).toArray();
  expect(versions.length).toBeGreaterThan(0); expect(versions[0].value).toContain("Local writing");
});
it("round-trips research backups, remaps source books by hash, and keeps existing notes", async () => {
  const id = await saveResearchClip({ kind: "new", title: "Cosmology" }, "Evidence", [source]);
  const backup = await researchBackup(); for (const table of db.tables) await table.clear();
  await save("book", { ...book, id: "new-book", sourcePath: "new-book/source.pdf" });
  expect((await restoreResearchBackup(backup)).restored).toBe(2);
  const restored = (await get("notebook-note", id))!; expect(documentSources(restored.document)[0].bookId).toBe("new-book");
  await saveNotebookNote({ ...restored, title: "Keep my edit" }); await restoreResearchBackup(backup); expect((await get("notebook-note", id))?.title).toBe("Keep my edit");
});
it("rejects an invalid backup before writing any notebooks", async () => {
  const backup = { schema: "leafmark.research", version: 1, books: [], records: [{ kind: "notebook", value: { id: "n", title: "Fine", createdAt: new Date().toISOString() } }, { kind: "notebook-note", value: { id: "bad" } }] };
  await expect(restoreResearchBackup(backup)).rejects.toThrow("valid Leafmark"); expect(await list("notebook")).toHaveLength(0);
});
it("rejects unsafe citation links and preserves a valid citation in rich text", () => {
  const valid = { type: "doc", content: [paragraph("Evidence"), citationNode(source)] }; expect(validRichDocument(valid)).toBe(true);
  expect(plainText(valid)).toContain("Universe"); expect(validRichDocument({ type: "doc", content: [citationNode({ ...source, kind: "web", url: "javascript:alert(1)" })] })).toBe(false);
});
it("retrieves matching chunks and handles whitespace around a selected phrase", () => {
  const chunks = splitUnit(book, { unit: 1, text: "Big Bang theory explains the expansion of the universe.", title: book.title, locator: source.locator! });
  expect(rankChunks("Big Bang evidence", chunks)[0].bookId).toBe(book.id); expect(rankChunks("unrelated elephant", chunks)).toHaveLength(0);
  expect(surroundingText("The Big\nBang theory describes expansion.", "Big Bang")).toContain("describes expansion");
});

it("keeps a source slot for every compared book and includes a chosen highlight's follow-ups", async () => {
  const other = { ...book, id: "other", title: "Another view", hash: "b".repeat(64) };
  await save("book", other);
  const first = splitUnit(book, { unit: 1, text: "Expansion ".repeat(1500), title: book.title, locator: source.locator! });
  const second = splitUnit(other, { unit: 1, text: "The second author writes about gravity.", title: other.title, locator: { ...source.locator!, hash: other.hash } });
  await db.chunks.bulkPut([...first, ...second]);
  await save("annotation", { id: "quote", bookId: other.id, locator: { ...source.locator!, hash: other.hash }, text: "The exception is important", note: "Consider the conditions", color: "yellow", tags: [], createdAt: "2026-01-01T00:00:00Z" });
  await save("highlight-followup", { id: "follow", annotationId: "quote", text: "Check the next chapter", createdAt: "2026-01-01T00:01:00Z" });
  const result = await retrieveSources("Expansion", [book.id, other.id], [], ["quote"]);
  expect(result.slice(0, 2).map(ref => ref.bookId)).toEqual([book.id, other.id]);
  expect(result[2].excerpt).toContain("Check the next chapter");
  expect(sourceHref(result[2])).toBe("#/notes?item=quote");
  expect(result.length).toBeLessThanOrEqual(7);
});

it("samples a marked chapter in order and reports sections without cached text", async () => {
  const markers = [{ start: 1, title: "A beginning" }, { start: 5, title: "An empty chapter" }, { start: 8, title: "More evidence" }];
  await db.meta.bulkPut([
    { key: `text-index:${book.id}`, value: JSON.stringify({ hash: book.hash, version: 2, complete: true, missing: 0 }) },
    { key: `pdf-page-count:${book.hash}`, value: "12" },
    { key: sectionIndexKey(book), value: JSON.stringify(markers) },
  ]);
  for (const unit of [1, 2, 3, 4, 8, 10, 12]) await db.chunks.bulkPut(splitUnit(book, { unit, text: `Page ${unit} has evidence `.repeat(100), title: book.title, locator: { v: 1, type: "pdf", hash: book.hash, page: unit, y: 0 } }));
  const sections = await planBookReview([book], new AbortController().signal, () => {});
  expect(sections.map(section => section.label)).toEqual(markers.map(marker => marker.title));
  expect(sections[0].sources).toHaveLength(7);
  expect(sections[0].sources.at(-1)?.locator).toMatchObject({ page: 4 });
  expect(sections[1].sources).toEqual([]);
  expect(sections[2].sources.at(-1)?.locator).toMatchObject({ page: 12 });
});
