import { describe, it, expect } from "vitest";
import { findQuote, normalizeRect, quoteAt, csvCell } from "../src/anchors";
import { readingSeconds } from "../src/model";
describe("durable quote resolution", () => {
  it("uses context to distinguish repeated text", () => {
    const text = "first: repeated passage. second: repeated passage.";
    const at = text.lastIndexOf("repeated passage");
    const quote = quoteAt(text, at, at + 16);
    expect(findQuote(text, quote)).toEqual({ start: at, end: at + 16 });
  });
  it("refuses an ambiguous quotation rather than jumping to a wrong passage", () => {
    expect(
      findQuote("same text, same text", {
        exact: "same text",
        prefix: "",
        suffix: "",
      }),
    ).toBeNull();
  });
  it("survives inserted text before a uniquely quoted passage", () => {
    const text = "A passage with unicode: café 中文 🌿.";
    const quote = quoteAt(text, 15, text.length);
    expect(findQuote("new preface " + text, quote)).toEqual({
      start: 27,
      end: text.length + 12,
    });
  });
  it("never guesses missing or empty quotes", () => {
    expect(
      findQuote("content", { exact: "missing", prefix: "", suffix: "" }),
    ).toBeNull();
    expect(
      findQuote("content", { exact: "", prefix: "", suffix: "" }),
    ).toBeNull();
  });
  it("normalizes reversed PDF coordinates without changing document-space bounds", () => {
    expect(normalizeRect([125, 700, 20, 680])).toEqual([20, 680, 125, 700]);
  });
});
describe("exports and statistics", () => {
  it("escapes quotes and neutralizes spreadsheet formulas", () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
  });
  it("counts simultaneous devices once and clips to the reporting day", () => {
    const sessions = [
      { id: "a", bookId: "b", device: "pc", start: 1000, end: 11000 },
      { id: "b", bookId: "b", device: "phone", start: 6000, end: 16000 },
    ];
    expect(readingSeconds(sessions)).toBe(15);
    expect(readingSeconds(sessions, 8000, 13000)).toBe(5);
  });
});
