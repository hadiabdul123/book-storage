import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useSearchParams } from "react-router-dom";
import { NotebookPen, Plus, Search, Trash2, Download, Sparkles } from "lucide-react";
import { db, list, save } from "./db";
import { now, uid } from "./model";
import { emptyDocument, plainText } from "./richText";
import { TopicEditor } from "./TopicEditor";
import { ResearchPanel } from "./ResearchPanel";
import { documentSources } from "./sourceReferences";
import { SourceLink } from "./Citation";
import { Dialog } from "./components";
import { exportResearch, restoreResearchBackup } from "./researchBackup";
import { saveNotebookNote, flushTopicNote } from "./notebookStore";
import "./research.css";

export function Notebooks() {
  const notebooks = useLiveQuery(() => list("notebook"), []) || [];
  const notes = useLiveQuery(() => list("notebook-note"), []) || [];
  const [params, setParams] = useSearchParams();
  const noteId = params.get("note") || "";
  const activeNote = notes.find(n => n.id === noteId);
  const [notebookId, setNotebookId] = useState("");
  const currentId = activeNote?.notebookId || notebookId || notebooks[0]?.id || "";
  const current = notebooks.find(n => n.id === currentId);
  const [query, setQuery] = useState(""), [error, setError] = useState("");
  const [research, setResearch] = useState(false), [creating, setCreating] = useState(false), [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false), [versionsOpen, setVersionsOpen] = useState(false);
  const versions = useLiveQuery(() => db.meta.where("key").startsWith(`note-version:${noteId}:`).toArray(), [noteId]) || [];
  const links = activeNote ? documentSources(activeNote.document) : [];
  const run = (action: () => Promise<unknown>) => { setError(""); void action().catch(e => setError(e.message)); };
  const addNote = () => run(async () => {
    if (!current) { setCreating(true); return; }
    const note = { id: uid(), notebookId: current.id, title: "Untitled note", document: emptyDocument(), tags: [], createdAt: now(), updatedAt: now() };
    await save("notebook-note", note); setParams({ note: note.id });
  });
  const filtered = notes.filter(n => n.notebookId === currentId && `${n.title} ${plainText(n.document)} ${n.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return <div className="notebooks-page">
    <header className="page-header"><div><h1>Notebooks<span className="count">{notebooks.length}</span></h1><p className="muted">A place to connect what you read with what you think.</p></div><div className="button-row"><button className="secondary" onClick={() => { setTitle(""); setCreating(true); }}><Plus size={17} />New notebook</button><label className="export-select"><Download size={17} /><select aria-label="Export notebooks" value="" onChange={e => { if (e.target.value) run(() => exportResearch(e.target.value as "md" | "json")); }}><option value="">Export</option><option value="md">Markdown</option><option value="json">JSON backup</option></select></label><label className="text-button notebook-import">Restore backup<input type="file" accept="application/json,.json" aria-label="Restore research backup" onChange={e => { const file = e.target.files?.[0]; if (file) run(async () => { const result = await restoreResearchBackup(JSON.parse(await file.text())); setError(`Restored ${result.restored} records; kept ${result.skipped} existing records.`); }); e.target.value = ""; }} /></label></div></header>
    {error && <p className="notice" role="status">{error}</p>}
    <div className={`notebook-layout ${research ? "with-research" : ""}`}>
      <aside className="notebook-list" aria-label="Notebooks and notes">
        <label>Notebook<select aria-label="Choose notebook" value={currentId} onChange={e => { setNotebookId(e.target.value); setParams({}); }}><option value="" disabled>Choose a notebook</option>{notebooks.map(n => <option key={n.id} value={n.id}>{n.title}</option>)}</select></label>
        <label className="search-field"><Search size={17} /><input aria-label="Search notebook" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search notes or tags" /></label>
        <button className="text-button" onClick={addNote}><Plus size={16} />New note</button>
        <nav>{filtered.map(n => <button className={n.id === noteId ? "active" : ""} key={n.id} onClick={() => setParams({ note: n.id })}><strong>{n.title}</strong><span>{plainText(n.document).slice(0, 90) || "Start writing…"}</span>{n.tags.length > 0 && <small>{n.tags.join(", ")}</small>}</button>)}</nav>
        {current && <button className="text-button danger notebook-trash" onClick={() => run(async () => {
          if (!confirm(`Move “${current.title}” and its notes to trash?`)) return;
          if (activeNote && !(await flushTopicNote(activeNote.id))) throw new Error("Save your writing before moving this notebook to trash.");
          await save("notebook", current, true); for (const n of notes.filter(n => n.notebookId === current.id)) await save("notebook-note", n, true);
          setNotebookId(""); setParams({});
        })}>Trash notebook</button>}
      </aside>
      <main className="notebook-detail">
        <div className="notebook-detail-actions"><span>{current?.title || "Your ideas, together"}</span><button className="text-button" aria-pressed={research} onClick={() => setResearch(!research)}><Sparkles size={17} />Research</button></div>
        {activeNote ? <><TopicEditor key={activeNote.id} note={activeNote} /><div className="notebook-note-actions"><button className="text-button" disabled={!versions.length} onClick={() => setVersionsOpen(true)}>Recover other versions ({versions.length})</button><button className="text-button danger" onClick={() => run(async () => { if (!confirm("Move this note to trash?")) return; if (!(await flushTopicNote(activeNote.id))) throw new Error("Save your writing before moving this note to trash."); const latest = await db.rows.get(`notebook-note:${activeNote.id}`); await save("notebook-note", (latest?.value || activeNote) as typeof activeNote, true); setParams({}); })}><Trash2 size={15} />Trash note</button></div>
          {links.length > 0 && <details className="note-backlinks"><summary>Connected sources ({links.length})</summary>{links.map((s, i) => <SourceLink key={i} source={s} />)}</details>}
        </> : <div className="notebook-welcome"><NotebookPen size={34} /><h2>{current ? "Make room for an idea" : "Your first topic notebook"}</h2><p>Write freely, collect passages from different books, and keep useful research with its sources.</p><button className="primary" onClick={addNote}>{current ? "Create a note" : "Create a notebook"}</button></div>}
      </main>
      {research && <aside className="notebook-research"><header><h2>Research</h2><button className="text-button" onClick={() => setResearch(false)}>Close</button></header><ResearchPanel key={currentId} notebookId={currentId || undefined} defaultNoteId={activeNote?.id} /></aside>}
    </div>
    {creating && <Dialog title="New notebook" onClose={() => setCreating(false)}><form className="clip-form" onSubmit={async e => {
      e.preventDefault(); setBusy(true);
      try { const n = { id: uid(), title: title.trim(), createdAt: now() }; await save("notebook", n); setNotebookId(n.id); setParams({}); setCreating(false); }
      catch (e) { setError(String(e)); } finally { setBusy(false); }
    }}><label>Notebook name<input autoFocus required maxLength={150} value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Science and the universe" /></label><button className="primary" disabled={busy || !title.trim()}>Create notebook</button></form></Dialog>}
    {versionsOpen && activeNote && <Dialog title="Recover another version" onClose={() => setVersionsOpen(false)}><p>Your current note is kept. Recover a version as a separate note.</p>{versions.map(v => {
      let old: typeof activeNote; try { old = JSON.parse(v.value).value; } catch { return null; }
      if (!old?.document) return null;
      return <article className="research-pending" key={v.key}><h3>{old.title}</h3><p>{plainText(old.document).slice(0, 300)}</p><button className="secondary" onClick={() => run(async () => { const recovered = await saveNotebookNote({ ...old, id: uid(), notebookId: activeNote.notebookId, title: `${old.title} (recovered)`.slice(0, 200), createdAt: now(), updatedAt: now() }); setParams({ note: recovered.id }); setVersionsOpen(false); })}>Recover as a new note</button></article>;
    })}</Dialog>}
  </div>;
}
