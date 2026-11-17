/** Read the final browser range without building reader locators on drag frames. */
export function bindNativeSelection(root: HTMLElement, options: {
  selected: (range: Range | null) => void;
  dragging?: (active: boolean) => void;
  allowed?: (target: Element) => boolean;
}) {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  const iframe = win.frameElement;
  const outer = iframe?.ownerDocument.defaultView;
  const clock = outer ?? win;
  let press: { id: number; x: number; y: number; moved: boolean } | undefined;
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

  function schedule() {
    if (press || frame) return;
    frame = clock.requestAnimationFrame(() => {
      frame = 0;
      if (!press) read();
    });
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
    releaseListeners?.abort();
    releaseListeners = undefined;
    clock.cancelAnimationFrame(frame);
    // Default mouseup processing can still change the native range.
    frame = clock.requestAnimationFrame(() => {
      frame = 0;
      press = undefined;
      read(moved);
      options.dragging?.(false);
    });
  }

  function move(event: PointerEvent) {
    if (!press || event.pointerId !== press.id) return;
    if ((event.buttons & 1) === 0) {
      release(event);
    } else if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 3) {
      press.moved = true;
    }
  }

  function down(event: PointerEvent) {
    if (event.pointerType !== "mouse" || !event.isPrimary || event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest?.("button,a,input,textarea,select,[contenteditable]") || options.allowed?.(target) === false) return;
    cancel();
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
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
  doc.addEventListener("selectionchange", schedule);
  win.addEventListener("pagehide", cancel);
  return () => {
    cancel();
    root.removeEventListener("pointerdown", down, true);
    doc.removeEventListener("selectionchange", schedule);
    win.removeEventListener("pagehide", cancel);
  };
}
