import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { Extension, type Editor } from "@tiptap/react";
import { Plugin } from "@tiptap/pm/state";
import { useLiveQuery } from "dexie-react-hooks";
import { get, list, save } from "./db";
import { bindInkSurface, inkPath, InkHistory, recoverInkDrafts } from "./ink";
import { now, uid } from "./model";
import type { NotebookOverlay } from "./notebookAssets";
import type { InkStroke, InkStyle } from "./inkTypes";

export const NotebookInkAnchors = Extension.create({
  name: "notebookInkAnchors",
  addGlobalAttributes() {
    return [{ types: ["paragraph", "heading"], attributes: {
      inkAnchor: { default: null, parseHTML: () => null, renderHTML: attrs => attrs.inkAnchor ? { "data-ink-anchor": attrs.inkAnchor } : {} },
    } }];
  },
  addProseMirrorPlugins() {
    return [new Plugin({ appendTransaction(transactions, _old, state) {
      if (!transactions.some(transaction => transaction.docChanged)) return;
      const seen = new Map<string, { pos: number; attrs: Record<string, unknown>; empty: boolean }>();
      const normalize = state.tr;
      state.doc.descendants((node, pos) => {
        const id = node.attrs.inkAnchor;
        if (!id) return;
        const prior = seen.get(id);
        const current = { pos, attrs: node.attrs, empty: !node.textContent };
        if (!prior) { seen.set(id, current); return; }
        // Enter at the beginning of a paragraph creates an empty copy before
        // the original text. Preserve the anchor on the text in that case.
        const keepCurrent = prior.empty && !current.empty;
        const duplicate = keepCurrent ? prior : current;
        normalize.setNodeMarkup(duplicate.pos, undefined, { ...duplicate.attrs, inkAnchor: null });
        if (keepCurrent) seen.set(id, current);
      });
      if (normalize.docChanged) return normalize.setMeta("addToHistory", false);
    } })];
  },
});

export type PaperTool = "write" | "draw" | "select";
type AnchorBox = { left: number; top: number; unit: number };
type ResizeEdge = "width" | "height" | "corner";
type DrawingBounds = { left: number; top: number; width: number; height: number };
const clampScale = (value: number) => Math.max(.1, Math.min(10, value));
const frameFor = (anchor: AnchorBox, overlay: NotebookOverlay) => ({
  left: anchor.left + overlay.x * anchor.unit,
  top: anchor.top + overlay.y * anchor.unit,
  unit: anchor.unit * overlay.scale,
  unitX: anchor.unit * (overlay.scaleX ?? overlay.scale),
  unitY: anchor.unit * (overlay.scaleY ?? overlay.scale),
});

function resizeDrawing(overlay: NotebookOverlay, bounds: DrawingBounds, factorX: number, factorY: number) {
  const oldX = overlay.scaleX ?? overlay.scale, oldY = overlay.scaleY ?? overlay.scale;
  const scaleX = clampScale(oldX * factorX), scaleY = clampScale(oldY * factorY);
  const scale = factorX === factorY ? clampScale(overlay.scale * factorX) : overlay.scale;
  return { ...overlay, scale, scaleX, scaleY, x: overlay.x + bounds.left * (oldX - scaleX), y: overlay.y + bounds.top * (oldY - scaleY) };
}

