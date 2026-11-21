import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Ellipsis } from "lucide-react";
import { droppedMedia } from "./notebookExternalMedia";
import { lookupMeaningImages, type MeaningImage } from "./meaningImages";
import type { SourceRef } from "./researchTypes";
import "./meaningGallery.css";

export type ImageAction = (file: File, image: MeaningImage, destination: "study" | "notebook", passage?: SourceRef) => Promise<void>;

export function MeaningGallery({ topic, onImage }: { topic: string; onImage?: ImageAction }) {
  const [items, setItems] = useState<MeaningImage[]>([]);
  const [index, setIndex] = useState(0), [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const alive = useRef(false), copying = useRef(false);
  const touch = useRef<{x:number; y:number; timer:number} | undefined>(undefined);
  function clearTouch() { window.clearTimeout(touch.current?.timer); touch.current = undefined; }
  useEffect(() => {
    alive.current = true;
    const abort = new AbortController(), timer = window.setTimeout(() => abort.abort(), 7000);
    void lookupMeaningImages(topic, abort.signal).then(rows => { if (!abort.signal.aborted) setItems(rows); }).catch(() => {}).finally(() => clearTimeout(timer));
    return () => { alive.current = false; abort.abort(); clearTimeout(timer); clearTouch(); };
  }, [topic]);
  const current = Math.min(index, items.length - 1), image = items[current];
  if (!image) return null;
  function move(to: number) { setIndex(Math.max(0, Math.min(items.length - 1, to))); setMenu(false); setError(""); }
  async function save(destination: "study" | "notebook") {
    if (!onImage || copying.current) return;
    copying.current = true; setBusy(true); setError("");
    try {
      const file = await droppedMedia(image.thumb);
      if (alive.current) await onImage(file, image, destination);
    } catch { if (alive.current) setError("Could not copy this image. Try again."); }
    finally { copying.current = false; if (alive.current) setBusy(false); }
  }
  return <figure className="meaning-gallery" aria-label="Concept images" onKeyDown={e => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.stopPropagation(); e.preventDefault(); if (!busy) move(current + (e.key === "ArrowRight" ? 1 : -1)); }
    if (e.key === "Escape" && menu) { e.stopPropagation(); setMenu(false); }
  }}>
    <div className="meaning-picture" tabIndex={0} aria-label={image.title} onContextMenu={e => { if (onImage) { e.preventDefault(); setMenu(true); } }}
      onPointerDown={e => { if (busy || !e.isPrimary || e.button !== 0) return; clearTouch(); e.currentTarget.setPointerCapture(e.pointerId);
        touch.current = {x:e.clientX,y:e.clientY,timer:window.setTimeout(() => { if (onImage) setMenu(true); },480)}; }}
      onPointerMove={e => { const p = touch.current; if (p && Math.hypot(e.clientX-p.x,e.clientY-p.y)>8) clearTimeout(p.timer); }}
      onPointerCancel={clearTouch} onLostPointerCapture={clearTouch} onPointerUp={e => {
        const p = touch.current; clearTouch(); if (!p) return;
        const dx = e.clientX-p.x; if (Math.abs(dx)>35 && Math.abs(dx)>Math.abs(e.clientY-p.y)) move(current + (dx<0 ? 1 : -1));
      }}>
      <img src={image.thumb} alt={image.title} draggable={false} referrerPolicy="no-referrer" onError={() => setItems(rows => rows.filter(row => row !== image))}/>
    </div>
    <div className="meaning-photo-controls"><figcaption><a href={image.page} target="_blank" rel="noreferrer">{image.title}</a><small>{image.credit}</small></figcaption>
      {items.length>1 && <><button aria-label="Previous image" disabled={busy || !current} onClick={() => move(current-1)}><ChevronLeft size={15}/></button><small>{current+1}/{items.length}</small><button aria-label="Next image" disabled={busy || current===items.length-1} onClick={() => move(current+1)}><ChevronRight size={15}/></button></>}
      {onImage && <button aria-label="Image options" aria-expanded={menu} onClick={() => setMenu(!menu)}><Ellipsis size={16}/></button>}
    </div>
    {menu && <div className="meaning-image-actions"><button disabled={busy} onClick={() => void save("study")}>Copy to Study notebook</button><button disabled={busy} onClick={() => void save("notebook")}>Add to notebook…</button></div>}
    {busy && <small role="status">Copying image…</small>}{error && <small role="alert">{error}</small>}
  </figure>;
}
