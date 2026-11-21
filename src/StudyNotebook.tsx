import { type ReactNode, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Ellipsis } from "lucide-react";
import { db, list, save } from "./db";
import { now, uid } from "./model";
import { emptyDocument } from "./richText";
import { flushTopicNote, saveNotebookNote } from "./notebookStore";
import { TopicEditor, type StudyClip, type StudyInsert } from "./TopicEditor";

export function StudyNotebook({ bookId, sizeControl, clip, finishClip, selectedNote, crop, region }: {
  bookId: string;
  sizeControl: ReactNode;
  clip?: StudyClip;
  finishClip: (id: string, saved: boolean) => void;
  selectedNote: React.RefObject<string>;
  crop: () => void;
  region: boolean;
}) {
  const dot = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = dot.current;
    if (!node) return;
    let frame = 0;
    let latest: {x:number;y:number} | null = null;
    const move = (point: typeof latest) => {
      latest = point;
      if (!point) { cancelAnimationFrame(frame); frame = 0; node.hidden = true; return; }
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        if (!latest) return;
        node.style.transform = "translate3d(" + (latest.x+11) + "px," + (latest.y-17) + "px,0)";
        node.hidden = false;
      });
    };
    const clear = () => move(null);
    const pointer = (event: Event) => move((event as CustomEvent).detail);
    const native = (event: DragEvent) => {
      const target = event.target as Element;
      const paper = target.closest(".panel-body")?.querySelector(".notebook-paper");
      if (paper && !target.closest("button,input,select,summary,.note-tool-rail") && event.dataTransfer?.types.some(
        type => ["Files","text/plain","text/html","text/uri-list","application/x-leafmark-attachment","application/x-leafmark-pdf-passage"].includes(type)))
        move({x:event.clientX,y:event.clientY});
      else clear();
    };
    const leave = (e: DragEvent) => { if (!e.relatedTarget) clear(); };
    const abort = new AbortController(), options = {capture:true,signal:abort.signal};
    document.addEventListener("leafmark-study-drag-point",pointer,options);
    document.addEventListener("dragover",native,options);
    document.addEventListener("dragleave",leave,options);
    for (const type of ["drop","dragend","pointercancel"]) document.addEventListener(type,clear,options);
    window.addEventListener("blur",clear,options);
    return () => { abort.abort(); clear(); };
  }, []);
  const notebooks = useLiveQuery(() => list("notebook"), []);
  const notes = useLiveQuery(() => list("notebook-note"), []);
  const sections = useLiveQuery(() => list("notebook-section"), []);
  const preferenceKey = "study-note:" + bookId;
  const [switching,setSwitching] = useState(false);
  const [chosen, setChosen] = useState(() => { try { return localStorage.getItem(preferenceKey) || ""; } catch { return ""; } });
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false), [error,setError] = useState("");
  const insert = useRef<StudyInsert | null>(null);
  const newNoteMenu = useRef<HTMLDetailsElement>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
  const note = notes?.find(n => n.id === chosen);
  useEffect(() => { selectedNote.current = note?.id || ""; return () => { selectedNote.current = ""; }; }, [selectedNote, note?.id]);
  function choose(id: string) {
    setChosen(id); setSwitching(false);
    try { localStorage.setItem(preferenceKey,id); } catch { /* Private browsing */ }
  }
  async function change(id: string) {
    if (!busy && (!note || await flushTopicNote(note.id))) choose(id);
  }
  async function createNote() {
    if (busy || (note && !(await flushTopicNote(note.id)))) return;
    setBusy(true); setError("");
    try {
      const id = uid(), notebookId = destination || notebooks?.[0]?.id || uid();
      await db.transaction("rw", db.rows, db.outbox, db.conflicts, db.meta, async () => {
        if (!notebooks?.some(n => n.id === notebookId))
          await save("notebook", { id: notebookId, title: "Study notes", createdAt: now() });
        await saveNotebookNote({ id, notebookId, title:"Untitled note", document:emptyDocument(), tags:[], createdAt:now(), updatedAt:now() });
      });
      choose(id);
      if (newNoteMenu.current) newNoteMenu.current.open = false;
    } catch(e) { setError(String(e)); } finally { setBusy(false); }
  }
  async function add(atCaret = false) {
    if (!clip || busy) return;
    if (!insert.current) { setError("The note is opening. Try inserting again in a moment."); return; }
    setBusy(true); setError("");
    try { await insert.current(atCaret ? {...clip,point:undefined} : clip); finishClip(clip.source.id, true); }
    catch(e) { setError(String(e)); } finally { setBusy(false); }
  }
  const attempted = useRef("");
  useEffect(() => {
    if (!busy && clip?.point && note && editorReady && insert.current && attempted.current !== clip.source.id) {
      attempted.current = clip.source.id;
      void add();
    }
  }, [clip, note?.id, editorReady, busy]);
  return <section className="study-notebook">
    <span ref={dot} className="study-drag-dot" hidden aria-hidden="true" />
    {note && <button className="study-path" aria-expanded={switching} aria-label="Switch notebook page" onClick={() => setSwitching(!switching)}>{notebooks?.find(n => n.id === note.notebookId)?.title} / {sections?.find(s => s.id === note.sectionId)?.title || "Notes"} ▾</button>}
    {(!note || switching) && <div className="study-destinations"><label>Write in<select value={note?.id || ""} disabled={busy} onChange={e => void change(e.target.value)}>
      <option value="">Choose a page</option>{notebooks?.map(book => <optgroup key={book.id} label={book.title}>
        {notes?.filter(n => n.notebookId === book.id).map(n => <option key={n.id} value={n.id}>{n.title}</option>)}</optgroup>)}
    </select></label>
    <details ref={newNoteMenu}><summary>Create a page</summary><label>Notebook<select value={destination || notebooks?.[0]?.id || ""} onChange={e=>setDestination(e.target.value)}>
      {!notebooks?.length && <option value="">Study notes</option>}
      {notebooks?.map(b=><option key={b.id} value={b.id}>{b.title}</option>)}</select></label>
      <button disabled={busy || !notebooks} onClick={()=>void createNote()}>Create note</button></details>
    </div>}
    {clip && (!clip.point || !note || !editorReady || error) && <div className="study-pending"><q>{clip.text.slice(0,140)}</q><button disabled={!note || busy} onClick={()=>void add(true)}>{error ? "Retry insertion" : "Insert at caret"}</button><button disabled={busy} onClick={() => { setError(""); finishClip(clip.source.id,false); }}>Dismiss</button></div>}
    {error && <p role="alert">{error}</p>}
    <details className="study-writing-tools"><summary aria-label="Page options" title="Page options"><Ellipsis size={19}/></summary>{sizeControl}</details>
    {note && <div className="note-editor-body">
      <div className="note-rail-host" ref={setToolbar} />
      <TopicEditor key={note.id} note={note} toolbarHost={toolbar} insertHandle={insert} onReady={setEditorReady}
        clipRegion={<button disabled={busy} aria-pressed={region} onClick={crop}>Select book image</button>} />
    </div>}
  </section>;
}
