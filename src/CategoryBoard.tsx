import { useEffect, useRef, useState } from "react";
import { get, db, save } from "./db";
import type { CardFiling } from "./model";

type Point = { x:number; y:number };
type Card = { id:string; text:string; title:string; subtitle:string };
const tile = { w:244, h:174 };
export function CategoryBoard({ category, cards, filings, open }: {category:string; cards:Card[]; filings:CardFiling[]; open:(id:string,button:HTMLElement)=>void}) {
  const frame=useRef<HTMLDivElement>(null);
  const [size,setSize]=useState({w:0,h:0});
  const [camera,setCamera]=useState({x:16,y:16,z:1});
  const [draft,setDraft]=useState<{id:string;pos:Point}>();
  const [error,setError]=useState("");
  const drag=useRef<{id?:string; origin:Point; start:Point; pointer:number; moved:boolean}>(undefined);
  const suppressClick=useRef(false);
  useEffect(()=>{ const observer=new ResizeObserver(([e])=>setSize({w:e.contentRect.width,h:e.contentRect.height}));observer.observe(frame.current!);return ()=>observer.disconnect(); },[]);
  const columns=Math.max(2,Math.ceil(Math.sqrt(filings.length)));
  const positions=new Map(filings.map((f,i)=>[f.cardId,{x:f.x ?? i%columns*(tile.w+20),y:f.y ?? Math.floor(i/columns)*(tile.h+20)}]));
  function persist(id:string,p:Point) {
    void db.transaction("rw",db.rows,db.outbox,db.meta,db.conflicts,async()=>{
      const filing=await get("card-filing",category+":"+id);
      if(filing) await save("card-filing",{...filing,x:Math.max(-1e6,Math.min(1e6,Math.round(p.x))),y:Math.max(-1e6,Math.min(1e6,Math.round(p.y)))});
    }).catch(e=>setError(e.message));
  }
  function fit(){
    if(!cards.length) return;
    const points=cards.map(c=>positions.get(c.id)!).filter(Boolean);
    if (!points.length) return;
    const x=Math.min(...points.map(p=>p.x)),y=Math.min(...points.map(p=>p.y));
    const z=Math.min(1,(size.w-32)/(Math.max(...points.map(p=>p.x))-x+tile.w),(size.h-32)/(Math.max(...points.map(p=>p.y))-y+tile.h));
    setCamera({x:16-x*z,y:16-y*z,z});
  }
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || !size.w || !size.h || !cards.length || !positions.has(cards[0].id)) return;
    fitted.current = true;
    fit();
  }, [size, cards, filings]);
  const zoom=(factor:number)=>setCamera(c=>{const z=Math.max(.05,Math.min(3,c.z*factor));return {z,x:size.w/2+(c.x-size.w/2)*z/c.z,y:size.h/2+(c.y-size.h/2)*z/c.z};});
  return <section aria-label="Category board"><div className="board-tools"><button onClick={()=>zoom(.8)} aria-label="Zoom out board">−</button><span>{Math.round(camera.z*100)}%</span><button onClick={()=>zoom(1.25)} aria-label="Zoom in board">+</button><button onClick={fit}>Fit cards</button></div>
    <div ref={frame} className="category-board" tabIndex={0} aria-label="Pan board, or focus a card and use arrow keys to move it"
      onPointerDown={e=>{ if(!e.isPrimary || e.button!==0)return; const id=(e.target as HTMLElement).closest<HTMLElement>("[data-card]")?.dataset.card; const origin=id?positions.get(id):camera;if(!origin)return;
        drag.current={id,origin,start:{x:e.clientX,y:e.clientY},pointer:e.pointerId,moved:false};suppressClick.current=false; }}
      onPointerMove={e=>{const d=drag.current;if(!d||d.pointer!==e.pointerId)return;const dx=e.clientX-d.start.x,dy=e.clientY-d.start.y;
        if(!d.moved && Math.hypot(dx,dy)<5)return;d.moved=true;e.currentTarget.setPointerCapture(e.pointerId);
        if(d.id)setDraft({id:d.id,pos:{x:d.origin.x+dx/camera.z,y:d.origin.y+dy/camera.z}});else setCamera(c=>({...c,x:d.origin.x+dx,y:d.origin.y+dy}));}}
      onPointerUp={e=>{const d=drag.current;if(!d||d.pointer!==e.pointerId)return;if(d.moved&&d.id)persist(d.id,{x:d.origin.x+(e.clientX-d.start.x)/camera.z,y:d.origin.y+(e.clientY-d.start.y)/camera.z});suppressClick.current=d.moved;drag.current=undefined;setDraft(undefined);}}
      onPointerCancel={()=>{drag.current=undefined;setDraft(undefined);}}
      onKeyDown={e=>{const delta:Record<string,Point>={ArrowLeft:{x:-16,y:0},ArrowRight:{x:16,y:0},ArrowUp:{x:0,y:-16},ArrowDown:{x:0,y:16}};const d=delta[e.key];if(!d)return;e.preventDefault();const id=(e.target as HTMLElement).dataset.card,p=id&&positions.get(id);if(id&&p)persist(id,{x:p.x+d.x,y:p.y+d.y});else setCamera(c=>({...c,x:c.x-d.x,y:c.y-d.y}));}}>
      {cards.map(c=>{const p=draft?.id===c.id?draft.pos:positions.get(c.id);if(!p)return null;const x=p.x*camera.z+camera.x,y=p.y*camera.z+camera.y;
        if(x>size.w+50||y>size.h+50||x+tile.w*camera.z< -50||y+tile.h*camera.z< -50)return null;
        return <button key={c.id} data-card={c.id} style={{width:tile.w,height:tile.h,transform:`translate(${x}px,${y}px) scale(${camera.z})`}} onClick={e=>{if(!suppressClick.current)open(c.id,e.currentTarget);}}><span>{c.text}</span><small>{c.title} · {c.subtitle}</small></button>;})}
    </div>{error&&<p role="alert">{error}</p>}</section>;
}