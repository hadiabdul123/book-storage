/** Horizontal page gestures never consume a vertical scroll, pinch, or text selection. */
export function bindPageSwipes(
  root: HTMLElement | Document,
  enabled: () => boolean,
  turn: (direction: "next" | "previous") => void,
) {
  const doc = root.nodeType === 9 ? (root as Document) : root.ownerDocument!;
  let start: { x: number; y: number; at: number } | undefined;
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
        "button,a,input,textarea,[contenteditable],.region-mode",
      )
    )
      return;
    start = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
      at: Date.now(),
    };
  };
  const move = (event: Event) => {
    const e = event as TouchEvent;
    if (e.touches.length !== 1 || selected()) start = undefined;
    if (start && Math.abs(e.touches[0].clientY - start.y) > 35)
      start = undefined;
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
      Date.now() - began.at > 550
    )
      return;
    const dx = e.changedTouches[0].clientX - began.x,
      dy = e.changedTouches[0].clientY - began.y;
    if (Math.abs(dx) >= 65 && Math.abs(dx) > Math.abs(dy) * 2.5)
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
    root.addEventListener(name, fn, { passive: true }),
  );
  return () =>
    bindings.forEach(([name, fn]) => root.removeEventListener(name, fn));
}
