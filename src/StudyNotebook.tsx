import { type ReactNode, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, list, save } from "./db";
import { now, uid } from "./model";
import { emptyDocument } from "./richText";
import { flushTopicNote, saveNotebookNote } from "./notebookStore";
import { TopicEditor, type StudyClip, type StudyInsert } from "./TopicEditor";

export function StudyNotebook({ bookId, sizeControl, clip, inserted, selectedNote, crop, region }: {
  bookId: string;
  sizeControl: ReactNode;
  clip?: StudyClip;
  inserted: () => void;
  selectedNote: React.RefObject<string>;
  crop: () => void;
  region: boolean;
}) {
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
    try { await insert.current(atCaret ? {...clip,point:undefined} : clip); inserted(); }
    catch(e) { setError(String(e)); } finally { setBusy(false); }
  }
  const attempted = useRef("");
  useEffect(() => {
    if (clip?.point && note && insert.current && attempted.current !== clip.source.id) {
      attempted.current = clip.source.id;
      void add();
    }
  }, [clip, note?.id]);
  return <section className="study-notebook">
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
    {clip && (!clip.point || !note || error) && <div className="study-pending"><q>{clip.text.slice(0,140)}</q><button disabled={!note || busy} onClick={()=>void add(true)}>Insert at caret</button></div>}
    {error && <p role="alert">{error}</p>}
    <details className="study-writing-tools"><summary>Tools</summary>{sizeControl}{note && <button disabled={busy} aria-pressed={region} onClick={crop}>Clip PDF region</button>}<div ref={setToolbar} /></details>
    {note && <TopicEditor key={note.id} note={note} headerHost={null} toolbarHost={toolbar} insertHandle={insert} />}
  </section>;
}
