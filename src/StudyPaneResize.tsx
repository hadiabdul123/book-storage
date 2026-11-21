import { useRef, type PointerEvent } from "react";

const clamp = (n:number,min:number,max:number) => Math.max(min,Math.min(n,max));
type Edge = "left" | "right" | "bottom" | "corner";
export function StudyPaneResize({ resize, height }: {
  resize: (width:number,height:number,x:number,y:number) => void; height:number;
}) {
  const start = useRef<{id:number;edge:Edge;px:number;py:number;area:DOMRect;pane:DOMRect;available:number} | undefined>(undefined);
  const down = (e:PointerEvent<HTMLButtonElement>,edge:Edge) => {
    const pane = e.currentTarget.closest("aside"), area = pane?.closest(".reader-workspace");
    if (!pane || !area || !e.isPrimary || e.button !== 0) return;
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
    const box = pane.getBoundingClientRect();
    start.current = {id:e.pointerId,edge,px:e.clientX,py:e.clientY,area:area.getBoundingClientRect(),pane:box,available:box.height/height*100};
  };
  const move = (e:PointerEvent<HTMLButtonElement>) => {
    const drag = start.current;
    if (!drag || drag.id !== e.pointerId) return;
    const {pane,area,edge,available} = drag;
    let left = pane.left-area.left, width = pane.width, h = pane.height;
    const top = pane.top-area.top, dx = e.clientX-drag.px, dy = e.clientY-drag.py;
    const minWidth = Math.min(280,width), minHeight = Math.min(190,h);
    if (edge === "left") { left = clamp(left+dx,0,left+width-minWidth); width = pane.right-area.left-left; }
    if (edge === "right" || edge === "corner") width = clamp(width+dx,minWidth,area.width-left);
    if (edge === "bottom" || edge === "corner") h = clamp(h+dy,minHeight,available-top);
    resize(width/area.width*100, h/available*100, clamp(left/Math.max(1,area.width-width),0,1),clamp(top/Math.max(1,available-h),0,1));
  };
  return <>{(["left","right","bottom","corner"] as const).map(edge =>
    <button key={edge} type="button" tabIndex={-1} aria-label={"Resize study notebook "+edge}
      className={"study-resize study-resize-"+edge} onPointerDown={e=>down(e,edge)} onPointerMove={move}
      onLostPointerCapture={()=>{start.current=undefined;}} />)}</>;
}
