import { useRef, useState, type PointerEvent, type RefObject } from "react";

const clipboardPrefix = "leafmark:attachments:";
let copied: string[] = [];
export function copiedMediaIds() { return copied; }
export function encodeMediaSelection(ids: string[]) {
  copied = ids;
  return clipboardPrefix + ids.join(",");
}
export function decodeMediaSelection(text: string) {
  if (!text.startsWith(clipboardPrefix) || text.length > 3500) return null;
  const ids = text.slice(clipboardPrefix.length).split(",");
  return ids.length <= 30 && ids.every(id => /^[a-z0-9-]{1,100}$/i.test(id)) ? [...new Set(ids)] : null;
}

type Box = { left: number; top: number; width: number; height: number };

export function useMediaSelection(paper: RefObject<HTMLDivElement | null>, active: boolean, onSelect: (ids: string[], area?: {left:number;right:number;top:number;bottom:number}) => void) {
  const drag = useRef<{ id: number; x: number; y: number; area: Box } | undefined>(undefined);
  const [box, setBox] = useState<Box>();
  function start(event: PointerEvent<HTMLDivElement>) {
    const root = paper.current;
    const target = event.target as Element;
    if (!active || !root || event.button !== 0 || !event.isPrimary || target.closest("[data-media-id], button, .workspace-menu, dialog")) return;
    event.preventDefault();
    const r = root.getBoundingClientRect(), x = event.clientX - r.left, y = event.clientY - r.top;
    drag.current = { id: event.pointerId, x, y, area: { left: x, top: y, width: 0, height: 0 } };
    root.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const initial = drag.current, root = paper.current;
    if (!initial || !root || initial.id !== event.pointerId) return;
    const r = root.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, event.clientX - r.left));
    const y = Math.max(0, Math.min(r.height, event.clientY - r.top));
    initial.area = { left: Math.min(x, initial.x), top: Math.min(y, initial.y), width: Math.abs(x - initial.x), height: Math.abs(y - initial.y) };
    setBox(initial.area);
  }
  function finish(event: PointerEvent<HTMLDivElement>) {
    const initial = drag.current, root = paper.current;
    if (!initial || !root || initial.id !== event.pointerId) return;
    drag.current = undefined; setBox(undefined);
    if (event.type !== "pointerup") return;
    const r = root.getBoundingClientRect(), area = initial.area;
    const x = r.left + area.left, y = r.top + area.top;
    const ids = area.width + area.height < 8 ? [] : [...root.querySelectorAll<HTMLElement>("[data-media-id]")].filter(item => {
      const b = item.getBoundingClientRect();
      return b.left <= x + area.width && b.right >= x && b.top <= y + area.height && b.bottom >= y;
    }).map(item => item.dataset.mediaId!);
    onSelect(ids, area.width + area.height < 8 ? undefined : {left:x,top:y,right:x+area.width,bottom:y+area.height});
  }
  return { box, handlers: { onPointerDownCapture: start, onPointerMoveCapture: move, onPointerUpCapture: finish, onPointerCancelCapture: finish, onLostPointerCapture: finish } };
}