export function NotebookPaperInk({ editor, noteId, paper, mode, style, saveNote, history, notice, bindingRef, writes, openDrawing }: {
  editor: Editor; noteId: string; paper: RefObject<HTMLDivElement | null>; mode: PaperTool;
  style: InkStyle; saveNote: () => Promise<boolean>; history: InkHistory;
  notice: (message: string) => void;
  bindingRef: RefObject<ReturnType<typeof bindInkSurface> | undefined>;
  writes: RefObject<Set<Promise<void>>>;
  openDrawing?: string;
}) {
  const scratch = useRef<SVGSVGElement>(null);
  const overlays = useLiveQuery(async () => (await list("notebook-overlay")).filter(drawing => drawing.noteId === noteId), [noteId]) || [];
  const strokes = useLiveQuery(async () => (await list("ink-stroke")).filter(s => s.target.type === "notebook" && s.target.noteId === noteId), [noteId]) || [];
  const [selected, setSelected] = useState<string>();
  const [preview, setPreview] = useState<NotebookOverlay>();
  const [anchorBoxes, setAnchorBoxes] = useState<Record<string, AnchorBox>>({});
  const draft = useRef<NotebookOverlay | undefined>(undefined);
  const latest = useRef({ mode, style, saveNote, notice });
  latest.current = { mode, style, saveNote, notice };
  const move = useRef<{ pointer: number; startX: number; startY: number; overlay: NotebookOverlay; anchor: AnchorBox; bounds: DrawingBounds; edge?: ResizeEdge; next?: NotebookOverlay } | undefined>(undefined);
  const frameButton = useRef<HTMLButtonElement>(null);

  function track(action: () => Promise<void>) {
    const write = action();
    writes.current.add(write);
    void write.then(() => writes.current.delete(write), () => writes.current.delete(write));
    return write;
  }

  function measure(element: Element, root: HTMLElement): AnchorBox {
    const r = element.getBoundingClientRect(), bounds = root.getBoundingClientRect();
    return { left: r.left - bounds.left, top: r.top - bounds.top, unit: Math.max(1, r.width) / 1000 };
  }

  function findAnchor(x: number, y: number) {
    const root = paper.current!;
    const paragraph = [...editor.view.dom.querySelectorAll("p,h1,h2,h3")].find(element => {
      const r = measure(element, root);
      return x >= r.left && x <= r.left + r.unit * 1000 && y >= r.top && y <= r.top + element.getBoundingClientRect().height;
    });
    if (!paragraph) return { id: "paper", box: measure(root, root) };
    // Setting a node attribute can replace its DOM element synchronously.
    const box = measure(paragraph, root);
    let id = paragraph.getAttribute("data-ink-anchor");
    if (!id) {
      editor.state.doc.descendants((node, position) => {
        if (id || !["paragraph", "heading"].includes(node.type.name) || editor.view.nodeDOM(position) !== paragraph) return;
        id = uid();
        editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, inkAnchor: id }).setMeta("addToHistory", false));
      });
    }
    return id ? { id, box } : { id: "paper", box: measure(root, root) };
  }

  useLayoutEffect(() => {
    const root = paper.current;
    if (!root) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const boxes: Record<string, AnchorBox> = { paper: measure(root, root) };
      editor.view.dom.querySelectorAll<HTMLElement>("[data-ink-anchor]").forEach(element => { boxes[element.dataset.inkAnchor!] = measure(element, root); });
      setAnchorBoxes(boxes);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule); observer.observe(root); observer.observe(editor.view.dom);
    editor.on("transaction", schedule);
    update();
    return () => { observer.disconnect(); editor.off("transaction", schedule); cancelAnimationFrame(frame); };
  }, [editor, paper]);

  useEffect(() => {
    if (!openDrawing || !overlays.some(drawing => drawing.id === openDrawing)) return;
    setSelected(openDrawing);
    requestAnimationFrame(() => frameButton.current?.scrollIntoView({ block: "nearest" }));
  }, [openDrawing, overlays.length]);

  useEffect(() => {
    if (!scratch.current) return;
    void recoverInkDrafts();
    const target = { type: "notebook" as const, noteId, blockId: "paper-preview" };
    const binding = bindInkSurface(scratch.current, {
      target, strokes: () => [], style: () => latest.current.style,
      enabled: () => latest.current.mode === "draw" && latest.current.style.tool !== "eraser",
      retainCommitted: false,
      commit: stroke => track(async () => {
        const [x, y] = stroke.points[0];
        const root = paper.current;
        if (!root) return;
        const anchor = findAnchor(x, y);
        // A session groups successive strokes on the same paragraph or blank paper.
        if (!draft.current || draft.current.anchor !== anchor.id) draft.current = {
          id: uid(), noteId, anchor: anchor.id, x: (x - anchor.box.left) / anchor.box.unit,
          y: (y - anchor.box.top) / anchor.box.unit, scale: 1, createdAt: now(),
        };
        const drawing = draft.current, origin = frameFor(anchor.box, drawing);
        const stored: InkStroke = {
          ...stroke, target: { ...target, blockId: drawing.id }, width: Math.min(40, stroke.width / origin.unit),
          points: stroke.points.map(([px, py, pressure]) => [(px - origin.left) / origin.unit, (py - origin.top) / origin.unit, pressure]),
        };
        if (!(await latest.current.saveNote())) throw new Error("Save the page before drawing again.");
        if (!(await get("notebook-overlay", drawing.id))) await save("notebook-overlay", drawing);
        await history.perform(stored);
      }),
      error: message => latest.current.notice(message),
    });
    bindingRef.current = binding;
    return () => { binding.flush(); binding.destroy(); if (bindingRef.current === binding) bindingRef.current = undefined; };
  }, [editor, noteId, paper, history, bindingRef]);

  useEffect(() => { draft.current = undefined; if (mode === "write") setSelected(undefined); }, [mode]);
  const ink = history.visible(strokes);
  const erasing = mode === "draw" && style.tool === "eraser";
  function begin(event: ReactPointerEvent<HTMLButtonElement>, overlay: NotebookOverlay, anchor: AnchorBox, bounds: DrawingBounds, edge?: ResizeEdge) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    move.current = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, overlay, anchor, bounds, edge };
  }
  function adjust(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = move.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (drag.edge) {
      const { width, height } = drag.bounds;
      const factor = 1 + (dx * width + dy * height) / (width * width + height * height);
      const x = drag.edge === "height" ? 1 : drag.edge === "width" ? 1 + dx / width : factor;
      const y = drag.edge === "width" ? 1 : drag.edge === "height" ? 1 + dy / height : factor;
      drag.next = resizeDrawing(drag.overlay, drag.bounds, x, y);
    } else drag.next = { ...drag.overlay, x: drag.overlay.x + dx / drag.anchor.unit, y: drag.overlay.y + dy / drag.anchor.unit };
    setPreview(drag.next);
  }
  function finish(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = move.current;
    if (!drag || event.pointerId !== drag.pointer) return;
    move.current = undefined; setPreview(undefined);
    if (!drag.next || event.type === "pointercancel") return;
    draft.current = undefined;
    const next = drag.next;
    void track(async () => {
      if (!drag.edge) {
        const absolute = frameFor(drag.anchor, next), anchor = findAnchor(absolute.left, absolute.top);
        next.anchor = anchor.id;
        next.x = (absolute.left - anchor.box.left) / anchor.box.unit;
        next.y = (absolute.top - anchor.box.top) / anchor.box.unit;
        next.scale = Math.max(.1, Math.min(10, absolute.unit / anchor.box.unit));
        if (next.scaleX !== undefined) next.scaleX = clampScale(absolute.unitX / anchor.box.unit);
        if (next.scaleY !== undefined) next.scaleY = clampScale(absolute.unitY / anchor.box.unit);
        if (!(await latest.current.saveNote())) throw new Error("Save the page before moving this drawing.");
      }
      await save("notebook-overlay", next);
    }).catch(e => notice(e.message));
  }
  const gestures = { onPointerMove: adjust, onPointerUp: finish, onPointerCancel: finish, onLostPointerCapture: finish };
  const unplaced = overlays.filter(drawing => !anchorBoxes[drawing.anchor] && ink.some(s => s.target.type === "notebook" && s.target.blockId === drawing.id));

  return <>
    <div className="paper-ink" data-tool={erasing ? "erase" : mode}>
      <svg className="paper-ink-art" aria-label="Drawings on this page">{overlays.map(saved => {
        const drawing = preview?.id === saved.id ? preview : saved;
        const anchor = anchorBoxes[drawing.anchor];
        if (!anchor) return null;
        const origin = frameFor(anchor, drawing);
        return <g key={drawing.id} transform={`translate(${origin.left} ${origin.top}) scale(${origin.unitX} ${origin.unitY})`}>
          {ink.filter(s => s.target.type === "notebook" && s.target.blockId === drawing.id).map(s => <path key={s.id} d={inkPath(s)} fill={s.color} opacity={s.tool === "highlighter" ? .3 : 1}
            onPointerDown={event => {
              if (event.button !== 0 || (!erasing && mode !== "select")) return;
              event.preventDefault();
              if (erasing) void history.perform(s, true).catch(e => notice(e.message)); else setSelected(drawing.id);
            }} />)}
        </g>;
      })}</svg>
      <svg ref={scratch} className="paper-ink-input" aria-label="Draw directly on the page" />
      {mode === "select" && overlays.filter(drawing => drawing.id === selected).map(saved => {
        const drawing = preview?.id === saved.id ? preview : saved, anchor = anchorBoxes[drawing.anchor];
        if (!anchor) return null;
        const origin = frameFor(anchor, drawing);
        const local = ink.filter(s => s.target.type === "notebook" && s.target.blockId === drawing.id);
        if (!local.length) return null;
        let left = 0, top = 0, right = 0, bottom = 0;
        for (const stroke of local) for (const [x, y] of stroke.points) {
          left = Math.min(left, x - stroke.width); top = Math.min(top, y - stroke.width);
          right = Math.max(right, x + stroke.width); bottom = Math.max(bottom, y + stroke.width);
        }
        const width = Math.max(24, (right - left) * origin.unitX), height = Math.max(24, (bottom - top) * origin.unitY);
        const bounds = { left, top, width, height };
        return <div key={drawing.id} className="paper-ink-frame" style={{ left: origin.left + left * origin.unitX, top: origin.top + top * origin.unitY, width, height }}>
          <button ref={frameButton} className="paper-ink-move" aria-label="Move drawing" {...gestures} onPointerDown={e => begin(e, drawing, anchor, bounds)} onKeyDown={event => {
            const offset = { ArrowUp: [0, -8], ArrowDown: [0, 8], ArrowLeft: [-8, 0], ArrowRight: [8, 0] }[event.key];
            if (!offset) return;
            event.preventDefault(); void save("notebook-overlay", { ...drawing, x: drawing.x + offset[0] / anchor.unit, y: drawing.y + offset[1] / anchor.unit }).catch(e => notice(e.message));
          }} />
          {(["width", "height", "corner"] as const).map(edge => <button key={edge} className={`paper-ink-resize paper-ink-${edge}`}
            aria-label={edge === "corner" ? "Resize drawing" : `Resize drawing ${edge}`} {...gestures}
            onPointerDown={e => begin(e, drawing, anchor, bounds, edge)} onKeyDown={event => {
              if (!["+", "=", "-"].includes(event.key)) return;
              event.preventDefault();
              const factor = event.key === "-" ? .9 : 1.1;
              void save("notebook-overlay", resizeDrawing(drawing, bounds, edge === "height" ? 1 : factor, edge === "width" ? 1 : factor)).catch(e => notice(e.message));
            }} />)}
        </div>;
      })}
    </div>
    {unplaced.length > 0 && <div className="unplaced-ink"><strong>Unplaced drawings</strong>{unplaced.map((drawing, index) => <button key={drawing.id} className="text-button" onClick={() => void (async () => {
      const root = paper.current!, cursor = editor.view.coordsAtPos(editor.state.selection.from), bounds = root.getBoundingClientRect();
      const anchor = findAnchor(cursor.left - bounds.left, cursor.top - bounds.top);
      if (!(await latest.current.saveNote())) throw new Error("Save the note before placing this drawing.");
      await save("notebook-overlay", { ...drawing, anchor: anchor.id, x: 20, y: 10 });
      setSelected(drawing.id);
    })().catch(e => notice(e.message))}>Place drawing {index + 1} at cursor</button>)}</div>}
  </>;
}
