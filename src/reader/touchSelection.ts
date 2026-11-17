type Point = { node: Text; offset: number };
export type TouchSelection = ReturnType<typeof bindTouchSelection>;

/** A Range is our model, never a browser Selection: Android has no native
 * selection to attach its action bar to. Text stays in the accessibility tree. */
export function bindTouchSelection(root: HTMLElement, options: {
  selected: (range: Range) => void;
  adjusting?: (active: boolean) => void;
  cleared?: () => void;
  prepare?: (element: HTMLElement) => Promise<void>;
  allowed?: () => boolean;
  scrollHost?: HTMLElement;
}) {
  const doc = root.ownerDocument, win = doc.defaultView!;
  const scrollHost = options.scrollHost || root;
  let range: Range | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let press: { x: number; y: number; element: HTMLElement; at: number; scroll: number } | undefined;
  let generation = 0, frame = 0, destroyed = false, handleDragging = false;
  const handles: HTMLButtonElement[] = [];
  const dragCleanups: (() => void)[] = [];
  const overlay = doc.createElement("div");
  overlay.className = "app-selection-overlay"; overlay.setAttribute("aria-hidden", "true");
  const style = doc.createElement("style");
  style.textContent = `
    .app-touch-selection,.app-touch-selection *:not(input):not(textarea):not([contenteditable]){user-select:none!important;-webkit-user-select:none!important;-webkit-touch-callout:none!important}
    .app-selection-overlay{position:fixed;inset:0;pointer-events:none;z-index:43;overflow:hidden}
    .app-selection-overlay i{position:absolute;background:#78acd777;pointer-events:none}
    .pdf-selection-handle{position:fixed;z-index:44;width:44px;height:44px;padding:0;border:0;background:transparent;touch-action:none;user-select:none;-webkit-user-select:none}
    .pdf-selection-handle:after{content:"";display:block;width:16px;height:16px;margin:12px;border:2px solid white;border-radius:50%;background:#315c86;box-shadow:0 1px 4px #0005}
    .pdf-selection-handle[hidden]{display:none}
  `;
  doc.head.append(style);
  const container = root.closest(".reader-shell") || doc.body;
  const valid = (node: Node | null): node is Text => !!node && node.nodeType === 3 && root.contains(node) &&
    !!node.textContent?.trim() && !node.parentElement?.closest("button,a,input,textarea,[contenteditable],svg,script,style,.app-selection-overlay");
  const caret = (x: number, y: number): Point | undefined => {
    const pos = doc.caretPositionFromPoint?.(x, y);
    const hit = !pos ? doc.caretRangeFromPoint?.(x, y) : undefined;
    const node = pos?.offsetNode || hit?.startContainer;
    if (valid(node || null)) return { node: node as Text, offset: pos?.offset ?? hit?.startOffset ?? 0 };
    // Some engines exclude user-select:none text from caret hit testing. Limit
    // the fallback to the element under the finger, then binary-search glyphs.
    const target = doc.elementFromPoint(x, y);
    if (!target || !root.contains(target)) return;
    const walker = doc.createTreeWalker(target, 4);
    let text: Node | null;
    while ((text = walker.nextNode())) {
      if (!valid(text)) continue;
      const probe = doc.createRange(); probe.selectNodeContents(text);
      if (![...probe.getClientRects()].some(r => x >= r.left - 2 && x <= r.right + 2 && y >= r.top && y <= r.bottom)) continue;
      let low = 0, high = text.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        probe.setStart(text, mid); probe.setEnd(text, mid + 1);
        const r = probe.getBoundingClientRect();
        if (y > r.bottom || (y >= r.top && x > r.right)) low = mid + 1;
        else high = mid;
      }
      return { node: text, offset: Math.min(low, text.length) };
    }
  };
  const wordAt = (x: number, y: number) => {
    const point = caret(x, y);
    if (!point) return;
    const word = [...point.node.data.matchAll(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’_-]*/gu)]
      .find(w => w.index! <= point.offset && w.index! + w[0].length >= point.offset);
    if (!word) return;
    const result = doc.createRange(); result.setStart(point.node, word.index!); result.setEnd(point.node, word.index! + word[0].length);
    return result;
  };
  const paint = () => {
    frame = 0;
    if (!range?.startContainer.isConnected) { clear(); return; }
    const clip = scrollHost.getBoundingClientRect();
    const rects = [...range.getClientRects()].filter(r => r.width && r.height);
    overlay.replaceChildren(...rects.filter(r => r.bottom >= clip.top && r.top <= clip.bottom && r.right >= clip.left && r.left <= clip.right).map(r => {
      const mark = doc.createElement("i");
      Object.assign(mark.style, { left: `${Math.max(r.left, clip.left)}px`, top: `${Math.max(r.top, clip.top)}px`, width: `${Math.min(r.right, clip.right) - Math.max(r.left, clip.left)}px`, height: `${Math.min(r.bottom, clip.bottom) - Math.max(r.top, clip.top)}px` });
      return mark;
    }));
    handles.forEach((handle, i) => {
      const r = i ? rects[rects.length - 1] : rects[0];
      if (!r) { handle.hidden = true; return; }
      const x = i ? r.right : r.left;
      Object.assign(handle.style, { left: `${x - 22}px`, top: `${i ? r.bottom : r.top - 44}px` });
      handle.hidden = r.bottom < clip.top || r.top > clip.bottom || x < clip.left || x > clip.right;
    });
    root.dispatchEvent(new Event("reader-layout", { bubbles: true }));
  };
  const schedule = () => { if (range && !frame) frame = win.requestAnimationFrame(paint); };
  function clear(notify = true) {
    handleDragging = false;
    options.adjusting?.(false);
    const hadSelection = !!range;
    range = undefined; dragCleanups.splice(0).forEach(cleanup => cleanup()); handles.splice(0).forEach(h => h.remove()); overlay.remove();
    win.cancelAnimationFrame(frame); frame = 0;
    if (notify && hadSelection && !destroyed) options.cleared?.();
  }
  const cancel = () => { clearTimeout(timer); press = undefined; generation++; if (!handleDragging) options.adjusting?.(false); };
  const apply = (next: Range) => {
    if (next.collapsed || !next.toString().trim()) return;
    range = next.cloneRange();
    if (!overlay.isConnected) container.append(overlay);
    if (!handles.length) for (const edge of ["start", "end"] as const) {
      const handle = doc.createElement("button"); handle.className = `pdf-selection-handle ${edge}`;
      handle.setAttribute("aria-label", `Drag selection ${edge}`);
      let dragging = false, pending: PointerEvent | undefined, dragFrame = 0;
      const move = () => {
        dragFrame = 0;
        if (!dragging || !range || !pending) return;
        handle.style.pointerEvents = "none";
        const word = wordAt(pending.clientX, pending.clientY + (edge === "start" ? 28 : -28));
        handle.style.pointerEvents = "";
        if (!word) return;
        const next = range.cloneRange();
        if (edge === "start") next.setStart(word.startContainer, word.startOffset);
        else next.setEnd(word.endContainer, word.endOffset);
        apply(next);
      };
      handle.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); root.dispatchEvent(new Event("reader-selection-start", { bubbles: true })); dragging = handleDragging = true; options.adjusting?.(true); handle.setPointerCapture(e.pointerId); });
      handle.addEventListener("pointermove", e => { if (!dragging) return; e.preventDefault(); pending = e; if (!dragFrame) dragFrame = win.requestAnimationFrame(move); });
      const stop = () => { if (pending) move(); dragging = handleDragging = false; win.cancelAnimationFrame(dragFrame); options.adjusting?.(false); };
      handle.addEventListener("pointerup", stop); handle.addEventListener("pointercancel", stop);
      handle.addEventListener("keydown", e => {
        if (!range || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
        e.preventDefault(); const next = range.cloneRange(), node = edge === "start" ? next.startContainer : next.endContainer;
        const offset = (edge === "start" ? next.startOffset : next.endOffset) + (e.key === "ArrowRight" ? 1 : -1);
        if (edge === "start") next.setStart(node, Math.max(0, Math.min(node.textContent?.length || 0, offset)));
        else next.setEnd(node, Math.max(0, Math.min(node.textContent?.length || 0, offset)));
        apply(next);
      });
      dragCleanups.push(() => { dragging = false; win.cancelAnimationFrame(dragFrame); });
      container.append(handle); handles.push(handle);
    }
    paint(); options.selected(range);
  };
  const hold = async () => {
    const began = press, token = generation;
    if (!began || options.allowed?.() === false) return;
    // Claim the gesture before asynchronous OCR/text preparation. A held
    // selection must never become a page swipe while that work finishes.
    root.dispatchEvent(new Event("reader-selection-start", { bubbles: true }));
    try {
      await options.prepare?.(began.element);
      if (destroyed || token !== generation || !began.element.isConnected || scrollHost.scrollTop !== began.scroll || options.allowed?.() === false) return;
      const next = wordAt(began.x, began.y); if (next) apply(next);
    } catch { /* OCR errors are reported by the adapter. */ }
  };
  const pointer = (e: PointerEvent) => {
    if (e.pointerType === "mouse") { cancel(); root.classList.remove("app-touch-selection"); clear(); return; }
    root.classList.add("app-touch-selection");
  };
  const start = (e: TouchEvent) => {
    cancel(); root.classList.add("app-touch-selection");
    if (e.touches.length !== 1) { clear(); return; }
    const element = e.target as HTMLElement;
    if (options.allowed?.() === false || element.closest("button,a,input,textarea,select,[contenteditable]")) return;
    clear();
    doc.getSelection()?.removeAllRanges();
    const t = e.touches[0]; press = { x: t.clientX, y: t.clientY, element, at: Date.now(), scroll: scrollHost.scrollTop };
    options.adjusting?.(true);
    timer = setTimeout(() => void hold(), 500);
  };
  const move = (e: TouchEvent) => { if (press && (e.touches.length !== 1 || Math.hypot(e.touches[0].clientX - press.x, e.touches[0].clientY - press.y) > 10)) cancel(); };
  const end = (e: TouchEvent) => {
    clearTimeout(timer);
    const token = generation;
    if (press && Date.now() - press.at >= 450) {
      // A compatibility click at the release point must not activate freshly
      // positioned toolbar buttons underneath the lifting finger.
      if (e.cancelable) e.preventDefault();
      const finished = hold(); press = undefined;
      void finished.finally(() => { if (generation === token) options.adjusting?.(false); });
    } else { press = undefined; if (!handleDragging) options.adjusting?.(false); }
  };
  const context = (e: Event) => { if (root.classList.contains("app-touch-selection")) { e.preventDefault(); if (press) void hold(); } };
  const selectStart = (e: Event) => { if (root.classList.contains("app-touch-selection") && !(e.target as Element).closest("input,textarea,[contenteditable]")) e.preventDefault(); };
  const nativeChanged = () => {
    const selected = doc.getSelection();
    if (selected?.rangeCount && !selected.isCollapsed && root.contains(selected.anchorNode) && root.contains(selected.focusNode)) {
      clear(false); root.classList.remove("app-touch-selection");
    }
  };
  const scroll = () => { cancel(); schedule(); };
  const resize = new ResizeObserver(schedule); resize.observe(scrollHost);
  if (scrollHost !== root) resize.observe(root);
  const layoutChanges = new MutationObserver(schedule);
  layoutChanges.observe(scrollHost, { attributes: true, attributeFilter: ["class", "style"] });
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") { cancel(); clear(); } else if (e.shiftKey) { clear(); root.classList.remove("app-touch-selection"); } };
  root.addEventListener("pointerdown", pointer, { capture: true });
  root.addEventListener("touchstart", start, { passive: true }); root.addEventListener("touchmove", move, { passive: true });
  root.addEventListener("touchend", end, { passive: false }); root.addEventListener("touchcancel", cancel);
  root.addEventListener("contextmenu", context); root.addEventListener("selectstart", selectStart);
  doc.addEventListener("selectionchange", nativeChanged);
  doc.addEventListener("scroll", scroll, { capture: true, passive: true }); win.addEventListener("resize", schedule); doc.addEventListener("keydown", key);
  // Apply before the first long press on touch devices; pointerdown switches
  // back to native selection when a mouse is used on a hybrid device.
  if (win.matchMedia("(pointer: coarse)").matches) root.classList.add("app-touch-selection");
  return { clear: () => { cancel(); clear(false); }, hasSelection: () => !!range,
    select: (x: number, y: number) => { const next = wordAt(x, y); if (next) apply(next); },
    destroy() {
      resize.disconnect(); layoutChanges.disconnect();
      destroyed = true; cancel(); clear(); style.remove(); root.classList.remove("app-touch-selection");
      root.removeEventListener("pointerdown", pointer, true); root.removeEventListener("touchstart", start); root.removeEventListener("touchmove", move);
      root.removeEventListener("touchend", end); root.removeEventListener("touchcancel", cancel); root.removeEventListener("contextmenu", context); root.removeEventListener("selectstart", selectStart);
      doc.removeEventListener("selectionchange", nativeChanged);
      doc.removeEventListener("scroll", scroll, true); win.removeEventListener("resize", schedule); doc.removeEventListener("keydown", key);
    } };
}
