import { useEffect, useRef, type MouseEvent, type PointerEvent } from "react";
import { GripVertical } from "lucide-react";
import type { Move } from "./reordering";
import "./reorder.css";

export function ReorderGrip({ title }: { title: string }) {
  return <span className="reorder-grip" title={`Hold and drag ${title}`} aria-hidden="true"><GripVertical size={17} /></span>;
}

export function useReorderDrag(enabled: boolean, drop: (id: string, target: Move) => void, grid = false) {
  const cleanup = useRef<() => void>(undefined);
  const suppress = useRef(0);
  useEffect(() => () => cleanup.current?.(), [enabled]);

  function onPointerDown(event: PointerEvent<HTMLElement>) {
    if (!enabled || event.button !== 0 || !event.isPrimary || cleanup.current) return;
    const root = event.currentTarget, target = event.target as Element;
    const item = target.closest<HTMLElement>("[data-reorder-id]");
    const grip = !!target.closest(".reorder-grip");
    if (!item || !root.contains(item) || (!grip && event.pointerType !== "mouse") ||
        target.closest(".workspace-more, .workspace-menu, .icon-button, input, select")) return;
    if (grip) event.preventDefault();
    const pointer = event.pointerId, start = { x: event.clientX, y: event.clientY };
    const listeners = new AbortController(), { signal } = listeners;
    let point = start, active = false, frame = 0;
    let over: HTMLElement | undefined, after = false;
    let scroller: HTMLElement | null = root;
    while (scroller && (scroller.scrollHeight <= scroller.clientHeight || !/auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    function update() {
      const hit = document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>("[data-reorder-id]");
      if (hit !== over) over?.removeAttribute("data-drop-side");
      over = hit && hit !== item && root.contains(hit) ? hit : undefined;
      if (!over) return;
      const box = over.getBoundingClientRect();
      after = grid ? point.x > box.left + box.width / 2 : point.y > box.top + box.height / 2;
      over.dataset.dropSide = after ? "after" : "before";
    }
    function scroll() {
      const bounds = scroller?.getBoundingClientRect();
      const top = Math.max(0, bounds?.top ?? 0), bottom = Math.min(innerHeight, bounds?.bottom ?? innerHeight);
      const edge = 36;
      const delta = point.y < top + edge && point.y >= top - 16 ? -8 : point.y > bottom - edge && point.y <= bottom + 16 ? 8 : 0;
      if (delta) { if (scroller) scroller.scrollTop += delta; else window.scrollBy(0, delta); update(); }
      frame = requestAnimationFrame(scroll);
    }
    function begin() {
      active = true;
      item!.dataset.dragging = "true";
      root.dataset.reordering = "true";
      if (root.isConnected) root.setPointerCapture(pointer);
      frame = requestAnimationFrame(scroll);
    }
    const timer = setTimeout(begin, grip ? 160 : 280);
    function end() {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      listeners.abort();
      item!.removeAttribute("data-dragging");
      root.removeAttribute("data-reordering");
      over?.removeAttribute("data-drop-side");
      if (root.hasPointerCapture(pointer)) root.releasePointerCapture(pointer);
      cleanup.current = undefined;
    }
    cleanup.current = end;
    window.addEventListener("pointermove", next => {
      if (next.pointerId !== pointer) return;
      point = { x: next.clientX, y: next.clientY };
      if (!active && Math.hypot(point.x - start.x, point.y - start.y) > 8) {
        clearTimeout(timer);
        if (grip) begin(); else { end(); return; }
      }
      if (active) { next.preventDefault(); update(); }
    }, { signal, passive: false });
    window.addEventListener("pointerup", next => {
      if (next.pointerId !== pointer) return;
      if (active) {
        suppress.current = performance.now() + 350;
        point = { x: next.clientX, y: next.clientY };
        update();
        const id = item.dataset.reorderId, at = over?.dataset.reorderId;
        if (id && at) drop(id, { id: at, after });
      }
      end();
    }, { signal });
    window.addEventListener("pointercancel", next => { if (next.pointerId === pointer) end(); }, { signal });
    window.addEventListener("blur", end, { signal });
    window.addEventListener("keydown", next => { if (next.key === "Escape") { if (active) suppress.current = performance.now() + 350; end(); } }, { signal });
  }
  function onClickCapture(event: MouseEvent<HTMLElement>) {
    if (event.detail && performance.now() < suppress.current) { event.preventDefault(); event.stopPropagation(); }
  }
  return {
    onPointerDown, onClickCapture,
    onDragStart: (event: React.DragEvent<HTMLElement>) => {
      if (enabled && (event.target as Element).closest("[data-reorder-id]")) event.preventDefault();
    },
  };
}
