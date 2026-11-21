import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { GripHorizontal, MoveDiagonal2, Trash2, Underline } from "lucide-react";
import { boxDelta, boxFont, boxFontSizes, boxInk, boxPadding, boxPaper, boxPoint, boxTextLimit,
  boxTransform, fitPdfTextBox, type PdfTextBox } from "./pdfTextBoxes";
import type { PdfReader } from "./reader/pdf";
import "./ink.css";
import "./pdfTextBoxes.css";

type Props = {
  draft?: PdfTextBox;
  surface: ReturnType<PdfReader["textBoxSurface"]>;
  saved: boolean;
  saving: boolean;
  placing: boolean;
  update: (box: PdfTextBox) => void;
  place: () => void;
  save: () => void;
  remove: () => void;
  exportPdf: () => void;
  cancel: () => void;
};

export function PdfTextBoxTool({ draft, surface, saved, saving, placing, update, place, save, remove, exportPdf, cancel }: Props) {
  const [more, setMore] = useState(false);
  const tools = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setMore(false);
  }, [draft?.id]);
  useEffect(() => {
    if (!more) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (!tools.current?.contains(event.target as Node)) setMore(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && tools.current?.contains(event.target as Node)) {
        event.preventDefault(); setMore(false); tools.current.querySelector<HTMLButtonElement>(".pdf-format-more")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [more]);
  const input = useRef<HTMLTextAreaElement>(null);
  const drag = useRef<{ pointer: number; start: [number, number]; box: PdfTextBox; viewport: NonNullable<Props["surface"]>["viewport"] }>(undefined);
  useLayoutEffect(() => {
    input.current?.focus({ preventScroll: true });
    if (input.current) input.current.selectionStart = input.current.selectionEnd = input.current.value.length;
  }, [draft?.id, surface?.element]);

  function change(box: PdfTextBox, dx: number, dy: number, mode: "move" | "scale" | "width" | "height") {
    if (!surface) return;
    const [x, y] = boxPoint(box, dx, dy);
    if (mode === "scale") {
      const ratio = 1 + (dx * box.width + dy * box.height) / (box.width ** 2 + box.height ** 2);
      const room = fitPdfTextBox({ ...box, width: 100000, height: 100000 }, surface.bounds, true);
      const max = Math.min(room.width / box.width, room.height / box.height, 72 / box.fontSize);
      const min = Math.min(1, Math.max(8 / box.fontSize, 48 / box.width, 32 / box.height));
      const scale = Math.max(min, Math.min(ratio, max));
      update({ ...box, width: box.width * scale, height: box.height * scale, fontSize: Math.round(box.fontSize * scale * 10) / 10 });
      return;
    }
    const next = mode === "move" ? { ...box, x, y } : { ...box, width: box.width + (mode === "width" ? dx : 0), height: box.height + (mode === "height" ? dy : 0) };
    update(fitPdfTextBox(next, surface.bounds, mode !== "move"));
  }

  function handle(mode: "move" | "scale" | "width" | "height") {
    const point = (e: PointerEvent) => {
      const rect = surface!.element.getBoundingClientRect();
      const viewport = surface!.viewport;
      return viewport.convertToPdfPoint(
        (e.clientX - rect.left) * viewport.width / rect.width,
        (e.clientY - rect.top) * viewport.height / rect.height,
      ) as [number, number];
    };
    return {
      onPointerDown(e: PointerEvent<HTMLButtonElement>) {
        if (!draft || !surface?.ready || saving || !e.isPrimary || e.button !== 0) return;
        e.preventDefault();
        drag.current = { pointer: e.pointerId, start: point(e), box: draft, viewport: surface.viewport };
        e.currentTarget.setPointerCapture(e.pointerId);
      },
      onPointerMove(e: PointerEvent<HTMLButtonElement>) {
        const active = drag.current;
        if (!active || active.pointer !== e.pointerId || active.viewport !== surface?.viewport) return;
        const [dx, dy] = boxDelta(active.box.rotation, active.start, point(e));
        change(active.box, dx, dy, mode);
      },
      onLostPointerCapture() { drag.current = undefined; },
      onPointerCancel() { drag.current = undefined; },
      onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
        const moves: Record<string, [number, number]> = {
          ArrowLeft: [-4, 0], ArrowRight: [4, 0], ArrowUp: [0, -4], ArrowDown: [0, 4],
        };
        const delta = moves[e.key];
        if (!draft || !delta) return;
        e.preventDefault();
        change(draft, ...delta, mode);
      },
    };
  }

  return <>
    <div ref={tools} className="ink-toolbar pdf-text-box-tools" role="group" aria-label="PDF text box tools">
      {draft ? <>
        <button type="button" className="pdf-format-more" aria-expanded={more} aria-controls="pdf-box-format" onClick={() => setMore(!more)}>More</button>
        <div id="pdf-box-format" className="pdf-box-format" data-open={more}>
        <label>Text size <select value={draft.fontSize} disabled={saving}
          onChange={event => update({ ...draft, fontSize: Number(event.target.value) })}>
          {(!boxFontSizes.some(size => size === draft.fontSize)) && <option>{draft.fontSize}</option>}
          {boxFontSizes.map(size => <option key={size}>{size}</option>)}
        </select></label>
        <label>Weight <select value={draft.weight || "regular"} disabled={saving}
          onChange={event => update({ ...draft, weight: event.target.value as PdfTextBox["weight"] })}>
          <option value="light">Light</option><option value="regular">Regular</option><option value="bold">Bold</option>
        </select></label>
        <button type="button" title="Underline" aria-label="Underline" aria-pressed={!!draft.underline}
          disabled={saving} onClick={() => update({ ...draft, underline: !draft.underline })}><Underline size={17} /></button>
        <label>Background <select value={draft.transparent ? "transparent" : draft.tint ? "tint" : "paper"} disabled={saving}
          onChange={event => update({ ...draft, transparent: event.target.value === "transparent", tint: event.target.value === "tint" })}>
          <option value="transparent">Transparent</option><option value="paper">Paper</option><option value="tint">Tint</option>
        </select></label>
        </div>
        <button className="primary" type="button" disabled={saving || !draft.text.trim()} onClick={save}>Save text box</button>
        {saved && <button type="button" aria-label="Delete text box" disabled={saving} onClick={remove}><Trash2 size={17} /></button>}
        <button type="button" disabled={saving} onClick={cancel}>Cancel</button>
      </> : <>
        <span>Tap the page to place a text box or select one to edit.</span>
        <button type="button" disabled={placing} onClick={place}>{placing ? "Opening text box…" : "Place on current page"}</button>
        <button type="button" onClick={exportPdf}>Export marked PDF</button>
        <button type="button" onClick={cancel}>Done</button>
      </>}
    </div>
    {draft && surface && createPortal(<div className="pdf-text-box-edit"
      style={{ width: draft.width, height: draft.height, transform: boxTransform(draft, surface.viewport),
        "--handle-unit": (1 / Math.hypot(surface.viewport.transform[0],surface.viewport.transform[1])) + "px" } as React.CSSProperties}>
      <textarea ref={input} aria-label={  `Text box on page ${draft.page}` } maxLength={boxTextLimit}
        value={draft.text} readOnly={saving} placeholder="Type here. Tap outside to save."
        style={{ background: boxPaper(draft), color: boxInk(draft), padding: boxPadding, font: boxFont(draft, true), textDecoration: draft.underline ? "underline" : "none" }}
        onChange={event => update({ ...draft, text: event.target.value })}
        onKeyDown={event => {
          if (event.key === "Escape" && !saving) { event.preventDefault(); event.stopPropagation(); cancel(); }
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !saving) { event.preventDefault(); save(); }
        }} />
      <button type="button" className="pdf-text-box-move" aria-label="Move text box" disabled={saving} {...handle("move")}><GripHorizontal size={17} /></button>
      <button type="button" className="pdf-text-box-width" aria-label="Change box width" disabled={saving} {...handle("width")}>&#8596;</button>
      <button type="button" className="pdf-text-box-height" aria-label="Change box height" disabled={saving} {...handle("height")}>&#8596;</button>
      <button type="button" className="pdf-text-box-resize" aria-label="Resize text box" disabled={saving} {...handle("scale")}><MoveDiagonal2 size={16} /></button>
    </div>, surface.element)}
  </>;
}
