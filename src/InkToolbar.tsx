import { Lasso, PenLine, Highlighter, Eraser, Undo2, Redo2, X } from "lucide-react";
import type { InkStyle } from "./inkTypes";
import "./ink.css";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import { cloud } from "./sync";
export function InkToolbar({ style, change, undo, redo, close, exportPdf }: { style: InkStyle; change: (style: InkStyle) => void; undo: () => void; redo: () => void; close?: () => void; exportPdf?: () => void }) {
  const pending = useLiveQuery(() => db.outbox.filter(op => op.kind === "ink-stroke").count(), []) || 0;
  return <div className="ink-toolbar" role="toolbar" aria-label="Drawing tools">
    {([["pen", PenLine], ["highlighter", Highlighter], ["eraser", Eraser], ["lasso", Lasso]] as const).map(([tool, Icon]) => <button key={tool} aria-label={tool === "lasso" ? "Select ink with lasso" : tool === "eraser" ? "Stroke eraser" : tool === "pen" ? "Pen" : "Ink highlighter"} aria-pressed={style.tool === tool} onClick={() => change({ ...style, tool, width: tool === "highlighter" ? 14 : 2 })}><Icon size={19} /></button>)}
    <label title="Ink color"><span className="sr-only">Ink color</span><input aria-label="Ink color" type="color" value={style.color} onChange={e => change({ ...style, color: e.target.value })} /></label>
    {style.tool === "lasso" && (["color","delete"] as const).map(action =>
      <button key={action} onClick={e => (e.currentTarget.closest(".drawing-block") || e.currentTarget.closest(".notebook-detail") || e.currentTarget.closest(".topic-editor,.reader-shell"))?.dispatchEvent(new CustomEvent("leafmark-ink-action",{detail:action}))}>{action === "color" ? "Recolor selection" : "Delete selection"}</button>)}
    <label>Size<select aria-label="Ink thickness" value={style.width} onChange={e => change({ ...style, width: +e.target.value })}>{[1, 2, 4, 8, 14, 24].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
    <button aria-label="Undo drawing" onClick={undo}><Undo2 size={18} /></button><button aria-label="Redo drawing" onClick={redo}><Redo2 size={18} /></button>
    <label className="ink-pen-only"><input type="checkbox" checked={!!style.penOnly} onChange={e => change({ ...style, penOnly: e.target.checked })} />Pen only</label>
    {exportPdf && <button onClick={exportPdf}>Export marked PDF</button>}
    <span className="ink-save-state" role="status">{cloud && pending ? "Saved · waiting to sync" : cloud ? "Synced" : "Saved on this device"}</span>
    {close && <button aria-label="Finish drawing" onClick={close}><X size={18} /></button>}
  </div>;
}
