import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";

const key = "leafmark-study-pane-v1";
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
const defaults = { width: 36, height: 52, sheet: 38, x: .18, y: .38, customWidth: false };
type Layout = typeof defaults;
type Edge = "move" | "left" | "right" | "bottom" | "corner" | "top";
function readLayout(): Layout {
  try {
    const data = JSON.parse(localStorage.getItem(key) || "null");
    if (data && ["x","y","width","height","sheet"].every(field => Number.isFinite(data[field]))) {
      return { width: clamp(data.width, 15, 100), height: clamp(data.height, 10, 100),
        sheet: clamp(data.sheet, 24, 85), x: clamp(data.x, 0, 1), y: clamp(data.y, 0, 1), customWidth: data.customWidth === true };
    }
  } catch { /* Storage is optional. */ }
  return defaults;
}

export function useStudyPane() {
  const [layout, setLayout] = useState(readLayout);
  const query = "(min-width:600px)";
  const [floating, setFloating] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const change = () => setFloating(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const saved = useRef(layout);
  const latest = useRef(layout);
  latest.current = layout;
  function persist() {
    if (saved.current === latest.current) return;
    try {
      localStorage.setItem(key, JSON.stringify(latest.current));
      saved.current = latest.current;
    } catch { /* Keep this session usable when device storage is unavailable. */ }
  }
  useEffect(() => {
    window.addEventListener("pagehide", persist);
    return () => { window.removeEventListener("pagehide", persist); persist(); };
  }, []);
  useEffect(() => {
    const timer = setTimeout(persist, 160);
    return () => clearTimeout(timer);
  }, [layout]);
  const drag = useRef<{ pointer: number; edge: Edge; x: number; y: number; area: DOMRect; pane: DOMRect; available: number }>(undefined);
  function gesture(edge: Edge) {
    return {
      onPointerDown(event: PointerEvent<HTMLElement>) {
        if (!event.isPrimary || event.button !== 0 || (edge === "move" && (!floating || (event.target as Element).closest("button:not(.study-move)")))) return;
        const pane = event.currentTarget.closest("aside")!;
        const area = pane.closest(".reader-workspace")!.getBoundingClientRect();
        const footer = parseFloat(getComputedStyle(pane).scrollPaddingBottom) || 56;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointer: event.pointerId, edge, x: event.clientX, y: event.clientY, area, pane: pane.getBoundingClientRect(), available: Math.max(1,area.height-footer) };
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        const start = drag.current;
        if (!start || start.pointer !== event.pointerId || start.edge !== edge) return;
        const { area, pane, available } = start;
        const dx = event.clientX-start.x, dy = event.clientY-start.y;
        let left = pane.left-area.left, top = pane.top-area.top, width = pane.width, height = pane.height;
        if (edge === "top") { setLayout(l => ({ ...l, sheet: clamp((height-dy)/area.height*100,24,85) })); return; }
        if (edge === "move") { left += dx; top += dy; }
        if (edge === "left") { left = clamp(left+dx,0,left+width-Math.min(280,width)); width = pane.right-area.left-left; }
        if (edge === "right" || edge === "corner") width = clamp(width+dx,Math.min(280,width),area.width-left);
        if (edge === "bottom" || edge === "corner") height = clamp(height+dy,Math.min(190,height),available-top);
        const horizontal = edge === "right" || edge === "corner" || edge === "left";
        setLayout(l => ({ ...l, ...(horizontal ? {width: width/area.width*100, customWidth: true} : {}),
          ...(edge === "bottom" || edge === "corner" ? {height:height/available*100} : {}),
          x: clamp(left/Math.max(1,area.width-width),0,1), y: clamp(top/Math.max(1,available-height),0,1) }));
      },
      onLostPointerCapture() { drag.current = undefined; },
      onPointerCancel() { drag.current = undefined; },
    };
  }
  const style = { "--study-desktop-size": layout.customWidth ? layout.width+"%" : "min(36%,480px)",
    "--study-mobile-size": layout.sheet+"%", "--study-pos-x":layout.x, "--study-pos-y":layout.y,
    "--study-pane-height":layout.height/100 } as CSSProperties;
  const handles = (floating ? ["left","right","bottom","corner"] as const : ["top"] as const).map(edge =>
    <button key={edge} type="button" tabIndex={-1} aria-label={"Resize study notebook "+edge} className={"study-resize study-resize-"+edge} {...gesture(edge)} />);
  const moveButton = floating && <button className="study-move" aria-label="Move study notebook" title="Drag the title bar or use the arrow keys"
    onKeyDown={event => {
      const offsets: Record<string, [number,number]> = { ArrowLeft:[-.1,0], ArrowRight:[.1,0], ArrowUp:[0,-.1], ArrowDown:[0,.1] };
      const delta = offsets[event.key];
      if (!delta) return;
      event.preventDefault();
      setLayout(l => ({ ...l, x:clamp(l.x+delta[0],0,1), y:clamp(l.y+delta[1],0,1) }));
    }}>⠿</button>;
  return { style, handles, moveButton, header: gesture("move"), size: floating ? layout.width : layout.sheet, max: floating ? 100 : 85,
    setSize: (size: number) => setLayout(l => floating ? {...l,width:size,customWidth:true} : {...l,sheet:size}) };
}
