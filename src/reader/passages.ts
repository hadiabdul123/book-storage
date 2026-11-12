import type { Locator } from "../model";

export const samePassage = (a: Locator, b: Locator) => {
  if (a.type !== b.type || a.hash !== b.hash) return false;
  if (a.type === "docx" && b.type === "docx")
    return a.start === b.start && a.end === b.end;
  if (a.type === "epub" && b.type === "epub") return a.cfi === b.cfi;
  if (a.type === "pdf" && b.type === "pdf") {
    if (a.quote?.exact && b.quote?.exact && a.quote.exact !== b.quote.exact) return false;
    const sameQuote = !!a.quote?.exact && a.quote.exact === b.quote?.exact;
    return (
      a.page === b.page &&
      a.regions?.length === b.regions?.length &&
      !!a.regions?.every((region, i) => {
        const other = b.regions![i];
        return (
          region.page === other.page &&
          region.rects.length === other.rects.length &&
          region.rects.every((r, j) => {
            const otherRect = other.rects[j];
            // Browser text metrics vary slightly across PDF zoom levels. Only
            // tolerate that drift for the same quote in the same small region.
            const tolerance = sameQuote
              ? Math.max(1, Math.min(3, Math.max(r[3] - r[1], otherRect[3] - otherRect[1]) * 0.15))
              : 1;
            return r.every((v, k) => Math.abs(v - otherRect[k]) < tolerance);
          })
        );
      })
    );
  }
  return false;
};
