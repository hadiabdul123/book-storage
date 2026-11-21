import { useEffect, useRef, useState, type RefObject } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";

export type PrintFace = "original" | "serif" | "sans";
const surrounds = { "Warm gray":"#c7c2b9", "Muted taupe":"#ad9f90", Charcoal:"#373a3d" };
const defaults = { paperEdge:"straight", surround:"", clearPrint:false, printFace:"original" as PrintFace,
  textFace:"serif" as PrintFace, textSize:20, textSpacing:1.65, brightness: 100, warmth: 0, texture: "plain", strength: 14, edge: false };
type Comfort = typeof defaults;
const storageKey = "leafmark-reader-comfort-v1";
function load(): Comfort {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(storageKey) || "{}") }; }
  catch { return defaults; }
}
export function useReaderComfort() {
  const [value, setValue] = useState(load);
  const [original, setOriginal] = useState(false);
  const current = useRef(value);
  const update = (patch: Partial<Comfort>) => {
    setOriginal(false);
    current.current = { ...current.current, ...patch };
    setValue(current.current);
  };
  const save = () => { try { localStorage.setItem(storageKey, JSON.stringify(current.current)); } catch { /* Private browsing */ } };
  useEffect(() => {
    const timer = setTimeout(save, 150);
    return () => clearTimeout(timer);
  }, [value]);
  useEffect(() => {
    window.addEventListener("pagehide", save);
    return () => { window.removeEventListener("pagehide", save); save(); };
  }, []);
  return { value, update, original, setOriginal };
}
type Controls = ReturnType<typeof useReaderComfort>;
export function ComfortSettings({ value, update, original, setOriginal, openText, textAvailable }: Controls & {openText:()=>void; textAvailable:boolean}) {
  const [error, setError] = useState("");
  const texture = useLiveQuery(() => db.meta.get("reader-custom-paper"), []);
  async function importTexture(file?: File) {
    if (!file) return;
    try {
      if (!["image/jpeg","image/png","image/webp"].includes(file.type) || file.size > 10*1024*1024) throw new Error("Choose a PNG, JPG, or WebP image under 10 MB.");
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 768 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1,Math.round(bitmap.width*scale)); canvas.height = Math.max(1,Math.round(bitmap.height*scale));
      try { canvas.getContext("2d")!.drawImage(bitmap,0,0,canvas.width,canvas.height); } finally { bitmap.close(); }
      await db.meta.put({ key: "reader-custom-paper", value: canvas.toDataURL("image/webp",0.8) });
      update({ texture:"custom" }); setError("");
    } catch(e) { setError(e instanceof Error ? e.message : "Could not load this image."); }
  }
  return <fieldset className="comfort-settings"><legend>Paper &amp; print</legend>
    <div className="paper-comparison" role="group" aria-label="Compare PDF appearance">
      <button type="button" aria-label="Preview original PDF" aria-pressed={original} onClick={() => setOriginal(true)}>Original</button>
      <button type="button" aria-pressed={!original} onClick={() => setOriginal(false)}>Preview</button>
      <button type="button" onClick={() => update({texture:"ripples",strength:35,surround:surrounds["Warm gray"],clearPrint:true})}>Paper preset</button>
    </div>
    <label>Paper edges<select value={value.paperEdge} onChange={e=>update({paperEdge:e.target.value})}>
      <option value="straight">Straight</option><option value="torn">Soft torn edge</option><option value="fold">Folded corner</option>
    </select></label>
    <label>Behind the pages<select value={!value.surround || Object.values(surrounds).includes(value.surround) ? value.surround : "custom"}
      onChange={e=>update({surround:e.target.value === "custom" ? "#a2aaa5" : e.target.value})}>
      <option value="">Use reader theme</option>{Object.entries(surrounds).map(([name,hex])=><option key={hex} value={hex}>{name}</option>)}<option value="custom">Custom color</option>
    </select></label>
    <label>Custom background color <input type="color" value={value.surround || surrounds["Warm gray"]} onChange={e=>update({surround:e.target.value})}/></label>
    <label><input type="checkbox" checked={value.clearPrint} onChange={e=>update({clearPrint:e.target.checked})}/> Clear print</label>
    <label>PDF typeface<select value={value.printFace} onChange={e=>update({printFace:e.target.value as PrintFace})}>
      <option value="original">Original</option><option value="serif">Book serif</option><option value="sans">Sans serif</option>
    </select></label>
    {value.printFace !== "original" && <small>Applies to matching body text. Scans and complex layouts keep their printed type.</small>}
    <button type="button" className="secondary" disabled={!textAvailable} onClick={openText}>Open text view</button>
    <label>Paper texture <select value={value.texture} onChange={e => update({ texture:e.target.value })}><option value="plain">Plain</option><option value="ripples">Soft paper ripples</option><option value="grain">Paper grain</option><option value="linen">Linen</option>{texture && <option value="custom">My texture</option>}</select></label>
    {(["brightness","warmth","strength"] as const).filter(k => k !== "strength" || value.texture !== "plain").map(k => <label key={k}>
      {k === "brightness" ? "Page brightness" : k === "warmth" ? "Warmth" : "Texture intensity"} <output>{value[k]}%</output>
      <input type="range" aria-label={k === "brightness" ? "Page brightness" : k === "warmth" ? "Warmth" : "Texture intensity"} min={k === "brightness" ? 25 : 0} max="100" value={value[k]} onChange={e => update({ [k]:+e.target.value })} /></label>)}
    <label>Import a texture <input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => void importTexture(e.target.files?.[0])} /></label>
    <label><input type="checkbox" checked={value.edge} onChange={e => update({ edge:e.target.checked })} /> Slide along the right edge to adjust PDF brightness</label>
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}
export function ComfortLayer({ value, update, original, host, enabled }: Controls & { host: RefObject<HTMLDivElement | null>; enabled:boolean }) {
  const custom = useLiveQuery(() => value.texture === "custom" ? db.meta.get("reader-custom-paper") : undefined,[value.texture]);
  const latest = useRef({value,update}); latest.current = {value,update};
  useEffect(() => {
    const el=host.current;
    if (!el || !enabled || !value.edge) return;
    let drag: { x:number; y:number; initial:number; time:number; active:boolean } | undefined;
    const start=(event: TouchEvent) => {
      const t=event.touches[0], bounds=el.getBoundingClientRect();
      if(event.touches.length!==1 || bounds.right-t.clientX>24 || (event.target as Element).closest("button,.pdf-text-box-edit,.pdf-selection-handle") || document.getSelection()?.toString()) { drag=undefined; return; }
      drag={x:t.clientX,y:t.clientY,initial:latest.current.value.brightness,time:Date.now(),active:false};
    };
    const move=(event: TouchEvent) => {
      if (!drag || event.touches.length!==1) { drag=undefined; return; }
      const t=event.touches[0], dx=t.clientX-drag.x, dy=t.clientY-drag.y;
      if(!drag.active && (Date.now()-drag.time>350 || Math.abs(dx)>Math.max(9,Math.abs(dy)) || el.closest(".reader-shell")?.querySelector(".passage-popup,.pdf-selection-handle"))) {drag=undefined;return;}
      if(!drag.active && Math.abs(dy)<12) return;
      if(!event.cancelable) {drag=undefined;return;}
      event.preventDefault(); drag.active=true;
      latest.current.update({ brightness:Math.round(Math.max(25, Math.min(100,drag.initial-dy*100/Math.max(180,el.clientHeight*.7)))) });
    };
    const end=()=>{drag=undefined;};
    el.addEventListener("touchstart",start,{capture:true,passive:true}); el.addEventListener("touchmove",move,{capture:true,passive:false});
    el.addEventListener("touchend",end);el.addEventListener("touchcancel",end);
    return ()=>{el.removeEventListener("touchstart",start,true);el.removeEventListener("touchmove",move,true);el.removeEventListener("touchend",end);el.removeEventListener("touchcancel",end);};
  },[host,enabled,value.edge]);
  useEffect(() => {
    const shell = host.current?.closest<HTMLElement>(".reader-shell");
    if (!shell) return;
    const css = shell.style;
    css.setProperty("--pdf-grain-opacity",String(original ? 0 : value.strength/230));
    css.setProperty("--pdf-paper-dim",String(original ? 0 : 1-value.brightness/100));
    css.setProperty("--pdf-paper-warm",String(original ? 0 : value.warmth/375));
    if (custom && !original) css.setProperty("--pdf-custom-grain","url("+custom.value+")");
    else css.removeProperty("--pdf-custom-grain");
    return () => { for (const key of ["--pdf-grain-opacity","--pdf-paper-dim","--pdf-paper-warm","--pdf-custom-grain"]) css.removeProperty(key); };
  },[host,original,custom,value.strength,value.warmth,value.brightness]);
  return null;
}
