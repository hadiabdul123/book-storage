import "fake-indexeddb/auto";
import { beforeEach, expect, it } from "vitest";
import { db } from "../src/db";
import {
  devicePdfLayout,
  readDeviceReading,
  writeDeviceReading,
  initializeDeviceReading,
} from "../src/deviceReading";
import { defaultPdfLayout } from "../src/model";
beforeEach(async () => {
  for (const table of db.tables) await table.clear();
});
it("keeps phone defaults independent of legacy desktop preferences", () => {
  const desktop = { columns: 2, navigation: "paginated", fit: "page" } as const;
  expect(devicePdfLayout(undefined, desktop, true)).toEqual(defaultPdfLayout);
  expect(devicePdfLayout(undefined, desktop, false)).toEqual(desktop);
});
it("saves layout and zoom locally without creating a cloud operation", async () => {
  await writeDeviceReading("book", { pdfLayout: defaultPdfLayout });
  await writeDeviceReading("book", { zoom: 1.5, rotation: 90, hidePageControls: true });
  expect(await readDeviceReading("book")).toEqual({
    pdfLayout: defaultPdfLayout,
    zoom: 1.5,
    rotation: 90,
    hidePageControls: true,
  });
  expect(await db.outbox.count()).toBe(0);
});
it("keeps original PDF colors per book and preserves other view settings", async () => {
  await writeDeviceReading("illustrated", { pdfOriginalColors: true, zoom: 1.5, pageTurnEffect: "none", swipeToTurn: false });
  await writeDeviceReading("illustrated", { rotation: 90 });
  expect(await readDeviceReading("illustrated")).toMatchObject({ pdfOriginalColors: true, zoom: 1.5, rotation: 90, pageTurnEffect: "none", swipeToTurn: false });
  expect(await readDeviceReading("novel")).toMatchObject({ zoom: 1.5, pageTurnEffect: "none", swipeToTurn: false });
  expect((await readDeviceReading("novel")).pdfOriginalColors).toBeUndefined();
  expect((await readDeviceReading("novel")).rotation).toBeUndefined();
  expect(await db.outbox.count()).toBe(0);
});
it("seeds device defaults once and ignores later cloud and per-book layout seeds", async () => {
  await db.meta.put({ key: "device-reading:first", value: JSON.stringify({ zoom: 2, rotation: 90, pdfLayout: { columns: 2, fit: "width", navigation: "paginated" } }) });
  const first = await initializeDeviceReading("first", { theme: "dark", fontSize: 24 });
  expect(first).toMatchObject({ zoom: 2, rotation: 90, theme: "dark", pdfLayout: { columns: 2 } });
  await db.meta.put({ key: "device-reading:second", value: JSON.stringify({ zoom: 1, rotation: 180 }) });
  expect(await initializeDeviceReading("second", { theme: "light", zoom: 1 })).toMatchObject({ zoom: 2, rotation: 180, theme: "dark", fontSize: 24 });
  await writeDeviceReading("second", { theme: "sepia", fontSize: 21 });
  expect(await readDeviceReading("first")).toMatchObject({ zoom: 2, rotation: 90, theme: "sepia", fontSize: 21 });
  expect(await db.outbox.count()).toBe(0);
});
it("merges rapid layout edits against the latest stored layout", async () => {
  await Promise.all([
    writeDeviceReading("book", prior => ({ pdfLayout: { ...(prior.pdfLayout || defaultPdfLayout), navigation: "paginated" } })),
    writeDeviceReading("book", prior => ({ pdfLayout: { ...(prior.pdfLayout || defaultPdfLayout), fit: "page" } })),
  ]);
  expect((await readDeviceReading("book")).pdfLayout).toEqual({ columns: 1, navigation: "paginated", fit: "page" });
});
