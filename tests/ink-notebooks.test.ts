import "fake-indexeddb/auto";
import { beforeEach, expect, it, vi } from "vitest";
import { db, save, list, get, acceptRemote } from "../src/db";
import { InkHistory, inkPath, recoverInkDrafts } from "../src/ink";
import { validInkStroke, type InkStroke } from "../src/inkTypes";
import { emptyDocument, paragraph, validRichDocument, markdown } from "../src/richText";
import { ensureNotebookSection, defaultSectionId, deleteNotebookSection } from "../src/notebookSections";
import { researchBackup, restoreResearchBackup } from "../src/researchBackup";
import { blankMargins } from "../src/reader/pdfGeometry";
const stamp = "2026-11-17T00:00:00Z";
const stroke = (id = "ink-one"): InkStroke => ({ id, target: { type: "notebook", noteId: "page", blockId: "canvas" }, tool: "pen", color: "#315c86", width: 2, points: [[10, 20, .5], [30, 40, .7]], createdAt: stamp });
beforeEach(async () => { vi.stubGlobal("window", new EventTarget()); for (const table of db.tables) await table.clear(); });
it("validates bounded vector input and generates smooth closed outlines", () => {
  expect(validInkStroke(stroke())).toBe(true);
  for (const patch of [{ points: [[NaN, 2, .5]] }, { points: [[2, 3, 2]] }, { width: 0 }, { color: "url(unsafe)" }, { target: { type: "pdf", hash: "wrong", page: 1 } }]) expect(validInkStroke({ ...stroke(), ...patch })).toBe(false);
  expect(inkPath(stroke())).toMatch(/^M .+ Q .+ Z$/);
});
it("keeps small reversing handwriting curves and scales ink with document coordinates", () => {
  const writing = { ...stroke(), points: [[0, 0, .5], [2, 8, .5], [4, 0, .5], [6, -8, .5], [8, 0, .5], [40, 0, .5]] } as InkStroke;
  const numbers = (path: string) => path.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)!.map(Number);
  const original = numbers(inkPath(writing)), enlarged = numbers(inkPath(writing, (x, y) => [x * 2, y * 2]));
  const ys = original.filter((_, i) => i % 2);
  expect(Math.max(...ys)).toBeGreaterThan(7); expect(Math.min(...ys)).toBeLessThan(-7);
  expect(enlarged).toHaveLength(original.length);
  enlarged.forEach((n, i) => expect(n).toBeCloseTo(original[i] * 2));
  expect(writing.points).toHaveLength(6); expect(writing.width).toBe(2);
});
it("keeps sub-pixel pen reversals and the measured end point in direct ink", () => {
  const points: InkStroke["points"] = [[0,0,.5],[0,.08,.5],[.04,.08,.5],[.04,0,.5]];
  const path = inkPath({ ...stroke(), input:"direct", width:2, points });
  const coords = path.slice(2,-2).split(" L ").map(p => p.split(" ").map(Number));
  // The nib straddles the measured centre at both ends of each segment.
  for (const [x,y] of [[-1,.08],[1,.08],[.04,1.08],[.04,-.92],[-.96,0],[1.04,0]]) {
    expect(coords.some(p => Math.abs(p[0]-x)<1e-9 && Math.abs(p[1]-y)<1e-9)).toBe(true);
  }
});
it("undoes only the local stroke while keeping concurrent additions", async () => {
  const history = new InkHistory(); await history.perform(stroke());
  const other = stroke("other-device");
  await acceptRemote({ key: `ink-stroke:${other.id}`, kind: "ink-stroke", id: other.id, value: other, revision: 10, deleted: false, updatedAt: stamp, editedAt: stamp, editId: crypto.randomUUID() });
  await history.move(); expect((await list("ink-stroke")).map(s => s.id)).toEqual(["other-device"]);
  await history.move(true); expect(await list("ink-stroke")).toHaveLength(2);
  expect(await db.meta.where("key").startsWith("ink-draft:").count()).toBe(0);
});
it("recovers a completed ink draft after interruption", async () => {
  await db.meta.put({ key: "ink-draft:ink-one", value: JSON.stringify({ stroke: stroke(), deleted: false }) });
  await recoverInkDrafts(); expect(await get("ink-stroke", "ink-one")).toEqual(stroke()); expect(await db.meta.count()).toBe(1); // operation sequence only
});
it("retains unsaved vectors in memory and retries after a storage failure", async () => {
  const history = new InkHistory();
  const failure = vi.spyOn(db.meta, "put").mockRejectedValueOnce(new Error("Storage full"));
  await expect(history.perform(stroke())).rejects.toThrow("Storage full"); failure.mockRestore();
  expect(history.visible([])).toEqual([stroke()]); expect(await list("ink-stroke")).toHaveLength(0);
  await history.retry(); expect(await list("ink-stroke")).toEqual([stroke()]); expect(history.pending.size).toBe(0);
  expect(history.undoStack).toHaveLength(1);
});
it("keeps existing note content when creating and deleting sections", async () => {
  await save("notebook", { id: "n", title: "Ideas", createdAt: stamp });
  await Promise.all([ensureNotebookSection("n"), ensureNotebookSection("n")]);
  expect(await list("notebook-section")).toHaveLength(1);
  await save("notebook-section", { id: "s", notebookId: "n", title: "Questions", order: 1, createdAt: stamp });
  const document = { type: "doc", content: [paragraph("Keep this thought")] };
  await save("notebook-note", { id: "page", notebookId: "n", sectionId: "s", title: "Idea", document, tags: [], createdAt: stamp, updatedAt: stamp });
  await deleteNotebookSection("s"); expect(await get("notebook-note", "page")).toMatchObject({ sectionId: defaultSectionId("n"), document });
  await expect(deleteNotebookSection(defaultSectionId("n"))).rejects.toThrow("cannot be deleted");
});
it("restores legacy v2 notebook ink and round-trips new v3 assets", async () => {
  const book = { id: "old", hash: "a".repeat(64), title: "Book", format: "pdf", sourcePath: "old/source.pdf" } as const;
  await save("book", book as any); await save("notebook", { id: "n", title: "Ideas", createdAt: stamp }); await ensureNotebookSection("n");
  const document = { type: "doc", content: [{ type: "drawing", attrs: { blockId: "canvas", height: 300 } }] };
  await save("notebook-note", { id: "page", notebookId: "n", sectionId: defaultSectionId("n"), title: "Page", document, tags: [], createdAt: stamp, updatedAt: stamp });
  await save("ink-stroke", stroke()); await save("ink-stroke", { ...stroke("pdf-ink"), target: { type: "pdf", bookId: "old", hash: book.hash, page: 2 } });
  const backup = { ...await researchBackup(), version: 2 };
  for (const table of db.tables) await table.clear();
  await save("book", { ...book, id: "new", sourcePath: "new/source.pdf" } as any);
  expect((await restoreResearchBackup(backup)).restored).toBe(5);
  expect((await get("ink-stroke", "pdf-ink"))?.target).toMatchObject({ bookId: "new", page: 2 });
  expect(await get("ink-stroke", "ink-one")).toEqual(stroke());
  expect((await restoreResearchBackup(backup)).skipped).toBe(5);
  const legacy = { schema: "leafmark.research", version: 1, books: [], records: [{ kind: "notebook", value: { id: "legacy", title: "Legacy", createdAt: stamp } }] };
  expect((await restoreResearchBackup(legacy)).restored).toBe(1);
  const overlay = { id: "overlay", noteId: "page", anchor: "paper", x: 20, y: 10, scale: 1.5, createdAt: stamp };
  const media = { id: "audio", noteId: "page", extension: "wav" as const, title: "Talk.wav", size: 48044, hash: "b".repeat(64), createdAt: stamp };
  await save("notebook-overlay", overlay); await save("notebook-media", media);
  await db.mediaFiles.add({ id: "audio", bytes: new ArrayBuffer(48044), uploaded: false });
  const current = await researchBackup(); expect(current.version).toBe(3);
  expect(JSON.stringify(current)).not.toContain("bytes");
  for (const table of db.tables) await table.clear();
  await restoreResearchBackup(current);
  expect(await get("notebook-overlay", "overlay")).toEqual(overlay);
  expect(await get("notebook-media", "audio")).toEqual(media);
  expect(await db.mediaFiles.get("audio")).toBeUndefined();
  const image = { ...media, id: "image", extension: "png" as const, title: "Diagram.png", placement: { after: "anchor-1", order: 2 } };
  await save("notebook-image", image);
  const withImage = await researchBackup(); expect(withImage.version).toBe(4);
  for (const table of db.tables) await table.clear();
  await restoreResearchBackup(withImage);
  expect(await get("notebook-image", "image")).toEqual(image);
  expect(await db.mediaFiles.get("image")).toBeUndefined();
});
it("preserves rich marks and rejects executable links or malformed drawing nodes", () => {
  const doc = emptyDocument(); doc.content = [{ type: "paragraph", content: [{ type: "text", text: "Keep", marks: [{ type: "underline" }, { type: "highlight", attrs: { color: "#f4cc60" } }, { type: "textStyle", attrs: { color: "#315c86" } }, { type: "link", attrs: { href: "https://example.com" } }] }] }];
  expect(validRichDocument(doc)).toBe(true); expect(markdown(doc)).toContain("<mark"); expect(markdown(doc)).toContain("https://example.com");
  doc.content[0].content![0].marks![3].attrs!.href = "javascript:alert(1)"; expect(validRichDocument(doc)).toBe(false);
  expect(validRichDocument({ type: "doc", content: [{ type: "drawing", attrs: { blockId: "../../file", height: 300 } }] })).toBe(false);
});
it("limits raster trimming and retains a footnote at the bottom of a page", () => {
  const width = 100, height = 150, data = new Uint8ClampedArray(width * height * 4).fill(255);
  expect(blankMargins(data, width, height)).toBeUndefined();
  const ink = (x: number, y: number) => { const i = (y * width + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; };
  ink(30, 30); ink(70, 100);
  const cropped = blankMargins(data, width, height)!; expect(cropped[0]).toBeLessThanOrEqual(12); expect(cropped[1]).toBeLessThanOrEqual(18);
  ink(48, 149); expect(blankMargins(data, width, height)![3]).toBe(150);
});
