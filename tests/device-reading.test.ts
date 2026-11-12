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
  await writeDeviceReading("book", { zoom: 1.5, rotation: 90 });
  expect(await readDeviceReading("book")).toEqual({
    pdfLayout: defaultPdfLayout,
    zoom: 1.5,
    rotation: 90,
  });
  expect(await db.outbox.count()).toBe(0);
});
