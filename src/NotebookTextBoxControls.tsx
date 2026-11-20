import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { Grip, MoveDiagonal2 } from "lucide-react";
import { ItemMenu } from "./ItemMenu";
import { uid } from "./model";
import { selectedTextBox, validTextBox, type TextBox } from "./notebookTextBox";
import "./notebookTextBoxes.css";

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function NotebookTextBoxControls({ editor, paper, enabled }: { editor: Editor; paper: RefObject<HTMLDivElement | null>; enabled: boolean }) {
  const [frame, setFrame] = useState<{ x: number; y: number; width: number; height: number }>();
  const updateFrame = useRef<() => void>(() => {});
  const removeDrag = useRef<() => void>(() => {});
  useEffect(() => {
    const root = paper.current;
    if (!root) return;
    const observed = new Set<Element>();
    const observer = new ResizeObserver(() => refresh());
    observer.observe(root);
    function refresh() {
      if (!root || editor.isDestroyed) return;
      const boxes = new Set<Element>(root.querySelectorAll("[data-notebook-text-box]"));
      for (const box of observed) if (!boxes.has(box)) { observer.unobserve(box); observed.delete(box); }
      const writing = editor.view.dom;
      if (!boxes.size) {
        writing.style.removeProperty("--text-box-extent");
        setFrame(undefined);
        return;
      }
      const bounds = root.getBoundingClientRect();
      root.style.setProperty("--text-box-unit", `${bounds.width}px`);
      let bottom = 0;
      for (const box of boxes) {
        if (!observed.has(box)) { observed.add(box); observer.observe(box); }
        if (box.getAttribute("data-free-box") === "true") bottom = Math.max(bottom, box.getBoundingClientRect().bottom - bounds.top + 40);
      }
      // The writing wrapper reserves space beyond inline text for any free box.
      writing.style.setProperty("--text-box-extent", `${Math.ceil(bottom)}px`);
      const selected = enabled && selectedTextBox(editor);
      const element = selected && editor.view.nodeDOM(selected.at);
      if (!(element instanceof HTMLElement)) { setFrame(undefined); return; }
      const rect = element.getBoundingClientRect();
      setFrame({ x: rect.left - bounds.left, y: rect.top - bounds.top, width: rect.width, height: rect.height });
    }
    updateFrame.current = refresh;
    editor.on("transaction", refresh);
    refresh();
    return () => {
      removeDrag.current(); observer.disconnect(); editor.off("transaction", refresh);
    };
  }, [editor, paper, enabled]);
  const selected = enabled && selectedTextBox(editor);
  if (!selected || !frame || !paper.current) return null;
  const { node, box } = selected;
  const root = paper.current;
  function update(next: TextBox) {
    const active = selectedTextBox(editor);
    if (!active || !validTextBox(next)) return;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(active.at, undefined, { ...active.node.attrs, textBox: next }));
  }
  function shift(seed: TextBox, dx: number, dy: number, resize: boolean) {
    const width = Math.max(1, root.getBoundingClientRect().width);
    if (resize) return { ...seed, width: clamp(seed.width + dx / width, .2, 1 - (seed.free?.x || 0)),
      minHeight: clamp(seed.minHeight + dy, 48, 800) };
    if (!seed.free) return seed;
    return { ...seed, free: { x: clamp(seed.free.x + dx / width, 0, 1 - seed.width), y: clamp(seed.free.y + dy / width, 0, 100) } };
  }
  function drag(event: PointerEvent<HTMLButtonElement>, resize: boolean) {
    event.preventDefault();
    removeDrag.current();
    const active = selectedTextBox(editor);
    const paragraph = active && editor.view.nodeDOM(active.at);
    if (!(paragraph instanceof HTMLElement)) return;
    const anchor = paragraph.dataset.inkAnchor;
    if (!anchor) return;
    const handle = event.currentTarget;
    const start = { x: event.clientX, y: event.clientY };
    // Preview outside the editable DOM so ProseMirror never treats a drag as typing.
    const style = document.createElement("style");
    document.head.append(style);
    let draft = box;
    const finish = (e: Event) => {
      clean();
      if (e.type === "pointerup" && draft !== box) update(draft);
    };
    const move = (e: globalThis.PointerEvent) => {
      draft = shift(box, e.clientX - start.x, e.clientY - start.y, resize);
      const position = draft.free ? `left:${draft.free.x * 100}% !important;--text-box-y:${draft.free.y} !important;` : "";
      style.textContent = `[data-ink-anchor="${CSS.escape(anchor)}"]{width:${draft.width * 100}% !important;min-height:${draft.minHeight}px !important;${position}}`;
      updateFrame.current();
    };
    const clean = () => {
      style.remove();
      handle.removeEventListener("pointermove", move);
      for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) handle.removeEventListener(name, finish);
      removeDrag.current = () => {};
      updateFrame.current();
    };
    handle.setPointerCapture(event.pointerId);
    handle.addEventListener("pointermove", move);
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) handle.addEventListener(name, finish);
    removeDrag.current = clean;
  }
  function boxAction(action: "duplicate" | "delete" | -1 | 1) {
    const active = selectedTextBox(editor);
    if (!active) return;
    const { at, node } = active;
    const tr = editor.state.tr;
    const end = at + node.nodeSize;
    if (action === "delete") tr.delete(at, end);
    else if (action === "duplicate") {
      const copy = node.type.create({ ...node.attrs, inkAnchor: uid(), textBox: { ...box, free: undefined } }, node.content);
      tr.insert(end, copy).setSelection(TextSelection.create(tr.doc, end + 1));
    } else {
      const adjacent = action < 0 ? tr.doc.resolve(at).nodeBefore : tr.doc.resolve(end).nodeAfter;
      if (!adjacent) return;
      const to = action < 0 ? at - adjacent.nodeSize : at + adjacent.nodeSize;
      tr.delete(at, end).insert(to, node).setSelection(TextSelection.create(tr.doc, to + 1));
    }
    editor.view.dispatch(tr);
    editor.view.focus();
  }
  const dimensions = (resize: boolean) => ({
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => drag(event, resize),
    onKeyDown: (event: React.KeyboardEvent) => {
      const direction = { ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, -12], ArrowDown: [0, 12] }[event.key];
      if (!direction) return;
      event.preventDefault();
      update(shift(box, direction[0], direction[1], resize));
    },
  });
  return <div className="notebook-box-frame" style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}>
    <ItemMenu title="text box" actions={[
      { label: box.free ? "Move inline" : "Move freely", run: () => {
        const { width } = root.getBoundingClientRect();
        update({ ...box, free: box.free ? undefined : { x: clamp(frame.x / width, 0, 1 - box.width), y: clamp(frame.y / width, 0, 100) } });
      } },
      { label: box.tint ? "Plain background" : "Tint background", run: () => update({ ...box, tint: !box.tint }) },
      { label: "Move up", disabled: !!box.free, run: () => boxAction(-1) },
      { label: "Move down", disabled: !!box.free, run: () => boxAction(1) },
      { label: "Duplicate", run: () => boxAction("duplicate") },
      { label: "Delete", danger: true, run: () => boxAction("delete") },
    ]}><span /></ItemMenu>
    {box.free && <button className="notebook-box-move" aria-label="Move text box" {...dimensions(false)}><Grip size={17} /></button>}
    <button className="notebook-box-resize" aria-label="Resize text box" {...dimensions(true)}><MoveDiagonal2 size={17} /></button>
  </div>;
}
