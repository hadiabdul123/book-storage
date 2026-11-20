import type { InkPoint, InkStroke } from "./inkTypes";
import type { InkHistory, InkProjection } from "./ink";

export type LassoStroke = { stroke: InkStroke; project: InkProjection; unproject: InkProjection };
type Point = [number,number];
const ns = "http://www.w3.org/2000/svg";
function inside(x: number,y: number,polygon: Point[]) {
  let hit = false;
  for (let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
    const a=polygon[i], b=polygon[j];
    if ((a[1]>y)!==(b[1]>y) && x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]) hit=!hit;
  }
  return hit;
}
export function bindInkLasso(svg: SVGSVGElement, options: {
  enabled: () => boolean; candidates: () => LassoStroke[];
  history: InkHistory; color: () => string; error: (message: string) => void;
}) {
  const scope=()=>svg.closest(".drawing-block") || svg.closest(".notebook-detail") || svg.closest(".study-notebook,.reader-shell");
  const graphics=document.createElementNS(ns,"g");
  graphics.setAttribute("class","ink-lasso");
  const shape=document.createElementNS(ns,"path"), grip=document.createElementNS(ns,"circle");
  graphics.append(shape,grip);
  let ids = new Set<string>(), bounds = [0,0,0,0], polygon: Point[] = [];
  let gesture: { pointer:number; start:Point; mode:"loop"|"move"|"resize"; scale:number; dx:number; dy:number } | undefined;
  let busy=false;
  const point=(e:PointerEvent):Point=>{
    const p=new DOMPoint(e.clientX,e.clientY).matrixTransform(svg.getScreenCTM()!.inverse());
    return [p.x,p.y];
  };
  const reset=()=>{ ids.clear();gesture=undefined;graphics.remove(); };
  const selection=()=>options.candidates().filter(c=>ids.has(c.stroke.id));
  function render() {
    if (!options.enabled()) { reset();return; }
    if (!ids.size) { graphics.remove();return; }
    const corners=[Infinity,Infinity,-Infinity,-Infinity];
    for(const item of selection()) for(const p of item.stroke.points) {
      const [x,y]=item.project(p[0],p[1]);
      corners[0]=Math.min(corners[0],x);corners[1]=Math.min(corners[1],y);
      corners[2]=Math.max(corners[2],x);corners[3]=Math.max(corners[3],y);
    }
    if (!Number.isFinite(corners[0])) {reset();return;}
    bounds=corners;
    const [left,top,right,bottom]=bounds;
    svg.append(graphics);
    shape.setAttribute("d","M "+left+" "+top+" H "+right+" V "+bottom+" H "+left+" Z");
    grip.setAttribute("cx",String(right));grip.setAttribute("cy",String(bottom));grip.setAttribute("r","9");grip.style.display="";
  }
  async function edit(action:"delete"|"color"|"transform", dx=0,dy=0,scale=1) {
    if(busy || !options.enabled() || !ids.size)return;
    busy=true;
    try {
      const [left,top]=bounds;
      const changes=selection().map(({stroke,project,unproject})=>{
        if(action==="delete")return {before:stroke};
        if(action==="color")return {before:stroke,after:{...stroke,color:options.color()}};
        const points=stroke.points.map(([x,y,pressure]):InkPoint=>{
          const p=project(x,y);
          const q=unproject(left+(p[0]-left)*scale+dx,top+(p[1]-top)*scale+dy);
          return [q[0],q[1],pressure];
        });
        return {before:stroke,after:{...stroke,points,width:Math.min(40,stroke.width*scale)}};
      });
      await options.history.edit(changes);
      reset();
    } catch(e) { options.error(e instanceof Error?e.message:String(e)); } finally {busy=false;}
  }
  const down=(e:PointerEvent)=>{
    if(!options.enabled() || busy || e.button!==0 || !e.isPrimary)return;
    const p=point(e), [l,t,r,b]=bounds;
    const mode=ids.size && (e.target===grip || Math.hypot(p[0]-r,p[1]-b)<12) ? "resize" :
      ids.size && p[0]>=l-5 && p[0]<=r+5 && p[1]>=t-5 && p[1]<=b+5 ? "move" : "loop";
    if(mode==="loop"){reset();polygon=[p];svg.append(graphics);shape.setAttribute("d","");grip.style.display="none";}
    gesture={pointer:e.pointerId,start:p,mode,dx:0,dy:0,scale:1};
    svg.setPointerCapture(e.pointerId);e.preventDefault();e.stopImmediatePropagation();
  };
  const move=(e:PointerEvent)=>{
    if(!gesture || gesture.pointer!==e.pointerId)return;
    const p=point(e); e.preventDefault();e.stopImmediatePropagation();
    if(gesture.mode==="loop"){
      polygon.push(p);shape.setAttribute("d","M "+polygon.map(v=>v.join(" ")).join(" L ")+" Z");
    } else {
      const [l,t,r,b]=bounds;
      gesture.dx=gesture.mode==="move"?p[0]-gesture.start[0]:0;
      gesture.dy=gesture.mode==="move"?p[1]-gesture.start[1]:0;
      gesture.scale=gesture.mode==="resize"?Math.max(.15,Math.min(8,Math.hypot(p[0]-l,p[1]-t)/Math.max(1,Math.hypot(r-l,b-t)))):1;
      graphics.setAttribute("transform","translate("+(l+gesture.dx)+" "+(t+gesture.dy)+") scale("+gesture.scale+") translate("+(-l)+" "+(-t)+")");
    }
  };
  const up=(e:PointerEvent)=>{
    if(!gesture || gesture.pointer!==e.pointerId)return;
    move(e);const g=gesture;gesture=undefined;graphics.removeAttribute("transform");
    if(g.mode==="loop"){
      ids=new Set(options.candidates().filter(c=>c.stroke.points.some(p=>{const [x,y]=c.project(p[0],p[1]);return inside(x,y,polygon);})).map(c=>c.stroke.id));
      const root=scope();
      root?.dispatchEvent(new CustomEvent("leafmark-ink-focus",{detail:svg}));
      render();
    } else if(g.dx || g.dy || g.scale!==1) void edit("transform",g.dx,g.dy,g.scale);
  };
  const cancel=()=>{graphics.removeAttribute("transform");reset();};
  const root=scope();
  const focus=(e:Event)=>{if((e as CustomEvent).detail!==svg)cancel();};
  const action=(e:Event)=>{const operation=(e as CustomEvent).detail;if(operation==="delete"||operation==="color")void edit(operation);};
  root?.addEventListener("leafmark-ink-focus",focus);root?.addEventListener("leafmark-ink-action",action);
  svg.addEventListener("pointerdown",down,true);svg.addEventListener("pointermove",move,true);svg.addEventListener("pointerup",up,true);svg.addEventListener("pointercancel",cancel);
  return { refresh:()=>{if(!gesture)render();},destroy:()=>{
    reset();svg.removeEventListener("pointerdown",down,true);svg.removeEventListener("pointermove",move,true);svg.removeEventListener("pointerup",up,true);svg.removeEventListener("pointercancel",cancel);
    root?.removeEventListener("leafmark-ink-focus",focus);root?.removeEventListener("leafmark-ink-action",action);
  }};
}
