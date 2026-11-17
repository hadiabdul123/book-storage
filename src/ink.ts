import { getStroke } from "perfect-freehand";
import { db, save } from "./db";
import { now, uid } from "./model";
import { sameInkTarget, validInkStroke, type InkPoint, type InkStroke, type InkStyle, type InkTarget } from "./inkTypes";
export type InkProjection = (x: number, y: number) => number[];
const outlines = new WeakMap<InkStroke, number[][]>();
export function inkPath(stroke: InkStroke, project: InkProjection = (x, y) => [x, y]) {
  let raw = outlines.get(stroke);
  if (!raw) { raw = getStroke(stroke.points, { size: stroke.width, thinning: stroke.tool === "highlighter" ? 0 : .45, smoothing: .6, streamline: .45, simulatePressure: false, last: true }); outlines.set(stroke, raw); }
  const outline = raw.map(p => project(p[0], p[1]));
  if (!outline.length) return "";
  return `M ${outline[0].join(" ")} Q ${outline.map((p, i) => `${p.join(" ")} ${[(p[0] + outline[(i + 1) % outline.length][0]) / 2, (p[1] + outline[(i + 1) % outline.length][1]) / 2].join(" ")}`).join(" ")} Z`;
}
const painted = new WeakMap<SVGSVGElement, Map<string, { path: SVGPathElement; stroke: InkStroke }>>();
export function paintInk(svg: SVGSVGElement, strokes: InkStroke[], project?: InkProjection, force = false) {
  let cache = painted.get(svg); if (!cache) { cache = new Map(); painted.set(svg, cache); }
  const keep = new Set(strokes.map(s => s.id));
  for (const [id, entry] of cache) if (!keep.has(id)) { entry.path.remove(); cache.delete(id); }
  for (const stroke of strokes) {
    const entry = cache.get(stroke.id);
    if (!force && entry?.stroke === stroke && svg.contains(entry.path)) continue;
    const path = entry?.path || svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", inkPath(stroke, project)); path.setAttribute("fill", stroke.color);
    path.setAttribute("opacity", stroke.tool === "highlighter" ? ".3" : "1"); path.dataset.stroke = stroke.id;
    if (!svg.contains(path)) svg.append(path);
    cache.set(stroke.id, { path, stroke });
  }
}
export class InkHistory {
  pending = new Map<string, { stroke: InkStroke; deleted: boolean }>();
  undoStack: { stroke: InkStroke; deleted: boolean }[] = [];
  redoStack: { stroke: InkStroke; deleted: boolean }[] = [];
  async perform(stroke: InkStroke, deleted = false) {
    if (!validInkStroke(stroke)) throw new Error("This drawing could not be saved: invalid stroke.");
    this.pending.set(stroke.id, { stroke, deleted });
    // A recovery copy survives quota/network failures and a closing reader.
    const key = `ink-draft:${stroke.id}`;
    await db.meta.put({ key, value: JSON.stringify({ stroke, deleted }) });
    await save("ink-stroke", stroke, deleted); this.pending.delete(stroke.id); await db.meta.delete(key).catch(() => {});
    this.undoStack.push({ stroke, deleted }); this.redoStack = [];
  }
  visible(strokes: InkStroke[]) {
    const result = new Map(strokes.map(s => [s.id, s]));
    for (const { stroke, deleted } of this.pending.values()) { if (deleted) result.delete(stroke.id); else result.set(stroke.id, stroke); }
    return [...result.values()];
  }
  async retry() { for (const action of [...this.pending.values()]) await this.perform(action.stroke, action.deleted); }
  async move(redo = false) {
    const from = redo ? this.redoStack : this.undoStack, to = redo ? this.undoStack : this.redoStack;
    const action = from.at(-1); if (!action) return;
    const current = await db.rows.get(`ink-stroke:${action.stroke.id}`);
    if (!current || current.deleted !== (redo ? !action.deleted : action.deleted)) throw new Error("This stroke changed on another device. Reopen the drawing before editing it.");
    await save("ink-stroke", action.stroke, redo ? action.deleted : !action.deleted);
    from.pop(); to.push(action);
  }
}
export async function recoverInkDrafts() {
  for (const draft of await db.meta.where("key").startsWith("ink-draft:").toArray()) {
    try { const { stroke, deleted } = JSON.parse(draft.value); if (validInkStroke(stroke)) { await save("ink-stroke", stroke, !!deleted); await db.meta.delete(draft.key); } } catch { /* Keep a failed recovery for the next opening. */ }
  }
}
export function bindInkSurface(svg: SVGSVGElement, options: {
  target: InkTarget; strokes: () => InkStroke[]; style: () => InkStyle; enabled: () => boolean;
  project?: InkProjection; unproject?: InkProjection;
  commit: (stroke: InkStroke, deleted?: boolean) => Promise<void>;
  error: (message: string) => void;
}) {
  let points: InkPoint[] = [], pointer: number | undefined, pointerType = "", frame = 0, destroyed = false;
  let gestureStyle: InkStyle | undefined;
  let forcePaint = true;
  const contacts = new Set<number>(), pending = new Map<string, InkStroke>(), hidden = new Set<string>();
  const strokes = () => {
    const saved = options.strokes().filter(s => sameInkTarget(s.target, options.target));
    saved.forEach(s => pending.delete(s.id));
    for (const id of hidden) if (!saved.some(s => s.id === id) && !pending.has(id)) hidden.delete(id);
    return [...saved, ...pending.values()].filter(s => !hidden.has(s.id));
  };
  const snapshot = (): InkStroke => ({ id: "preview", target: options.target, tool: gestureStyle?.tool === "highlighter" ? "highlighter" : "pen", color: gestureStyle?.color || "#315c86", width: gestureStyle?.width || 2, points, createdAt: now() });
  const paint = () => { frame = 0; if (!destroyed) paintInk(svg, [...strokes(), ...(points.length && gestureStyle?.tool !== "eraser" ? [snapshot()] : [])], options.project, forcePaint); forcePaint = false; };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
  const coordinate = (event: PointerEvent): InkPoint => {
    const matrix = svg.getScreenCTM();
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix?.inverse());
    const [x, y] = options.unproject?.(p.x, p.y) || [p.x, p.y];
    return [x, y, event.pointerType === "pen" && event.pressure > 0 ? event.pressure : .5];
  };
  const commit = (stroke: InkStroke, deleted = false) => {
    if (deleted) hidden.add(stroke.id); else pending.set(stroke.id, stroke);
    schedule();
    void options.commit(stroke, deleted).catch(error => { options.error(`Could not save drawing: ${error instanceof Error ? error.message : String(error)}. Keep this page open and retry saving.`); schedule(); });
  };
  const erase = (point: InkPoint) => {
    const screen = options.project?.(point[0], point[1]) || point;
    for (const stroke of strokes()) if (stroke.points.some((p, i) => {
      const q = options.project?.(p[0], p[1]) || p, previous = stroke.points[Math.max(0, i - 1)], a = options.project?.(previous[0], previous[1]) || previous;
      const dx = q[0] - a[0], dy = q[1] - a[1], length = dx * dx + dy * dy;
      const t = length ? Math.max(0, Math.min(1, ((screen[0] - a[0]) * dx + (screen[1] - a[1]) * dy) / length)) : 0;
      return Math.hypot(screen[0] - a[0] - dx * t, screen[1] - a[1] - dy * t) < 16;
    })) commit(stroke, true);
  };
  const cancel = () => { pointer = undefined; pointerType = ""; delete svg.dataset.inkPenActive; points = []; gestureStyle = undefined; schedule(); };
  const down = (event: PointerEvent) => {
    if (pointerType === "pen" && event.pointerType === "touch") return;
    if (!options.enabled()) return;
    contacts.add(event.pointerId);
    if (contacts.size > 1) { cancel(); return; }
    const style = options.style();
    if (!options.enabled() || (style.penOnly && event.pointerType !== "pen") || event.button > 0) return;
    pointer = event.pointerId; pointerType = event.pointerType; if (pointerType === "pen") svg.dataset.inkPenActive = "true";
    gestureStyle = { ...style }; points = [coordinate(event)];
    svg.setPointerCapture(event.pointerId); event.preventDefault(); event.stopPropagation();
    if (style.tool === "eraser") erase(points[0]); schedule();
  };
  const move = (event: PointerEvent) => {
    if (pointer !== event.pointerId || !options.enabled()) return;
    event.preventDefault(); event.stopPropagation();
    for (const sample of event.getCoalescedEvents?.().length ? event.getCoalescedEvents() : [event]) {
      const point = coordinate(sample), prior = points.at(-1);
      if (!prior || Math.hypot(point[0] - prior[0], point[1] - prior[1]) > .15) points.push(point);
      if (gestureStyle?.tool === "eraser") erase(point);
    }
    if (points.length >= 9900 && gestureStyle?.tool !== "eraser") {
      const stroke = { ...snapshot(), id: uid() }; commit(stroke); points = [points[points.length - 1]];
    }
    schedule();
  };
  const up = (event: PointerEvent) => {
    contacts.delete(event.pointerId);
    if (pointer !== event.pointerId) return;
    move(event); if (points.length && gestureStyle?.tool !== "eraser") commit({ ...snapshot(), id: uid() }); cancel();
  };
  const abort = (event: PointerEvent) => { contacts.delete(event.pointerId); cancel(); };
  svg.addEventListener("pointerdown", down); svg.addEventListener("pointermove", move); svg.addEventListener("pointerup", up); svg.addEventListener("pointercancel", abort);
  // A second touch can start outside this page's overlay.
  const second = (e: PointerEvent) => { if (pointer !== undefined && pointerType !== "pen" && e.pointerId !== pointer && e.pointerType === "touch") cancel(); };
  svg.ownerDocument.addEventListener("pointerdown", second, true);
  const released = (e: PointerEvent) => contacts.delete(e.pointerId);
  svg.ownerDocument.addEventListener("pointerup", released, true); svg.ownerDocument.addEventListener("pointercancel", released, true);
  paint();
  return { paint: () => { forcePaint = true; schedule(); }, cancel, destroy() { destroyed = true; cancelAnimationFrame(frame); svg.removeEventListener("pointerdown", down); svg.removeEventListener("pointermove", move); svg.removeEventListener("pointerup", up); svg.removeEventListener("pointercancel", abort); svg.ownerDocument.removeEventListener("pointerdown", second, true); svg.ownerDocument.removeEventListener("pointerup", released, true); svg.ownerDocument.removeEventListener("pointercancel", released, true); } };
}
