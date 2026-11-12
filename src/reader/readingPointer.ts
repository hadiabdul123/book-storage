import { trimReadingTrail, type ReadingPointerSettings, type TrailPoint } from "../readingPointerSettings";

const ns = "http://www.w3.org/2000/svg";
let sequence = 0;
export function bindReadingPointer(host: HTMLElement, settings: ReadingPointerSettings, preview = false) {
  if (!settings.pointer && !settings.trail) return () => {};
  const doc = host.ownerDocument, win = doc.defaultView!;
  const svg = doc.createElementNS(ns, "svg");
  svg.classList.add("reading-pointer-overlay");
  if (preview) svg.classList.add("is-preview");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const clipId = `reading-pointer-clip-${++sequence}`;
  const defs = doc.createElementNS(ns, "defs"), clip = doc.createElementNS(ns, "clipPath");
  clip.id = clipId;
  defs.append(clip);
  const drawing = doc.createElementNS(ns, "g");
  drawing.setAttribute("clip-path", `url(#${clipId})`);
  const trail = doc.createElementNS(ns, "g"), pointer = doc.createElementNS(ns, "g");
  pointer.dataset.readingPointer = settings.shape;
  pointer.style.display = "none";
  // All markup is fixed; user settings only enter validated DOM attributes.
  const shape = settings.shape === "arrow" ? "M0 0 L9 27 L14 17 L25 13 Z"
    : settings.shape === "dot" ? "M-9 0 A9 9 0 1 0 9 0 A9 9 0 1 0 -9 0"
    : settings.shape === "ring" ? "M-12 0 A12 12 0 1 0 12 0 A12 12 0 1 0 -12 0"
    : "M-14 0 L14 0";
  for (const outline of [true, false]) {
    const path = doc.createElementNS(ns, "path");
    path.setAttribute("d", shape);
    path.setAttribute("fill", ["arrow", "dot"].includes(settings.shape) && !outline ? settings.color : "none");
    path.setAttribute("stroke", outline ? "white" : settings.color);
    path.setAttribute("stroke-width", outline ? "6" : "3");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-linecap", "round");
    pointer.append(path);
  }
  drawing.append(trail, pointer); svg.append(defs, drawing); doc.body.append(svg);
  let points: TrailPoint[] = [], frame = 0, activePage: HTMLElement | null = null;
  let last: TrailPoint | undefined;
  const clear = () => {
    win.cancelAnimationFrame(frame); frame = 0; points = []; last = undefined;
    trail.replaceChildren(); pointer.style.display = "none";
    activePage?.classList.remove("reading-pointer-active"); activePage = null;
  };
  const draw = (now: number) => {
    frame = 0;
    points = trimReadingTrail(points, settings.length, now, settings.fade);
    const segments = doc.createDocumentFragment();
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const line = doc.createElementNS(ns, "path");
      line.setAttribute("d", `M${a.x} ${a.y} L${b.x} ${b.y}`);
      line.setAttribute("stroke", settings.color);
      line.setAttribute("stroke-width", String(settings.thickness));
      line.setAttribute("stroke-linecap", "round");
      line.setAttribute("opacity", String((settings.opacity / 100) * (i / points.length) * Math.max(0, 1 - (now - b.time) / settings.fade)));
      segments.append(line);
    }
    trail.replaceChildren(segments);
    if (points.length) frame = win.requestAnimationFrame(draw);
  };
  const blocked = (target: Element) => !preview && (
    host.matches(".region-mode,.pdf-zooming") ||
    !!target.closest("button,a,input,textarea,select,[contenteditable],.passage-popup,.pdf-selection-handle") ||
    !!host.closest(".reader-shell")?.querySelector(".passage-popup") ||
    !doc.getSelection()?.isCollapsed
  );
  const move = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" || event.buttons || doc.hidden) { clear(); return; }
    const target = event.target as Element;
    const page = preview ? host : target.closest<HTMLElement>(".pdf-page");
    if (!page || !host.contains(page) || blocked(target)) { clear(); return; }
    if (page !== activePage) {
      clear(); activePage = page;
      const box = page.getBoundingClientRect(), viewport = host.getBoundingClientRect();
      const rect = doc.createElementNS(ns, "rect");
      const x = Math.max(box.left, viewport.left, 0), y = Math.max(box.top, viewport.top, 0);
      rect.setAttribute("x", String(x)); rect.setAttribute("y", String(y));
      rect.setAttribute("width", String(Math.max(0, Math.min(box.right, viewport.right, win.innerWidth) - x)));
      rect.setAttribute("height", String(Math.max(0, Math.min(box.bottom, viewport.bottom, win.innerHeight) - y)));
      clip.replaceChildren(rect);
    }
    const point = { x: event.clientX, y: event.clientY, time: win.performance.now() };
    if (settings.pointer) {
      activePage.classList.add("reading-pointer-active");
      pointer.style.display = "";
      pointer.setAttribute("transform", `translate(${point.x} ${point.y}) scale(${settings.size / 32})`);
    }
    if (settings.trail && (!last || Math.hypot(point.x - last.x, point.y - last.y) >= 1)) {
      points.push(point);
      points = trimReadingTrail(points, settings.length, point.time, settings.fade);
      if (!frame) frame = win.requestAnimationFrame(draw);
    }
    last = point;
  };
  const selection = () => { if (!doc.getSelection()?.isCollapsed) clear(); };
  const observer = new MutationObserver(() => {
    if (host.matches(".region-mode,.pdf-zooming") || (activePage && !host.contains(activePage))) clear();
  });
  observer.observe(host, { childList: true, attributes: true, attributeFilter: ["class"] });
  host.addEventListener("pointermove", move, { passive: true });
  host.addEventListener("pointerleave", clear);
  host.addEventListener("pointerdown", clear, { passive: true });
  doc.addEventListener("scroll", clear, true);
  doc.addEventListener("wheel", clear, { passive: true });
  doc.addEventListener("keydown", clear);
  doc.addEventListener("selectionchange", selection);
  doc.addEventListener("visibilitychange", clear);
  win.addEventListener("blur", clear);
  win.addEventListener("resize", clear);
  return () => {
    clear(); observer.disconnect(); svg.remove();
    host.removeEventListener("pointermove", move); host.removeEventListener("pointerleave", clear);
    host.removeEventListener("pointerdown", clear); doc.removeEventListener("scroll", clear, true);
    doc.removeEventListener("wheel", clear); doc.removeEventListener("keydown", clear);
    doc.removeEventListener("selectionchange", selection); doc.removeEventListener("visibilitychange", clear);
    win.removeEventListener("blur", clear); win.removeEventListener("resize", clear);
  };
}
