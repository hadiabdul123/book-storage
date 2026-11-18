export type TextPoint = { node: Text; offset: number };

export function pdfTextPoint(host: HTMLElement, x: number, y: number): TextPoint | undefined {
  const doc = host.ownerDocument;
  const page = doc.elementFromPoint(x, y)?.closest(".pdf-page");
  if (!page || !host.contains(page)) return;
  const layer = page.querySelector(".textLayer");
  if (!layer) return;
  const probe = doc.createRange();
  const contains = (rect: DOMRect) => rect.width > 0 && rect.height > 0 &&
    x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top && y <= rect.bottom;
  const run = (node: Node | null | undefined): node is Text => {
    if (node?.nodeType !== 3 || !layer.contains(node) || !node.textContent?.trim()) return false;
    probe.selectNodeContents(node);
    return Array.from(probe.getClientRects()).some(contains);
  };
  const position = doc.caretPositionFromPoint?.(x, y);
  const native = position ? undefined : doc.caretRangeFromPoint?.(x, y);
  const node = position?.offsetNode ?? native?.startContainer;
  if (run(node)) return { node, offset: position?.offset ?? native!.startOffset };

  // PDF.js can give text runs pointer-events:none. Only examine runs on the
  // hit page and accept a caret when the pointer is actually over their text.
  const walker = doc.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const box = text.parentElement?.getBoundingClientRect();
    if (!box || !contains(box) || !run(text)) continue;
    let best = 0, distance = Infinity;
    for (let i = 0; i <= text.length; i++) {
      probe.setStart(text, i); probe.collapse(true);
      const rect = probe.getBoundingClientRect();
      const delta = Math.hypot(x - (rect.left + rect.right) / 2, y - (rect.top + rect.bottom) / 2);
      if (delta < distance) { best = i; distance = delta; }
    }
    return { node: text, offset: best };
  }
}
