import { bindInkLasso, type LassoStroke } from "./inkLasso";
import { getStrokePoints, getStrokeOutlinePoints } from "perfect-freehand";
import "./ink.css";
import { db, get, save } from "./db";
import { now, uid } from "./model";
import { sameInkTarget, validInkStroke, type InkPoint, type InkStroke, type InkStyle, type InkTarget } from "./inkTypes";
export type InkProjection = (x: number, y: number) => number[];
const outlines = new WeakMap<InkStroke, number[][]>();
// Build the two sides of the nib around the measured segments. Each turn is
// joined at its actual sample position, including very short reversals.
function directOutline(stroke: InkStroke): number[][] {
  const points = stroke.points.filter((p, i, all) => !i || p[0] !== all[i-1][0] || p[1] !== all[i-1][1]);
  const radius = (p: InkPoint) => stroke.width * (.275 + .45 * p[2]);
  const offset = (p: InkPoint, angle: number) =>
    [p[0] + Math.cos(angle) * radius(p), p[1] + Math.sin(angle) * radius(p)];
  const arc = (p: InkPoint, start: number, sweep: number) => {
    const steps = Math.ceil(Math.abs(sweep) / (Math.PI / 8));
    return Array.from({length: steps}, (_, i) => offset(p, start + sweep * (i + 1) / steps));
  };
  if (points.length < 2) return points.length ? arc(points[0], 0, 2 * Math.PI) : [];
  const left: number[][] = [], right: number[][] = [];
  let normal = 0, firstNormal = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i-1], b = points[i];
    const next = Math.atan2(b[1]-a[1], b[0]-a[0]) + Math.PI / 2;
    if (i === 1) {
      firstNormal = next;
      left.push(offset(a, next));
      right.push(offset(a, next + Math.PI));
    } else {
      const turn = Math.atan2(Math.sin(next-normal), Math.cos(next-normal));
      if (turn < 0) left.push(...arc(a, normal, turn));
      else if (turn > 0) right.push(...arc(a, normal + Math.PI, turn));
      if (turn > 0) left.push(offset(a, next));
      else if (turn < 0) right.push(offset(a, next + Math.PI));
    }
    left.push(offset(b, next));
    right.push(offset(b, next + Math.PI));
    normal = next;
  }
  return [...left, ...arc(points[points.length-1], normal, -Math.PI), ...right.reverse(),
    ...arc(points[0], firstNormal + Math.PI, -Math.PI)];
}

