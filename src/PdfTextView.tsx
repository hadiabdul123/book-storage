import { useEffect, useRef, useState } from "react";
import { Dialog } from "./components";
import type { PdfReader } from "./reader/pdf";
import type { PrintFace } from "./ReaderComfort";

type Props = {
  reader: PdfReader; start: number; count:number; title:string; face:PrintFace; size:number; spacing:number;
  update:(patch:{textFace?:PrintFace;textSize?:number;textSpacing?:number})=>void;
  close:(page:number)=>void;
};
export function PdfTextView({reader,start,count,title,face,size,spacing,update,close}: Props) {
  const [page,setPage]=useState(start), [request,setRequest]=useState(0);
  const [text,setText]=useState<string|null>(), [error,setError]=useState("");
  const paper=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    let active=true; setText(undefined); setError("");
    if (paper.current) paper.current.scrollTop=0;
    void reader.readablePage(page,request>0).then(value=>{ if(active) setText(value); })
      .catch(e=>{ if(active) setError(e instanceof Error ? e.message : "Could not open this page."); });
    return ()=>{active=false;};
  },[reader,page,request]);
  function move(next:number) { setText(undefined); setRequest(0); setPage(next); }
  return <Dialog title="Text view" wide onClose={()=>close(page)}>
    <section className="pdf-text-view" onKeyDown={e=>e.stopPropagation()}>
      <div className="pdf-text-nav"><button disabled={page<=1} onClick={()=>move(page-1)}>Previous</button>
        <span aria-live="polite">Page {page} of {count}</span><button disabled={page>=count} onClick={()=>move(page+1)}>Next</button>
        <button onClick={()=>close(page)}>Back to PDF</button></div>
      <details><summary>Text appearance</summary><div className="pdf-text-nav">
        <label>Typeface<select value={face} onChange={e=>update({textFace:e.target.value as PrintFace})}><option value="serif">Book serif</option><option value="sans">Sans serif</option></select></label>
        <label>Text size<input aria-label="Text view size" type="range" min="14" max="36" value={size} onChange={e=>update({textSize:+e.target.value})}/>{size} px</label>
        <label>Line spacing<select value={spacing} onChange={e=>update({textSpacing:+e.target.value})}><option value="1.4">Compact</option><option value="1.65">Standard</option><option value="1.9">Roomy</option></select></label>
      </div></details>
      <div ref={paper} className="pdf-text-scroll" tabIndex={0} aria-label={title + ", page " + page}>
        {error ? <p role="alert">{error} <button onClick={()=>setRequest(n=>n+1)}>Retry page</button></p>
          : text === undefined ? <p role="status">{request ? "Recognizing this page…" : "Opening page…"}</p>
          : text === null ? <button className="secondary" onClick={()=>setRequest(n=>n+1)}>Recognize this page</button>
          : text ? <article style={{fontFamily:face==="sans"?"Arial, sans-serif":"Georgia, serif",fontSize:size,lineHeight:spacing}}>{text.split(/\n\s*\n/).map((part,i)=><p key={i}>{part}</p>)}</article> : <p>No readable text on this page.</p>}
      </div>
    </section>
  </Dialog>;
}
