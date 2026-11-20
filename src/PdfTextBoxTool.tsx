import { useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { GripHorizontal, MoveDiagonal2, Trash2 } from "lucide-react";
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
  const input = useRef<HTMLTextAreaElement>(null);
  const drag = useRef<{ pointer: number; start: [number, number]; box: PdfTextBox; viewport: NonNullable<Props["surface"]>["viewport"] }>(undefined);
  useLayoutEffect(() => {
    input.current?.focus({ preventScroll: true });
    if (input.current) input.current.selectionStart = input.current.selectionEnd = input.current.value.length;
  }, [draft?.id, surface?.element]);

  function change(box: PdfTextBox, dx: number, dy: number, resize: boolean) {
    if (!surface) return;
    const [x, y] = boxPoint(box, dx, dy);
    const next = resize ? { ...box, width: box.width + dx, height: box.height + dy } : { ...box, x, y };
    update(fitPdfTextBox(next, surface.bounds, resize));
  }

  function handle(resize: boolean) {
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
        change(active.box, dx, dy, resize);
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
        change(draft, ...delta, resize);
      },
    };
  }

  return <>
    <div className="ink-toolbar pdf-text-box-tools" role="group" aria-label="PDF text box tools">
      {draft ? <>
        <label>Text size <select value={draft.fontSize} disabled={saving}
          onChange={event => update({ ...draft, fontSize: Number(event.target.value) })}>
          {boxFontSizes.map(size => <option key={size}>{size}</option>)}
        </select></label>
        <button type="button" aria-pressed={draft.tint} disabled={saving}
          onClick={() => update({ ...draft, tint: !draft.tint })}>Tint</button>
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
      style={{ width: draft.width, height: draft.height, transform: boxTransform(draft, surface.viewport) }}>
      <textarea ref={input} aria-label={  `Text box on page ${draft.page}` } maxLength={boxTextLimit}
        value={draft.text} readOnly={saving} placeholder="Type here"
        style={{ background: boxPaper(draft.tint), color: boxInk, padding: boxPadding, font: `${draft.fontSize}px/1.3 ${boxFont}` }}
        onChange={event => update({ ...draft, text: event.target.value })}
        onKeyDown={event => {
          if (event.key === "Escape" && !saving) { event.preventDefault(); event.stopPropagation(); cancel(); }
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !saving) { event.preventDefault(); save(); }
        }} />
      <button type="button" className="pdf-text-box-move" aria-label="Move text box" disabled={saving} {...handle(false)}><GripHorizontal size={17} /></button>
      <button type="button" className="pdf-text-box-resize" aria-label="Resize text box" disabled={saving} {...handle(true)}><MoveDiagonal2 size={16} /></button>
    </div>, surface.element)}
  </>;
}
