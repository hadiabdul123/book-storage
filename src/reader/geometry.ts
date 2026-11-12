import type { ScreenRect } from "./types";
export function overlap(a: ScreenRect, b: ScreenRect) {
  return (
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5
  );
}
export function rangeOverlap(a: Range, b: Range) {
  if (a.startContainer.ownerDocument !== b.startContainer.ownerDocument)
    return false;
  const startA = a.cloneRange(),
    endA = a.cloneRange(),
    startB = b.cloneRange(),
    endB = b.cloneRange();
  startA.collapse(true);
  endA.collapse(false);
  startB.collapse(true);
  endB.collapse(false);
  return (
    startA.compareBoundaryPoints(0, endB) < 0 &&
    endA.compareBoundaryPoints(0, startB) > 0
  );
}
export function rectsForRange(range: Range): ScreenRect[] {
  const measured = range.cloneRange();
  if (measured.collapsed && measured.startContainer.nodeType === 1) {
    const container = measured.startContainer;
    const child =
      container.childNodes[measured.startOffset] ||
      container.childNodes[measured.startOffset - 1];
    if (child) {
      const text =
        child.nodeType === 3
          ? child
          : child.ownerDocument?.createTreeWalker(child, 4).nextNode();
      if (text?.textContent?.length) {
        measured.setStart(text, 0);
        measured.setEnd(text, 1);
      } else if (child.nodeType === 1) {
        const rect = (child as Element).getBoundingClientRect();
        return rect.height
          ? [
              {
                left: rect.left,
                right: rect.left + 1,
                top: rect.top,
                bottom: rect.top + 2,
              },
            ]
          : [];
      }
    }
  }
  if (measured.collapsed && measured.startContainer.nodeType === 3) {
    const length = measured.startContainer.textContent?.length || 0;
    if (measured.startOffset < length)
      measured.setEnd(measured.startContainer, measured.startOffset + 1);
    else if (length) measured.setStart(measured.startContainer, length - 1);
  }
  return Array.from(measured.getClientRects())
    .filter((r) => r.height > 0)
    .map((r) => ({
      left: r.left,
      top: r.top,
      right: Math.max(r.left + 1, r.right),
      bottom: r.bottom,
    }));
}
export function typingTarget(target: EventTarget | null) {
  // Do not use instanceof HTMLElement: EPUB elements belong to another window.
  return !!(target as Element | null)?.closest?.(
    'input, textarea, select, [contenteditable="true"], [role="textbox"]',
  );
}
