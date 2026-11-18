import type { TextPoint } from "./pdfTextPoint";

/** Read the final browser range without building reader locators on drag frames. */
export function bindNativeSelection(root: HTMLElement, options: {
  selected: (range: Range | null) => void;
  dragging?: (active: boolean) => void;
  allowed?: (target: Element) => boolean;
  textPoint?: (x: number, y: number) => TextPoint | undefined;
}) {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  const iframe = win.frameElement;
  const outer = iframe?.ownerDocument.defaultView;
  const clock = outer ?? win;
  let press: { id: number; x: number; y: number; moved: boolean; anchor?: TextPoint; end?: TextPoint } | undefined;
  let releaseListeners: AbortController | undefined;
  let frame = 0;

  function read(clearEmpty = false) {
    const selection = doc.getSelection();
    if (root.isConnected && (!iframe || iframe.isConnected) && selection?.rangeCount && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      if (root.contains(range.startContainer) && root.contains(range.endContainer) && selection.toString().trim()) {
        options.selected(range);
        return;
      }
    }
    if (clearEmpty) options.selected(null);
  }

  function selectionChanged() {
    if (!press) read();
  }

  function cancel() {
    clock.cancelAnimationFrame(frame);
    frame = 0;
    releaseListeners?.abort();
    releaseListeners = undefined;
    const began = press;
    press = undefined;
    if (!began) return;
    if (began.moved) options.selected(null);
    options.dragging?.(false);
  }

  function release(event: PointerEvent) {
    if (!press || event.pointerId !== press.id) return;
    const moved = press.moved || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 3;
    const began = press;
    if (moved && began.anchor) began.end = options.textPoint?.(event.clientX, event.clientY) ?? began.end;
    releaseListeners?.abort();
    releaseListeners = undefined;
    clock.cancelAnimationFrame(frame);
    // Default mouseup processing can still change the native range.
    frame = clock.requestAnimationFrame(() => {
      frame = 0;
      if (moved) showRange(began);
      press = undefined;
      read(moved);
      options.dragging?.(false);
    });
  }

  function showRange(began: NonNullable<typeof press>) {
    const { anchor, end } = began;
    if (!anchor || !end || !root.contains(anchor.node) || !root.contains(end.node)) return;
    const current = doc.getSelection();
    if (current && (current.anchorNode !== anchor.node || current.anchorOffset !== anchor.offset ||
        current.focusNode !== end.node || current.focusOffset !== end.offset)) {
      current.setBaseAndExtent(anchor.node, anchor.offset, end.node, end.offset);
    }
  }

  function move(event: PointerEvent) {
    if (!press || event.pointerId !== press.id) return;
    if ((event.buttons & 1) === 0) {
      release(event);
    } else if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 3) {
      press.moved = true;
      if (press.anchor) {
        press.end = options.textPoint?.(event.clientX, event.clientY) ?? press.end;
        if (!frame) frame = clock.requestAnimationFrame(() => {
          frame = 0;
          if (press) showRange(press);
        });
      }
    }
  }

  function down(event: PointerEvent) {
    if (event.pointerType !== "mouse" || !event.isPrimary || event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest?.("button,a,input,textarea,select,[contenteditable]") || options.allowed?.(target) === false) return;
    cancel();
    const anchor = options.textPoint?.(event.clientX, event.clientY);
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, anchor, end: anchor };
    options.dragging?.(true);
    releaseListeners = new AbortController();
    const listener = { capture: true, signal: releaseListeners.signal };
    const pointerCancel = (e: PointerEvent) => { if (e.pointerId === press?.id) cancel(); };
    for (const surface of outer ? [win, outer] : [win]) {
      surface.addEventListener("pointerup", release, listener);
      surface.addEventListener("pointermove", move, listener);
      surface.addEventListener("pointercancel", pointerCancel, listener);
    }
    // Clicking into an EPUB frame blurs the outer window as focus enters
    // the iframe. Only losing the selection's own window ends the drag.
    win.addEventListener("blur", cancel, listener);
  }

  root.addEventListener("pointerdown", down, true);
  doc.addEventListener("selectionchange", selectionChanged);
  win.addEventListener("pagehide", cancel);
  return () => {
    cancel();
    root.removeEventListener("pointerdown", down, true);
    doc.removeEventListener("selectionchange", selectionChanged);
    win.removeEventListener("pagehide", cancel);
  };
}
