type Point = { node: Text; offset: number };

/** Preserve native selection; supply word selection and handles if Chrome creates none. */
export function bindPdfTouch(
  host: HTMLElement,
  prepare: (page: HTMLElement) => Promise<void>,
) {
  const doc = host.ownerDocument;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gesture:
    | { x: number; y: number; page: HTMLElement; time: number; scroll: number }
    | undefined;
  let generation = 0;
  let fallback: Range | undefined;
  const handles: HTMLButtonElement[] = [];
  const caret = (x: number, y: number): Point | undefined => {
    const pos = doc.caretPositionFromPoint?.(x, y);
    const range = !pos ? doc.caretRangeFromPoint?.(x, y) : undefined;
    const node = pos?.offsetNode || range?.startContainer;
    const offset = pos?.offset ?? range?.startOffset ?? 0;
    if (
      node?.nodeType === Node.TEXT_NODE &&
      host.contains(node) &&
      node.parentElement?.closest(".textLayer")
    )
      return { node: node as Text, offset };
  };
  const wordAt = (x: number, y: number) => {
    const point = caret(x, y);
    if (!point) return;
    const words = [
      ...point.node.data.matchAll(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'\u2019_-]*/gu),
    ];
    const word = words.find(
      (w) => w.index! <= point.offset && w.index! + w[0].length >= point.offset,
    );
    if (!word) return;
    const range = doc.createRange();
    range.setStart(point.node, word.index!);
    range.setEnd(point.node, word.index! + word[0].length);
    return range;
  };
  const clearHandles = () => {
    fallback = undefined;
    handles.splice(0).forEach((h) => h.remove());
  };
  const cancel = () => {
    clearTimeout(timer);
    gesture = undefined;
    generation++;
  };
  const positionHandles = () => {
    if (!fallback?.startContainer.isConnected) {
      clearHandles();
      return;
    }
    const rects = [...fallback.getClientRects()].filter(
      (r) => r.width && r.height,
    );
    if (!rects.length) return;
    const clip = host.getBoundingClientRect();
    handles.forEach((handle, i) => {
      const r = i === 0 ? rects[0] : rects[rects.length - 1];
      const x = i === 0 ? r.left : r.right;
      handle.style.left = `${x - 22}px`;
      handle.style.top = `${i === 0 ? r.top - 44 : r.bottom}px`;
      handle.hidden =
        r.bottom < clip.top ||
        r.top > clip.bottom ||
        x < clip.left ||
        x > clip.right;
    });
  };
  const apply = (range: Range) => {
    fallback = range.cloneRange();
    const selection = doc.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    positionHandles();
    doc.dispatchEvent(new Event("selectionchange"));
  };
  const showHandles = () => {
    if (handles.length) return;
    for (const edge of ["start", "end"] as const) {
      const handle = doc.createElement("button");
      handle.className = `pdf-selection-handle ${edge}`;
      handle.setAttribute("aria-label", `Drag selection ${edge}`);
      let dragging = false;
      handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        handle.setPointerCapture(e.pointerId);
      });
      handle.addEventListener("pointermove", (e) => {
        if (!dragging || !fallback) return;
        e.preventDefault();
        // Keep the glyph endpoint above/below the finger, matching the handle offset.
        handle.style.pointerEvents = "none";
        const word = wordAt(
          e.clientX,
          e.clientY + (edge === "start" ? 28 : -28),
        );
        handle.style.pointerEvents = "";
        if (!word) return;
        const range = fallback.cloneRange();
        if (edge === "start")
          range.setStart(word.startContainer, word.startOffset);
        else range.setEnd(word.endContainer, word.endOffset);
        if (!range.collapsed) apply(range);
      });
      const stop = () => {
        dragging = false;
      };
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
      // Keyboard users can extend a fallback selection by character as well.
      handle.addEventListener("keydown", (e) => {
        if (!fallback || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
        e.preventDefault();
        const range = fallback.cloneRange(),
          delta = e.key === "ArrowRight" ? 1 : -1;
        const node =
          edge === "start" ? range.startContainer : range.endContainer;
        const offset = edge === "start" ? range.startOffset : range.endOffset;
        const next = Math.max(
          0,
          Math.min(node.textContent?.length || 0, offset + delta),
        );
        if (edge === "start") range.setStart(node, next);
        else range.setEnd(node, next);
        if (!range.collapsed) apply(range);
      });
      (host.closest(".reader-shell") || host).append(handle);
      handles.push(handle);
    }
  };
  const select = (x: number, y: number) => {
    const range = wordAt(x, y);
    if (!range) return;
    showHandles();
    apply(range);
  };
  const hold = async () => {
    const began = gesture,
      token = generation;
    if (!began || doc.getSelection()?.toString().trim()) return;
    try {
      await prepare(began.page);
      if (
        token !== generation ||
        !began.page.isConnected ||
        host.scrollTop !== began.scroll
      )
        return;
      if (!doc.getSelection()?.toString().trim()) select(began.x, began.y);
    } catch {
      /* The adapter displays OCR errors and a retry action. */
    }
  };
  const start = (e: TouchEvent) => {
    cancel();
    if (e.touches.length !== 1 || host.classList.contains("region-mode"))
      return;
    const target = e.target as Element;
    if (target.closest("button,a,input,textarea,[contenteditable]")) return;
    const page = target.closest<HTMLElement>(".pdf-page");
    if (!page) return;
    const t = e.touches[0];
    gesture = {
      x: t.clientX,
      y: t.clientY,
      page,
      time: Date.now(),
      scroll: host.scrollTop,
    };
    timer = setTimeout(() => void hold(), 600);
  };
  const move = (e: TouchEvent) => {
    if (
      gesture &&
      (e.touches.length !== 1 ||
        Math.hypot(
          e.touches[0].clientX - gesture.x,
          e.touches[0].clientY - gesture.y,
        ) > 10)
    )
      cancel();
  };
  const end = () => {
    clearTimeout(timer);
    if (gesture && Date.now() - gesture.time >= 450) void hold();
    // An OCR job started by a stationary hold may finish after the finger lifts.
    gesture = undefined;
  };
  const context = (e: MouseEvent) => {
    if (gesture || fallback) {
      e.preventDefault();
      if (gesture) void hold();
    }
  };
  const changed = () => {
    const selection = doc.getSelection();
    if (fallback && (!selection?.rangeCount || selection.isCollapsed))
      clearHandles();
  };
  const scroll = () => {
    cancel();
    positionHandles();
  };
  host.addEventListener("touchstart", start, { passive: true });
  host.addEventListener("touchmove", move, { passive: true });
  host.addEventListener("touchend", end, { passive: true });
  host.addEventListener("touchcancel", cancel, { passive: true });
  host.addEventListener("contextmenu", context);
  host.addEventListener("scroll", scroll, { passive: true });
  doc.addEventListener("selectionchange", changed);
  return {
    select,
    clear: clearHandles,
    destroy() {
      cancel();
      clearHandles();
      host.removeEventListener("touchstart", start);
      host.removeEventListener("touchmove", move);
      host.removeEventListener("touchend", end);
      host.removeEventListener("touchcancel", cancel);
      host.removeEventListener("contextmenu", context);
      host.removeEventListener("scroll", scroll);
      doc.removeEventListener("selectionchange", changed);
    },
  };
}
