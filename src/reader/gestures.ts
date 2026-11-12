/** Native scrolling and selection always win over a reading-area tap. */
export function bindReadingTaps(
  root: HTMLElement | Document,
  onTap: () => void,
) {
  const doc = root.nodeType === 9 ? (root as Document) : root.ownerDocument!;
  let start: { x: number; y: number; time: number; id: number } | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let lastUp = -Infinity;
  const cancel = () => {
    start = undefined;
    clearTimeout(pending);
  };
  const selected = () => !!doc.getSelection()?.toString().trim();
  const down = (event: Event) => {
    const e = event as PointerEvent;
    clearTimeout(pending);
    const target = e.target as Element;
    if (
      e.pointerType !== "touch" ||
      !e.isPrimary ||
      selected() ||
      target.closest?.(
        "button,a,input,textarea,select,[contenteditable],.region-mode",
      )
    ) {
      start = undefined;
      return;
    }
    start = { x: e.clientX, y: e.clientY, time: Date.now(), id: e.pointerId };
  };
  const move = (event: Event) => {
    const e = event as PointerEvent;
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8)
      cancel();
  };
  const up = (event: Event) => {
    const e = event as PointerEvent,
      began = start;
    start = undefined;
    const now = Date.now(),
      double = now - lastUp < 320;
    lastUp = now;
    if (
      !began ||
      began.id !== e.pointerId ||
      now - began.time > 250 ||
      double ||
      selected()
    )
      return;
    pending = setTimeout(() => {
      if (!selected()) onTap();
    }, 320);
  };
  const bindings: [string, EventListener][] = [
    ["pointerdown", down],
    ["pointermove", move],
    ["pointerup", up],
    ["pointercancel", cancel],
    ["scroll", cancel],
  ];
  bindings.forEach(([name, fn]) =>
    root.addEventListener(name, fn, {
      passive: true,
      capture: name === "scroll",
    }),
  );
  doc.addEventListener("selectionchange", cancel);
  return () => {
    cancel();
    bindings.forEach(([name, fn]) =>
      root.removeEventListener(name, fn, name === "scroll"),
    );
    doc.removeEventListener("selectionchange", cancel);
  };
}
