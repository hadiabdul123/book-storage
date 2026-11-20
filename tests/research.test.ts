import "fake-indexeddb/auto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
vi.mock("../src/sync", () => ({ cloud: null }));
import { db, save, list, get } from "../src/db";
import { enqueueResearch, runResearchQueue, cancelResearch, retryResearch, ResearchFailure } from "../src/research";
import type { SourceRef } from "../src/researchTypes";
import type { Book } from "../src/model";
import { textKey, ocrKey } from "../src/pdfText";
import { searchPreparedPassages } from "../src/sourceIndex";
const source: SourceRef = { id: "S1", kind: "web", title: "Evidence", url: "https://example.org/evidence", excerpt: "Evidence from observations." };
const result = { answer: "Evidence [S1]", sources: [source], model: "test" };
const request = { mode: "web" as const, question: "What is the evidence?", searchQuery: "evidence", sources: [], history: [] };
beforeEach(async () => {
  vi.stubGlobal("window", new EventTarget()); vi.stubGlobal("navigator", { onLine: true });
  for (const table of db.tables) await table.clear();
  await save("research-thread", { id: "thread", title: "Evidence", createdAt: new Date().toISOString() });
});
afterEach(() => vi.unstubAllGlobals());
it("retains an offline question and resumes it exactly once after reconnecting", async () => {
  vi.stubGlobal("navigator", { onLine: false });
  const id = await enqueueResearch("thread", request); const transport = vi.fn(async () => result);
  await runResearchQueue(transport); expect(transport).not.toHaveBeenCalled();
  expect((await db.researchJobs.get(id))?.state).toBe("queued");
  vi.stubGlobal("navigator", { onLine: true }); await Promise.all([runResearchQueue(transport), runResearchQueue(transport)]);
  expect(transport).toHaveBeenCalledTimes(1); expect((await get("research-message", id))?.answer).toBe(result.answer);
  expect((await db.researchJobs.get(id))?.state).toBe("done");
  expect((await db.outbox.toArray()).some(o => o.kind === "research-message")).toBe(true);
});
it("deduplicates pending questions and serves cached answers without a second request", async () => {
  const first = await enqueueResearch("thread", request); expect(await enqueueResearch("thread", request)).toBe(first);
  const transport = vi.fn(async () => result); await runResearchQueue(transport);
  await enqueueResearch("thread", request); await runResearchQueue(transport);
  expect(transport).toHaveBeenCalledTimes(1); expect(await list("research-message")).toHaveLength(2);
});
it("does not publish a response cancelled while the provider was running", async () => {
  const id = await enqueueResearch("thread", request);
  const transport = vi.fn(async () => { await cancelResearch(id); return result; });
  await runResearchQueue(transport); expect(await list("research-message")).toHaveLength(0); expect((await db.researchJobs.get(id))?.state).toBe("cancelled");
});
it("cannot recreate private writing after local data was cleared while a request was running", async () => {
  await enqueueResearch("thread", request);
  await runResearchQueue(async () => { for (const table of db.tables) await table.clear(); return result; });
  expect(await list("research-message")).toHaveLength(0); expect(await db.outbox.count()).toBe(0);
});
it("pauses quota failures and rejects premature retry without losing the request", async () => {
  const id = await enqueueResearch("thread", request);
  await runResearchQueue(async () => { throw new ResearchFailure("Quota reached", "quota", 120); });
  expect((await db.researchJobs.get(id))?.state).toBe("paused"); await expect(retryResearch(id)).rejects.toThrow("Try again after");
  expect((await db.researchJobs.get(id))?.request.question).toBe(request.question);
});
it("recovers a job left running by a terminated tab using the same server request ID", async () => {
  const id = await enqueueResearch("thread", request); const before = (await db.researchJobs.get(id))!;
  await db.researchJobs.update(id, { state: "running" });
  const transport = vi.fn(async () => result); await runResearchQueue(transport);
  expect(transport.mock.calls[0][0].requestId).toBe(before.request.requestId); expect(await list("research-message")).toHaveLength(1);
});
it("does not save an answer that references a source the server did not provide", async () => {
  const id = await enqueueResearch("thread", request);
  await runResearchQueue(async () => ({ ...result, answer: "Invented [S99]" }));
  expect((await db.researchJobs.get(id))?.state).toBe("error"); expect(await list("research-message")).toHaveLength(0);
});

it("searches prepared PDF text and OCR offline while ignoring older editions and unselected sources", async () => {
  const book = { id: "book", title: "Restoration", format: "pdf", hash: "a".repeat(64) } as Book;
  const locator = { type: "pdf", v: 1, hash: book.hash, page: 2, y: 0 } as const;
  await db.meta.bulkPut([
    { key: textKey(book, 2), value: JSON.stringify({ styles: {}, items: [
      { str: "Restoration improves the river", fontName: "test", transform: [1, 0, 0, 1, 0, 0], width: 40, height: 10, hasEOL: false },
    ] }) },
    { key: ocrKey(book, 4), value: JSON.stringify([{ text: "Restoration on a scanned page", rect: [0, 0, 1, 1] }]) },
  ]);
  await db.chunks.put({
    id: "outdated", bookId: book.id, hash: "b".repeat(64), unit: 1, text: "Restoration in an old edition", locator, title: "Old edition",
  });
  const date = new Date().toISOString();
  await save("annotation", { id: "hidden", bookId: book.id, locator, text: "Restoration in an unselected highlight", note: "", tags: [], color: "yellow", createdAt: date });
  await save("notebook-note", { id: "note", title: "Field notes", notebookId: "notebook", tags: [], createdAt: date, updatedAt: date,
    document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `${"other ".repeat(500)}restoration found in a later paragraph` }] }] },
  });
  const { hits, indexedBooks } = await searchPreparedPassages("restoration", [book], { bookIds: [book.id], highlightIds: [], noteIds: ["note"] });
  expect(indexedBooks).toEqual(new Set([book.id]));
  expect(hits).toHaveLength(3);
  expect(hits.map(hit => hit.locator?.type === "pdf" ? hit.locator.page : hit.noteId)).toEqual(expect.arrayContaining([2, 4, "note"]));
  expect(await db.chunks.count()).toBe(1);
});
