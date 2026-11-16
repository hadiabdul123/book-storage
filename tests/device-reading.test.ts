import "fake-indexeddb/auto";
import { beforeEach, expect, it } from "vitest";
import { db } from "../src/db";
import {
  devicePdfLayout,
  readDeviceReading,
  writeDeviceReading,
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
  expect(await readDeviceReading("novel")).toEqual({});
  expect(await db.outbox.count()).toBe(0);
});
it("merges rapid layout edits against the latest stored layout", async () => {
  await Promise.all([
    writeDeviceReading("book", prior => ({ pdfLayout: { ...(prior.pdfLayout || defaultPdfLayout), navigation: "paginated" } })),
    writeDeviceReading("book", prior => ({ pdfLayout: { ...(prior.pdfLayout || defaultPdfLayout), fit: "page" } })),
  ]);
  expect((await readDeviceReading("book")).pdfLayout).toEqual({ columns: 1, navigation: "paginated", fit: "page" });
});
