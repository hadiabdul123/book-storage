import { expect, it } from "vitest";
import { samePassage } from "../src/reader/passages";
import type { Locator } from "../src/model";

const saved: Extract<Locator, { type: "pdf" }> = {
  v: 1, type: "pdf", hash: "book", page: 1, y: 0,
  quote: { exact: "Dynamic", prefix: "", suffix: "" },
  regions: [{ page: 1, rects: [[461.474, 697.298, 529.110, 718.506]] }],
};
it("recognizes the same word despite browser font-metric drift after zoom", () => {
  const zoomed = structuredClone(saved);
  zoomed.regions![0].rects = [[461.616, 697.210, 529.272, 716.600]];
  expect(samePassage(saved, zoomed)).toBe(true);
});
it("does not confuse a repeated word on a neighboring line or another page", () => {
  const nextLine = structuredClone(saved);
  nextLine.regions![0].rects = [[461.474, 677.298, 529.110, 698.506]];
  expect(samePassage(saved, nextLine)).toBe(false);
  expect(samePassage(saved, { ...saved, page: 2 })).toBe(false);
  expect(samePassage(saved, { ...saved, hash: "other-book" })).toBe(false);
});
it("keeps partial selections and nearby unquoted regions distinct", () => {
  expect(samePassage(saved, { ...saved, quote: { exact: "Dynam", prefix: "", suffix: "" } })).toBe(false);
  const shifted = structuredClone(saved);
  shifted.regions![0].rects = [[461.474, 697.298, 529.110, 716.600]];
  expect(samePassage({ ...saved, quote: undefined }, { ...shifted, quote: undefined })).toBe(false);
});
