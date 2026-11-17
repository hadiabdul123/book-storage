import "fake-indexeddb/auto";
import { expect, it, beforeEach, vi, afterEach } from "vitest";
import { db } from "../src/db";
import { queueDeviceReading, flushDeviceReading, readDeviceReading, writeDeviceReading } from "../src/deviceReading";
import { defaultPdfLayout } from "../src/model";
beforeEach(async () => {
  await flushDeviceReading(); await db.meta.clear();
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => items.get(key) || null, setItem: (key: string, value: string) => items.set(key, value), removeItem: (key: string) => items.delete(key) });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("saves the last zoom together with independent settings without cloud writes", async () => {
  const pending = [queueDeviceReading("book", { zoom: 2 }), queueDeviceReading("book", { theme: "dark" }), queueDeviceReading("book", { zoom: 1.5 }), queueDeviceReading("book", { hidePageControls: true })];
  await flushDeviceReading("book"); await Promise.all(pending);
  expect(await readDeviceReading("other-book")).toMatchObject({ zoom: 1.5, theme: "dark", hidePageControls: true });
});
it("keeps document rotation separate when saving multiple books", async () => {
  const a = queueDeviceReading("a", { rotation: 90 }), b = queueDeviceReading("b", { rotation: 180 });
  await flushDeviceReading(); await Promise.all([a,b]);
  expect((await readDeviceReading("a")).rotation).toBe(90); expect((await readDeviceReading("b")).rotation).toBe(180);
});
it("journals all pending layout choices even when a live query reads older stored defaults", async () => {
  await writeDeviceReading("journal-book", { pdfLayout: defaultPdfLayout }); await readDeviceReading("journal-book");
  const columns = queueDeviceReading("journal-book", prior => ({ pdfLayout: { ...defaultPdfLayout, ...prior.pdfLayout, columns: 2 } }));
  const theme = queueDeviceReading("journal-book", { theme: "dark" });
  await readDeviceReading("journal-book");
  const fit = queueDeviceReading("journal-book", prior => ({ pdfLayout: { ...defaultPdfLayout, ...prior.pdfLayout, fit: "page" } }));
  expect(JSON.parse(localStorage.getItem("device-reading:pending:v1")!).at(-1).value.pdfLayout).toMatchObject({ columns: 2, fit: "page" });
  await flushDeviceReading(); await Promise.all([columns, theme, fit]);
  expect(await readDeviceReading("journal-book")).toMatchObject({ theme: "dark", pdfLayout: { columns: 2, fit: "page" } });
});
it("recovers an earlier failed batch before acknowledging a later successful save", async () => {
  const failure = vi.spyOn(db.meta, "put").mockRejectedValueOnce(new Error("Storage temporarily unavailable"));
  const first = expect(queueDeviceReading("retry-book", { theme: "dark" })).rejects.toThrow("Storage temporarily unavailable");
  await flushDeviceReading(); await first; failure.mockRestore();
  expect(localStorage.getItem("device-reading:pending:v1")).toContain("dark");
  const next = queueDeviceReading("retry-book", { zoom: 1.5 }); await flushDeviceReading(); await next;
  expect(await readDeviceReading("retry-book")).toMatchObject({ theme: "dark", zoom: 1.5 });
  expect(localStorage.getItem("device-reading:pending:v1")).toBeNull();
});
it("keeps shared choices in input order across books and recovers failed older writes first", async () => {
  const failure = vi.spyOn(db.meta, "put").mockRejectedValueOnce(new Error("Temporary failure"));
  const first = expect(queueDeviceReading("older-book", { theme: "dark" })).rejects.toThrow("Temporary failure");
  await flushDeviceReading(); await first; failure.mockRestore();
  const newer = queueDeviceReading("newer-book", { theme: "sepia" });
  const rotation = queueDeviceReading("older-book", { rotation: 90 });
  await flushDeviceReading("newer-book"); await Promise.all([newer, rotation]);
  expect(await readDeviceReading("newer-book")).toMatchObject({ theme: "sepia" });
  expect(await readDeviceReading("older-book")).toMatchObject({ theme: "sepia", rotation: 90 });
  expect(localStorage.getItem("device-reading:pending:v1")).toBeNull();
});
