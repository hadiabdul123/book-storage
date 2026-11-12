/** Horizontal page gestures never consume a vertical scroll, pinch, or text selection. */
export function bindPageSwipes(
  root: HTMLElement | Document,
  enabled: () => boolean,
  turn: (direction: "next" | "previous") => void,
) {
  const doc = root.nodeType === 9 ? (root as Document) : root.ownerDocument!;
  let start: { x: number; y: number; at: number; id: number; horizontal: boolean } | undefined;
  const selected = () => !!doc.getSelection()?.toString().trim();
  const down = (event: Event) => {
    const e = event as TouchEvent;
    start = undefined;
    if (
      !enabled() ||
      selected() ||
      e.touches.length !== 1 ||
      (doc.defaultView?.visualViewport?.scale || 1) > 1.01 ||
      (e.target as Element).closest(
        "button,a,input,textarea,select,[contenteditable],.region-mode",
      )
    )
      return;
    start = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
      at: Date.now(),
      id: e.touches[0].identifier,
      horizontal: false,
    };
  };
  const move = (event: Event) => {
    const e = event as TouchEvent;
    if (e.touches.length !== 1 || selected()) start = undefined;
    if (!start) return;
    const dx = Math.abs(e.touches[0].clientX - start.x),
      dy = Math.abs(e.touches[0].clientY - start.y);
    // Decide intent once. A natural diagonal swipe should not be rejected
    // halfway through, but a gesture that starts scrolling stays a scroll.
    if (!start.horizontal && Math.max(dx, dy) > 12) {
      if (dy > dx * 1.2 || Date.now() - start.at > 450) start = undefined;
      else if (dx > dy * 1.35) start.horizontal = true;
    }
    // Claim only an established horizontal swipe; vertical scrolling and pinch
    // remain native. This also avoids a browser pan cancelling iframe gestures.
    if (start?.horizontal && e.cancelable) e.preventDefault();
  };
  const up = (event: Event) => {
    const e = event as TouchEvent,
      began = start;
    start = undefined;
    if (
      !began ||
      !enabled() ||
      selected() ||
      !e.changedTouches.length ||
      (!began.horizontal && Date.now() - began.at > 450)
    )
      return;
    const touch = Array.from(e.changedTouches).find(t => t.identifier === began.id);
    if (!touch) return;
    const dx = touch.clientX - began.x,
      dy = touch.clientY - began.y;
    const threshold = Math.max(44, Math.min(72, (doc.defaultView?.innerWidth || 400) * 0.12));
    if (Math.abs(dx) >= threshold && Math.abs(dx) > Math.abs(dy) * 1.5)
      turn(dx < 0 ? "next" : "previous");
  };
  const cancel = () => {
    start = undefined;
  };
  const bindings: [string, EventListener][] = [
    ["touchstart", down],
    ["touchmove", move],
    ["touchend", up],
    ["touchcancel", cancel],
  ];
  bindings.forEach(([name, fn]) =>
    root.addEventListener(name, fn, { passive: name !== "touchmove" }),
  );
  return () =>
    bindings.forEach(([name, fn]) => root.removeEventListener(name, fn));
}
