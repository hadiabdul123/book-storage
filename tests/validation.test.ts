import { describe, it, expect } from "vitest";
import { validLocator, validAnnotation } from "../src/validation";
const base = { v: 1, hash: "a".repeat(64) };
describe("backup validation", () => {
  it("accepts versioned, finite document coordinates", () => {
    expect(
      validLocator({
        ...base,
        type: "pdf",
        page: 1,
        y: 0.2,
        point: [1, 2],
        regions: [{ page: 1, rects: [[10, 20, 30, 40]] }],
      }),
    ).toBe(true);
    expect(validLocator({ ...base, type: "docx", start: 0, end: 5 })).toBe(
      true,
    );
  });
  it("rejects malformed coordinates and impossible ranges", () => {
    for (const locator of [
      { ...base, type: "pdf", page: 0, y: 0 },
      { ...base, type: "pdf", page: 1, y: Infinity },
      {
        ...base,
        type: "pdf",
        page: 1,
        y: 0,
        regions: [{ page: 1, rects: ["bad"] }],
      },
      { ...base, type: "docx", start: 5, end: 1 },
    ])
      expect(validLocator(locator)).toBe(false);
  });
  it("rejects partial annotations before they enter the library", () => {
    expect(
      validAnnotation({
        id: "x",
        locator: { ...base, type: "docx", start: 0, end: 1 },
      }),
    ).toBe(false);
  });
});
