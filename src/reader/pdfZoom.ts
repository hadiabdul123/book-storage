type Point = { x: number; y: number };
type ZoomActions = {
  value: () => number;
  preview: (ratio: number, point: Point) => void;
  clear: () => void;
  commit: (zoom: number, point: Point) => Promise<void>;
  error: (error: unknown) => void;
};
const clamp = (value: number) => Math.max(1, Math.min(3, Math.round(value * 100) / 100));

/** Zoom the PDF, retaining native one-finger scrolling and text selection. */
export function bindPdfZoom(host: HTMLElement, actions: ZoomActions) {
  const doc = host.ownerDocument;
  let active = false, busy = false, disposed = false;
  let base = 1, target = 1, point: Point = { x: 0, y: 0 };
  let distance = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const begin = (at: Point) => {
    if (busy) return false;
    if (!active) { base = target = actions.value(); point = at; active = true; }
    clearTimeout(timer);
    return true;
  };
  const finish = () => {
    clearTimeout(timer);
    if (!active) return;
    active = false;
    distance = 0;
    actions.clear();
    if (target === base || disposed) return;
    busy = true;
    void actions.commit(target, point).catch(error => {
      if (!disposed) actions.error(error);
    }).finally(() => { busy = false; });
  };
  const show = (value: number) => {
    target = clamp(value);
    actions.preview(target / base, point);
  };
  const wheel = (event: WheelEvent) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    if (!begin({ x: event.clientX, y: event.clientY })) return;
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? host.clientHeight : 1);
    show(target * Math.exp(-Math.max(-500, Math.min(500, delta)) * 0.002));
    timer = setTimeout(finish, 140);
  };
  const editable = (event: KeyboardEvent) => (event.target as Element)?.closest?.(
    'input,textarea,select,[contenteditable="true"],[role="textbox"]');
  const key = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || editable(event) || event.defaultPrevented) return;
    if (!["+", "=", "-", "0"].includes(event.key)) return;
    event.preventDefault();
    const box = host.getBoundingClientRect();
    if (!begin({ x: box.left + box.width / 2, y: box.top + box.height / 2 })) return;
    show(event.key === "0" ? 1 : target + (event.key === "-" ? -0.25 : 0.25));
    timer = setTimeout(finish, 140);
  };
  const span = (touches: TouchList) => Math.hypot(
    touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  const start = (event: TouchEvent) => {
    if (event.touches.length !== 2) return;
    if ((event.target as Element).closest("button,a,input,textarea,[contenteditable],.region-mode")) return;
    // Claim only the second finger, leaving ordinary touch pan/selection native.
    if (event.cancelable) event.preventDefault();
    if (!begin({ x: (event.touches[0].clientX + event.touches[1].clientX) / 2,
      y: (event.touches[0].clientY + event.touches[1].clientY) / 2 })) return;
    distance = Math.max(1, span(event.touches));
  };
  const move = (event: TouchEvent) => {
    if (!distance || event.touches.length !== 2) return;
    if (event.cancelable) event.preventDefault();
    show(base * span(event.touches) / distance);
  };
  const end = (event: TouchEvent) => {
    if (distance && event.touches.length < 2) {
      if (event.cancelable) event.preventDefault();
      finish();
    }
  };
  const cancel = () => { clearTimeout(timer); active = false; distance = 0; actions.clear(); };
  host.addEventListener("wheel", wheel, { passive: false });
  host.addEventListener("touchstart", start, { passive: false });
  host.addEventListener("touchmove", move, { passive: false });
  host.addEventListener("touchend", end, { passive: false });
  host.addEventListener("touchcancel", cancel);
  doc.addEventListener("keydown", key);
  return () => {
    disposed = true;
    cancel();
    host.removeEventListener("wheel", wheel);
    host.removeEventListener("touchstart", start);
    host.removeEventListener("touchmove", move);
    host.removeEventListener("touchend", end);
    host.removeEventListener("touchcancel", cancel);
    doc.removeEventListener("keydown", key);
  };
}
