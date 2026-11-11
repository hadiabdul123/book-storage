import type { Quote, Rect } from "./model";

export function textNodes(root: Node): Text[] {
  const doc = root.ownerDocument || document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.parentElement?.closest("script,style,[data-leafmark-overlay]")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const result: Text[] = [];
  let n;
  while ((n = walker.nextNode())) result.push(n as Text);
  return result;
}
export function quoteAt(text: string, start: number, end: number): Quote {
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - 48), start),
    suffix: text.slice(end, end + 48),
  };
}
export function offsetsForRange(root: Node, range: Range) {
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  )
    throw new Error("Select text within this document.");
  const nodes = textNodes(root),
    doc = root.ownerDocument || document;
  const measure = (container: Node, offset: number) => {
    const prefix = doc.createRange();
    prefix.selectNodeContents(root);
    prefix.setEnd(container, offset);
    return textNodes(prefix.cloneContents()).reduce(
      (sum, node) => sum + node.length,
      0,
    );
  };
  const start = measure(range.startContainer, range.startOffset),
    end = measure(range.endContainer, range.endOffset);
  if (end < start) throw new Error("Select text within this document.");
  return {
    start,
    end,
    quote: quoteAt(nodes.map((n) => n.data).join(""), start, end),
  };
}
export function rangeForOffsets(
  root: Node,
  start: number,
  end: number,
): Range | null {
  const nodes = textNodes(root),
    doc = root.ownerDocument || document;
  const range = doc.createRange();
  let offset = 0,
    found = false;
  for (const node of nodes) {
    if (!found && start <= offset + node.length) {
      range.setStart(node, Math.max(0, start - offset));
      found = true;
    }
    if (found && end <= offset + node.length) {
      range.setEnd(node, Math.max(0, end - offset));
      return range;
    }
    offset += node.length;
  }
  return null;
}
export function findQuote(
  text: string,
  quote: Quote,
): { start: number; end: number } | null {
  if (!quote.exact) return null;
  const candidates: { start: number; score: number }[] = [];
  let start = text.indexOf(quote.exact);
  while (start >= 0) {
    const before = text.slice(Math.max(0, start - quote.prefix.length), start),
      after = text.slice(
        start + quote.exact.length,
        start + quote.exact.length + quote.suffix.length,
      );
    const score =
      (quote.prefix && before === quote.prefix ? 1 : 0) +
      (quote.suffix && after === quote.suffix ? 1 : 0);
    candidates.push({ start, score });
    start = text.indexOf(quote.exact, start + 1);
  }
  candidates.sort((a, b) => b.score - a.score);
  if (
    !candidates.length ||
    (candidates.length > 1 && candidates[0].score === candidates[1].score)
  )
    return null;
  return {
    start: candidates[0].start,
    end: candidates[0].start + quote.exact.length,
  };
}
export function normalizeRect([x1, y1, x2, y2]: Rect): Rect {
  return [
    Math.min(x1, x2),
    Math.min(y1, y2),
    Math.max(x1, x2),
    Math.max(y1, y2),
  ];
}
export function csvCell(value: string) {
  return `"${value.replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
}