export function inkPath(stroke: InkStroke, project: InkProjection = (x, y) => [x, y]) {
  let raw = outlines.get(stroke);
  if (!raw && stroke.input === "direct") {
    raw = directOutline(stroke);
    outlines.set(stroke, raw);
  }
  if (!raw) {
    // Keep older drawings and the broad highlighter in their original style.
    const points = getStrokePoints(stroke.points, { size: .01, streamline: 0, last: true });
    raw = getStrokeOutlinePoints(points, { size: stroke.width, thinning: stroke.tool === "highlighter" ? 0 : .45, smoothing: 0, simulatePressure: false, last: true });
    outlines.set(stroke, raw);
  }
  const outline = raw.map(p => project(p[0], p[1]));
  if (!outline.length) return "";
  if (stroke.input === "direct") return "M " + outline.map(p => p.join(" ")).join(" L ") + " Z";
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
type InkChange = { before?: InkStroke; after?: InkStroke };
export class InkHistory {
  pending = new Map<string, { stroke: InkStroke; deleted: boolean }>();
  undoStack: InkChange[][] = [];
  redoStack: InkChange[][] = [];
  async perform(stroke: InkStroke, deleted = false) {
    if (!validInkStroke(stroke)) throw new Error("This drawing could not be saved: invalid stroke.");
    this.pending.set(stroke.id, { stroke, deleted });
    // A recovery copy survives quota/network failures and a closing reader.
    const key = `ink-draft:${stroke.id}`;
    await db.meta.put({ key, value: JSON.stringify({ stroke, deleted }) });
    await save("ink-stroke", stroke, deleted); this.pending.delete(stroke.id); await db.meta.delete(key).catch(() => {});
    this.undoStack.push([deleted ? { before:stroke } : { after:stroke }]); this.redoStack = [];
  }
  visible(strokes: InkStroke[]) {
    const result = new Map(strokes.map(s => [s.id, s]));
    for (const { stroke, deleted } of this.pending.values()) { if (deleted) result.delete(stroke.id); else result.set(stroke.id, stroke); }
    return [...result.values()];
  }
  async retry() { for (const action of [...this.pending.values()]) await this.perform(action.stroke, action.deleted); }
  async edit(changes: InkChange[]) {
    if (!changes.length) return;
    await this.apply(changes);
    this.undoStack.push(changes);
    this.redoStack = [];
  }
  private async apply(changes: InkChange[]) {
    await db.transaction("rw", db.rows, db.outbox, db.conflicts, db.meta, async () => {
      for (const {before, after} of changes) {
        const stroke = after || before!;
        if (!validInkStroke(stroke)) throw new Error("The selected ink is outside the page limits.");
        const current = await get("ink-stroke", stroke.id);
        if (JSON.stringify(current) !== JSON.stringify(before))
          throw new Error("This drawing changed. Select the strokes again.");
        await save("ink-stroke", stroke, !after);
      }
    });
  }
  async move(redo = false) {
    const from = redo ? this.redoStack : this.undoStack, to = redo ? this.undoStack : this.redoStack;
    const action = from.at(-1);
    if (!action) return;
    await this.apply(redo ? action : action.map(({before,after}) => ({ before:after, after:before })));
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
  history: InkHistory;
  lassoStrokes?: () => LassoStroke[];
  retainCommitted?: boolean;
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
  const identity: InkProjection = (x,y) => [x,y];
  const lasso = bindInkLasso(svg, {
    enabled: () => options.enabled() && options.style().tool === "lasso", color: () => options.style().color,
    history:options.history, error:options.error,
    candidates: options.lassoStrokes || (() => strokes().map(stroke => ({stroke, project:options.project || identity, unproject:options.unproject || identity}))),
  });
  const snapshot = (): InkStroke => ({ id: "preview", input: gestureStyle?.tool === "pen" ? "direct" : undefined, target: options.target, tool: gestureStyle?.tool === "highlighter" ? "highlighter" : "pen", color: gestureStyle?.color || "#315c86", width: gestureStyle?.width || 2, points, createdAt: now() });
  const paint = () => { frame = 0; if (!destroyed) paintInk(svg, [...strokes(), ...(points.length && gestureStyle?.tool !== "eraser" ? [snapshot()] : [])], options.project, forcePaint); forcePaint = false; lasso.refresh(); };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
  const coordinate = (event: PointerEvent, inverse = svg.getScreenCTM()?.inverse()): InkPoint => {
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(inverse);
    const [x, y] = options.unproject?.(p.x, p.y) || [p.x, p.y];
    return [x, y, event.pointerType === "pen" && event.pressure > 0 ? event.pressure : .5];
  };
  const commit = (stroke: InkStroke, deleted = false) => {
    if (deleted) hidden.add(stroke.id); else if (options.retainCommitted !== false) pending.set(stroke.id, stroke);
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
  const cancel = () => {
    if (pointer !== undefined && svg.hasPointerCapture(pointer)) svg.releasePointerCapture(pointer);
    pointer = undefined; pointerType = ""; delete svg.dataset.inkPenActive; points = []; gestureStyle = undefined; schedule();
  };
  const flush = () => {
    if (points.length && gestureStyle?.tool !== "eraser") commit({ ...snapshot(), id: uid() });
    cancel();
  };
  const down = (event: PointerEvent) => {
    if (pointerType === "pen" && event.pointerType === "touch") return;
    if (!options.enabled()) return;
    const style = options.style();
    if (style.tool === "lasso" || (style.penOnly && event.pointerType !== "pen") || event.button > 0) return;
    // A palm may already be resting on the page when the nib arrives.
    // The pen owns its stroke regardless of the order those contacts arrived.
    if (event.pointerType === "pen") { cancel(); contacts.clear(); }
    contacts.add(event.pointerId);
    if (contacts.size > 1) { cancel(); return; }
    pointer = event.pointerId; pointerType = event.pointerType; if (pointerType === "pen") svg.dataset.inkPenActive = "true";
    gestureStyle = { ...style }; points = [coordinate(event)];
    svg.setPointerCapture(event.pointerId); event.preventDefault(); event.stopPropagation();
    if (style.tool === "eraser") erase(points[0]); schedule();
  };
  const move = (event: PointerEvent) => {
    if (pointer !== event.pointerId || !options.enabled()) return;
    event.preventDefault(); event.stopPropagation();
    const inverse = svg.getScreenCTM()?.inverse();
    const append = (sample: PointerEvent) => {
      const point = coordinate(sample, inverse), prior = points.at(-1);
      if (!prior || point[0] !== prior[0] || point[1] !== prior[1]) points.push(point);
      if (gestureStyle?.tool === "eraser") erase(point);
      else if (points.length >= 9900) {
        commit({ ...snapshot(), id: uid() });
        points = [point];
      }
    };
    for (const sample of event.getCoalescedEvents?.() || []) append(sample);
    append(event);
    schedule();
  };
  const up = (event: PointerEvent) => {
    contacts.delete(event.pointerId);
    if (pointer !== event.pointerId) return;
    move(event); if (points.length && gestureStyle?.tool !== "eraser") commit({ ...snapshot(), id: uid() }); cancel();
  };
  const abort = (event: PointerEvent) => {
    contacts.delete(event.pointerId);
    // Cancelling an unrelated palm contact must not discard the pen stroke.
    if (pointer !== event.pointerId) return;
    pointerType === "pen" ? flush() : cancel();
  };
  svg.addEventListener("pointerdown", down); svg.addEventListener("pointermove", move); svg.addEventListener("pointerup", up); svg.addEventListener("pointercancel", abort);
  // A second touch can start outside this page's overlay.
  const second = (e: PointerEvent) => { if (pointer !== undefined && pointerType !== "pen" && e.pointerId !== pointer && e.pointerType === "touch") cancel(); };
  svg.ownerDocument.addEventListener("pointerdown", second, true);
  const released = (e: PointerEvent) => contacts.delete(e.pointerId);
  svg.ownerDocument.addEventListener("pointerup", released, true); svg.ownerDocument.addEventListener("pointercancel", released, true);
  paint();
  return { paint: () => { forcePaint = true; schedule(); }, cancel, flush, destroy() { destroyed = true; lasso.destroy(); cancel(); cancelAnimationFrame(frame); svg.removeEventListener("pointerdown", down); svg.removeEventListener("pointermove", move); svg.removeEventListener("pointerup", up); svg.removeEventListener("pointercancel", abort); svg.ownerDocument.removeEventListener("pointerdown", second, true); svg.ownerDocument.removeEventListener("pointerup", released, true); svg.ownerDocument.removeEventListener("pointercancel", released, true); } };
}
