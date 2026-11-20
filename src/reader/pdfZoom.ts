type Point = { x: number; y: number };
type ZoomActions = {
  enabled?: () => boolean;
  interaction?: (active: boolean) => void;
  target?: (zoom: number) => void;
  settled?: (zoom: number) => void;
  value: () => number;
  preview: (ratio: number, point: Point, origin: Point) => void;
  clear: () => void;
  commit: (zoom: number, point: Point) => Promise<void>;
  error: (error: unknown) => void;
};
const clamp = (value: number) => Math.max(1, Math.min(3, value));

/** Retain the preview until the latest requested render is ready. Inputs during
 * rendering update the target rather than being dropped. */
export function bindPdfZoom(host: HTMLElement, actions: ZoomActions) {
  const doc = host.ownerDocument;
  let active = false, busy = false, disposed = false, previewing = false;
  let base = 1, target = 1, pinchBase = 1;
  let point: Point = { x: 0, y: 0 }, origin = point;
  let distance = 0, frame = 0;
  let pinchOrigin = point, pinchPoint = point;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const paint = () => { frame = 0; if (!disposed && previewing) actions.preview(target / base, point, origin); };
  const show = (value: number) => { target = clamp(value); actions.target?.(target); if (!frame) frame = requestAnimationFrame(paint); };
  const begin = (at: Point) => {
    if (!previewing) { base = target = actions.value(); origin = point = at; previewing = true; }
    active = true; actions.interaction?.(true); clearTimeout(timer);
  };
  const drain = async () => {
    if (busy || active || disposed) return;
    busy = true;
    let attempts = 0;
    try {
      while (!active && !disposed) {
        if (++attempts > 8) throw new Error("The view could not settle. Reset zoom or reopen the book.");
        const requested = Math.round(target * 100) / 100;
        if (previewing || requested !== actions.value()) await actions.commit(requested, point);
        if (active || disposed) break;
        if (requested === Math.round(target * 100) / 100 && requested === Math.round(actions.value() * 100) / 100) {
          cancelAnimationFrame(frame); frame = 0; actions.clear(); previewing = false; break;
        }
      }
    } catch (error) {
      if (!disposed) { actions.clear(); previewing = false; actions.error(error); }
    } finally { busy = false; }
  };
  const finish = () => {
    clearTimeout(timer); if (!active) return;
    active = false; actions.interaction?.(false); actions.settled?.(Math.round(target * 100) / 100); distance = 0; cancelAnimationFrame(frame); paint(); void drain();
  };
  const request = (value: number) => {
    if (actions.enabled?.() === false) return;
    const box = host.getBoundingClientRect(); begin({ x: box.left + box.width / 2, y: box.top + 28 });
    show(value); finish();
  };
  const wheel = (event: WheelEvent) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (actions.enabled?.() === false) return;
    event.preventDefault(); begin({ x: event.clientX, y: event.clientY });
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? host.clientHeight : 1);
    show(target * Math.exp(-Math.max(-500, Math.min(500, delta)) * .002)); timer = setTimeout(finish, 140);
  };
  const key = (event: KeyboardEvent) => {
    if (actions.enabled?.() === false || !(event.ctrlKey || event.metaKey) || event.altKey || event.defaultPrevented ||
      (event.target as Element)?.closest?.('input,textarea,select,[contenteditable="true"],[role="textbox"]') ||
      !["+", "=", "-", "0"].includes(event.key)) return;
    event.preventDefault(); const box = host.getBoundingClientRect();
    begin({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
    show(event.key === "0" ? 1 : target + (event.key === "-" ? -.25 : .25)); timer = setTimeout(finish, 140);
  };
  const span = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  const midpoint = (touches: TouchList) => ({ x: (touches[0].clientX + touches[1].clientX) / 2, y: (touches[0].clientY + touches[1].clientY) / 2 });
  const start = (event: TouchEvent) => {
    if (actions.enabled?.() === false || host.querySelector('[data-ink-pen-active="true"]')) return;
    if (event.touches.length !== 2 || (event.target as Element).closest("button,a,input,textarea,[contenteditable],.region-mode")) return;
    if (event.cancelable) event.preventDefault(); begin(midpoint(event.touches));
    distance = Math.max(1, span(event.touches)); pinchBase = target; pinchOrigin = midpoint(event.touches); pinchPoint = point;
  };
  const move = (event: TouchEvent) => {
    if (!distance || event.touches.length !== 2) return;
    if (event.cancelable) event.preventDefault();
    const at = midpoint(event.touches); point = { x: pinchPoint.x + at.x - pinchOrigin.x, y: pinchPoint.y + at.y - pinchOrigin.y };
    show(pinchBase * span(event.touches) / distance);
  };
  const end = (event: TouchEvent) => { if (distance && event.touches.length < 2) { if (event.cancelable) event.preventDefault(); finish(); } };
  const cancel = () => { clearTimeout(timer); active = false; actions.interaction?.(false); distance = 0; target = actions.value(); cancelAnimationFrame(frame); frame = 0; actions.clear(); previewing = false; };
  host.addEventListener("wheel", wheel, { passive: false }); host.addEventListener("touchstart", start, { passive: false });
  host.addEventListener("touchmove", move, { passive: false }); host.addEventListener("touchend", end, { passive: false });
  host.addEventListener("touchcancel", cancel); doc.addEventListener("keydown", key);
  return { request, target: () => previewing ? target : actions.value(), destroy() {
    disposed = true; cancel(); host.removeEventListener("wheel", wheel); host.removeEventListener("touchstart", start);
    host.removeEventListener("touchmove", move); host.removeEventListener("touchend", end); host.removeEventListener("touchcancel", cancel); doc.removeEventListener("keydown", key);
  } };
}
