import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Scan, PenLine, Highlighter, Plus, Type } from "lucide-react";
import { createPortal } from "react-dom";
import "./notebookToolRail.css";

const icons = { Select: Scan, Pen: PenLine, Highlight: Highlighter, Insert: Plus, Format: Type };
export type ToolName = keyof typeof icons;
export function NotebookToolRail({ active, choose, palette, disabled }: {
  active?: ToolName; choose: (tool: ToolName) => void;
  palette: (tool: ToolName, close: () => void) => ReactNode; disabled: boolean;
}) {
  const [opened, setOpened] = useState<ToolName>();
  const [tip, setTip] = useState<ToolName>();
  const [bounds, setBounds] = useState({left: 0, top: 0, width: 225, maxHeight: 350});
  const rail = useRef<HTMLDivElement>(null), popup = useRef<HTMLDivElement>(null);
  const tool = opened ?? tip;
  useEffect(() => { if (opened === "Pen" && active !== "Pen" || opened === "Select" && active !== "Select") setOpened(undefined); }, [active, opened]);
  useLayoutEffect(() => {
    if (!tool || !rail.current) return;
    const item = rail.current.querySelector('button[data-tool="' + tool + '"]')!;
    const update = () => {
      const r = item.getBoundingClientRect();
      const container = rail.current?.closest(".reader-panel,.notebook-detail")?.getBoundingClientRect();
      const right = Math.min(innerWidth, container?.right ?? innerWidth);
      const width = Math.min(250, right - r.right - 12);
      const top = Math.max(8, container?.top ?? 0);
      const bottom = Math.min(innerHeight, container?.bottom ?? innerHeight) - 8;
      const height = popup.current?.scrollHeight || 32;
      setBounds({ left: r.right + 4, width, top: Math.max(top, Math.min(r.top, bottom - height)), maxHeight: bottom - top });
    };
    update();
    const observer = new ResizeObserver(update);
    if (popup.current) observer.observe(popup.current);
    window.addEventListener("resize", update); document.addEventListener("scroll", update, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", update); document.removeEventListener("scroll", update, true); };
  }, [tool, opened]);
  useEffect(() => {
    if (!opened) return;
    const close = (e: PointerEvent) => {
      if (!rail.current?.contains(e.target as Node) && !popup.current?.contains(e.target as Node)) setOpened(undefined);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpened(undefined); setTip(undefined);
        rail.current?.querySelector<HTMLButtonElement>('button[data-tool="' + opened + '"]')?.focus();
      }
    };
    document.addEventListener("pointerdown", close, true); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close, true); document.removeEventListener("keydown", escape); };
  }, [opened]);
  return <div className="note-tool-rail" ref={rail} role="toolbar" aria-label="Topic note formatting" aria-orientation="vertical">
    {(Object.keys(icons) as ToolName[]).map(name => {
      const Icon = icons[name];
      return <button key={name} type="button" data-tool={name} aria-label={name} disabled={disabled}
        aria-expanded={opened === name} aria-pressed={name === "Pen" || name === "Select" || name === "Highlight" ? active === name : undefined}
        onMouseDown={e => e.preventDefault()} onFocus={() => setTip(name)} onBlur={() => setTip(undefined)}
        onPointerEnter={e => { if (e.pointerType === "mouse") { setTip(name); if (active === name) setOpened(name); } }}
        onPointerLeave={() => setTip(undefined)}
        onKeyDown={e => {
          if (e.key === "ArrowRight" || e.key === "ArrowDown" && opened === name) {
            e.preventDefault(); if (active !== name && (name === "Select" || name === "Pen" || name === "Highlight")) choose(name);
            setOpened(name); requestAnimationFrame(() => popup.current?.querySelector<HTMLElement>("button,input")?.focus());
          }
        }}
        onClick={() => {
          setTip(undefined);
          if (active === name) setOpened(name);
          else if (name === "Insert" || name === "Format") setOpened(opened === name ? undefined : name);
          else { choose(name); setOpened(undefined); }
        }}><Icon size={19} strokeWidth={1.7} /></button>;
    })}
    {tool && rail.current && createPortal(opened
      ? <div className="note-tool-palette" role="group" aria-label={opened + " options"} ref={popup} style={bounds}
          onMouseDown={e => { if (!(e.target as Element).closest("input,select,textarea")) e.preventDefault(); }}>
          {palette(opened, () => setOpened(undefined))}
        </div>
      : <span className="note-tool-tip" role="tooltip" style={{ left:bounds.left, top:bounds.top }}>{tip}</span>,
      document.fullscreenElement ?? document.body)}
  </div>;
}
