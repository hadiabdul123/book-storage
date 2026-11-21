import type { Selection } from "./reader/types";

export type DropPoint = { x: number; y: number };

export function markStudyDrop(point?: DropPoint, overNotebook = true) {
  document.dispatchEvent(new CustomEvent("leafmark-study-drag-point", { detail: point ?? null }));
  document.dispatchEvent(new CustomEvent("leafmark-study-drop-preview", { detail: overNotebook ? point ?? null : null }));
}

export function bindStudyPassageDrag(host: HTMLElement, passageAt: (point: DropPoint) => Selection | undefined,
  drop: (selection: Selection, point: DropPoint) => void, clear: () => void) {
  let drag: { id: number; start: DropPoint; selection: Selection; moved: boolean } | undefined;
  const listeners = new AbortController();
  const options = { capture: true, signal: listeners.signal };
  function end() {
    if (drag && host.hasPointerCapture(drag.id)) host.releasePointerCapture(drag.id);
    drag = undefined;
    markStudyDrop();
  }
  const onPaper = (x: number, y: number) => {
    const hit = document.elementFromPoint(x,y);
    const body = hit?.closest(".reader-panel .panel-body");
    return !!body?.querySelector(".study-notebook") &&
      !hit?.closest("button,input,select,textarea,summary,.note-tool-rail");
  };
  let native: Selection | undefined;
  const transfer = "application/x-leafmark-pdf-passage";
  host.addEventListener("dragstart", event => {
    if (!host.closest(".reader-shell[data-study-open]") || !event.dataTransfer) return;
    native = passageAt({x:event.clientX,y:event.clientY});
    if (!native) return;
    event.dataTransfer.setData(transfer,"passage");
    event.dataTransfer.setData("text/plain",native.text);
    event.dataTransfer.effectAllowed = "copy";
  }, options);
  document.addEventListener("dragover", event => {
    if (!native || !event.dataTransfer?.types.includes(transfer) || !onPaper(event.clientX,event.clientY)) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy";
    markStudyDrop({x:event.clientX,y:event.clientY});
  }, options);
  document.addEventListener("drop", event => {
    if (!native || !event.dataTransfer?.types.includes(transfer) || !onPaper(event.clientX,event.clientY)) return;
    event.preventDefault(); event.stopPropagation();
    const selection = native; native = undefined; end();
    drop(selection,{x:event.clientX,y:event.clientY});
  }, options);
  host.addEventListener("dragend", () => {native = undefined; end();}, options);
  host.addEventListener("pointerdown", event => {
    if (drag) { end(); return; }
    if (!event.isPrimary || event.button !== 0 || !host.closest(".reader-shell[data-study-open]") ||
        (event.target as Element).closest("button,input,.pdf-selection-handle")) return;
    const start = { x: event.clientX, y: event.clientY };
    const selection = passageAt(start);
    if (!selection) return;
    event.preventDefault(); event.stopImmediatePropagation();
    host.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, start, selection, moved: false };
  }, options);
  const holdTouch = (event: TouchEvent) => {
    if (!drag) return;
    if (event.touches.length > 1) { end(); return; }
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  };
  host.addEventListener("touchstart", holdTouch, {...options,passive:false});
  host.addEventListener("touchmove", holdTouch, {...options,passive:false});
  host.addEventListener("pointermove", event => {
    if (!drag || drag.id !== event.pointerId) return;
    event.stopImmediatePropagation();
    drag.moved ||= Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y) >= 6;
    if (drag.moved) markStudyDrop({ x: event.clientX, y: event.clientY }, onPaper(event.clientX, event.clientY));
  }, options);
  host.addEventListener("pointerup", event => {
    if (!drag || drag.id !== event.pointerId) return;
    const { selection, moved } = drag;
    event.preventDefault(); event.stopImmediatePropagation();
    end();
    if (moved && onPaper(event.clientX, event.clientY)) drop(selection, { x: event.clientX, y: event.clientY });
    else if (!moved) clear();
  }, options);
  host.addEventListener("pointercancel", end, options);
  host.addEventListener("lostpointercapture", () => { if (drag) end(); }, options);
  window.addEventListener("blur", end, options);
  return () => { listeners.abort(); end(); };
}
