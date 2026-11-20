import { useEffect, useRef, useState } from "react";
import { Node, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useLiveQuery } from "dexie-react-hooks";
import { list } from "./db";
import { bindInkSurface, InkHistory, recoverInkDrafts } from "./ink";
import { defaultInkStyle } from "./inkTypes";
import { InkToolbar } from "./InkToolbar";
function DrawingView({ node, extension, updateAttributes, selected }: NodeViewProps) {
  const svg = useRef<SVGSVGElement>(null), history = useRef(new InkHistory());
  const [style, setStyle] = useState(defaultInkStyle), [message, setMessage] = useState("");
  const [editing, setEditing] = useState(false);
  const strokes = useLiveQuery(async () => (await list("ink-stroke")).filter(s => s.target.type === "notebook" && s.target.noteId === extension.options.noteId && s.target.blockId === node.attrs.blockId), [extension.options.noteId, node.attrs.blockId]) || [];
  const latest = useRef({ strokes, style, editing }); latest.current = { strokes, style, editing };
  const binding = useRef<ReturnType<typeof bindInkSurface> | undefined>(undefined);
  useEffect(() => {
    void recoverInkDrafts();
    if (!svg.current) return;
    const element = svg.current;
    binding.current = bindInkSurface(element, {
      target: { type: "notebook", noteId: extension.options.noteId, blockId: node.attrs.blockId },
      history: history.current, strokes: () => history.current.visible(latest.current.strokes), style: () => latest.current.style, enabled: () => latest.current.editing,
      commit: (stroke, deleted) => history.current.perform(stroke, deleted), error: setMessage,
    });
    return () => binding.current?.destroy();
  }, [extension.options.noteId, node.attrs.blockId]);
  useEffect(() => { binding.current?.paint(); if (!editing) binding.current?.cancel(); }, [strokes, editing]);
  // Two-finger gestures adjust only the drawing's viewport; stored vectors stay unchanged.
  useEffect(() => {
    const element = svg.current; if (!element) return;
    let initial: { distance: number; x: number; y: number; box: number[] } | undefined;
    const span = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    const start = (e: TouchEvent) => { if (element.dataset.inkPenActive === "true") return; if (e.touches.length === 2) { binding.current?.cancel(); e.preventDefault(); initial = { distance: span(e), x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2, box: element.getAttribute("viewBox")!.split(" ").map(Number) }; } };
    const move = (e: TouchEvent) => {
      if (!initial || e.touches.length !== 2) return; e.preventDefault();
      const r = element.getBoundingClientRect(), ratio = Math.max(.5, Math.min(3, span(e) / Math.max(1, initial.distance)));
      const width = Math.max(250, Math.min(1000, initial.box[2] / ratio)), height = width * .6;
      const x = initial.box[0] + (initial.box[2] - width) / 2 - ((e.touches[0].clientX + e.touches[1].clientX) / 2 - initial.x) / r.width * width;
      const y = initial.box[1] + (initial.box[3] - height) / 2 - ((e.touches[0].clientY + e.touches[1].clientY) / 2 - initial.y) / r.height * height;
      element.setAttribute("viewBox", `${Math.max(0, Math.min(1000 - width, x))} ${Math.max(0, Math.min(600 - height, y))} ${width} ${height}`);
    };
    const end = () => { initial = undefined; };
    element.addEventListener("touchstart", start, { passive: false }); element.addEventListener("touchmove", move, { passive: false }); element.addEventListener("touchend", end); element.addEventListener("touchcancel", end);
    return () => { element.removeEventListener("touchstart", start); element.removeEventListener("touchmove", move); element.removeEventListener("touchend", end); element.removeEventListener("touchcancel", end); };
  }, []);
  return <NodeViewWrapper as="figure" className={`drawing-block ${selected ? "selected" : ""}`} contentEditable={false}
    onMouseDownCapture={(e: React.MouseEvent) => { if ((e.target as Element).closest("button")) { e.preventDefault(); e.stopPropagation(); } }}>
    <figcaption><span>Drawing · saved with this page</span><button className="text-button" onClick={() => setEditing(!editing)}>{editing ? "Done drawing" : "Edit drawing"}</button></figcaption>
    {editing && <InkToolbar style={style} change={setStyle} undo={() => void history.current.move().catch(e => setMessage(e.message))} redo={() => void history.current.move(true).catch(e => setMessage(e.message))} />}
    <div className="drawing-size" style={{ height: node.attrs.height }} onPointerUp={e => { if (e.target === e.currentTarget) updateAttributes({ height: Math.max(140, Math.min(800, e.currentTarget.offsetHeight)) }); }}>
      <svg ref={svg} className="notebook-ink" viewBox="0 0 1000 600" preserveAspectRatio="none" aria-label="Notebook drawing" style={{ touchAction: editing ? "none" : "pan-y" }} />
    </div>
    {message && <p role="status">{message}<button className="text-button" onClick={() => void history.current.retry().then(() => { setMessage(""); binding.current?.paint(); }, e => setMessage(`Could not save drawing: ${e.message}. Keep this page open and retry.`))}>Retry saving drawings</button></p>}
  </NodeViewWrapper>;
}
export const DrawingExtension = Node.create<{ noteId: string }>({
  name: "drawing", group: "block", atom: true, selectable: true, draggable: false,
  addOptions: () => ({ noteId: "" }),
  addAttributes: () => ({ blockId: { default: null }, height: { default: 300 } }),
  parseHTML: () => [], renderHTML: ({ node }) => ["figure", { "data-drawing": node.attrs.blockId }, "Drawing"],
  addNodeView: () => ReactNodeViewRenderer(DrawingView),
});
