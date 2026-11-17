import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useSearchParams } from "react-router-dom";
import { NotebookPen, Plus, Search, Trash2, Download, Sparkles, PanelLeft, Maximize2, ArrowUp, ArrowDown, Pencil } from "lucide-react";
import { db, list, save } from "./db";
import { now, uid } from "./model";
import { emptyDocument, plainText } from "./richText";
import { TopicEditor } from "./TopicEditor";
import { ResearchPanel } from "./ResearchPanel";
import { documentSources } from "./sourceReferences";
import { SourceLink } from "./Citation";
import { Dialog } from "./components";
import { exportResearch, restoreResearchBackup } from "./researchBackup";
import { recoverNotebookNote, flushTopicNote } from "./notebookStore";
import { defaultSectionId, noteSection, noteOrder, ensureNotebookSection, deleteNotebookSection } from "./notebookSections";
import "./research.css";
import "./notebookWorkspace.css";

export function Notebooks() {
  const notebooks = useLiveQuery(() => list("notebook"), []) || [];
  const notes = useLiveQuery(() => list("notebook-note"), []) || [];
  const sections = useLiveQuery(() => list("notebook-section"), []) || [];
  const [params, setParams] = useSearchParams();
  const noteId = params.get("note") || "";
  const activeNote = notes.find(n => n.id === noteId);
  const [notebookId, setNotebookId] = useState("");
  const currentId = activeNote?.notebookId || notebookId || notebooks[0]?.id || "";
  const current = notebooks.find(n => n.id === currentId);
  const [sectionId, setSectionId] = useState("");
  const [navigator, setNavigator] = useState(false), [focus, setFocus] = useState(false);
  const currentSections = sections.filter(s => s.notebookId === currentId).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const currentSection = activeNote ? noteSection(activeNote) : currentSections.some(s => s.id === sectionId) ? sectionId : defaultSectionId(currentId);
  const [query, setQuery] = useState(""), [error, setError] = useState("");
  const [research, setResearch] = useState(false), [creating, setCreating] = useState(false), [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false), [versionsOpen, setVersionsOpen] = useState(false);
  const versions = useLiveQuery(() => db.meta.where("key").startsWith(`note-version:${noteId}:`).toArray(), [noteId]) || [];
  const links = activeNote ? documentSources(activeNote.document) : [];
  const run = (action: () => Promise<unknown>) => { setError(""); void action().catch(e => setError(e.message)); };
  useEffect(() => { if (currentId) run(() => ensureNotebookSection(currentId)); }, [currentId]);
  async function flushActive() { if (activeNote && !(await flushTopicNote(activeNote.id))) throw new Error("Save your writing before changing this page."); }
  const selectNote = (id: string) => run(async () => { await flushActive(); setParams({ note: id }); setNavigator(false); });
  const swapSection = (delta: number) => run(async () => {
    const index = currentSections.findIndex(s => s.id === currentSection), other = currentSections[index + delta];
    if (!other || index < 0) return;
    await db.transaction("rw", db.rows, db.outbox, db.conflicts, db.meta, async () => {
      for (let i = 0; i < currentSections.length; i++) { const s = currentSections[i]; await save("notebook-section", { ...s, order: i === index ? index + delta : i === index + delta ? index : i }); }
    });
  });
  const movePage = (delta: number) => run(async () => {
    if (!activeNote) return; await flushActive();
    const pages = notes.filter(n => noteSection(n) === currentSection).sort((a, b) => noteOrder(a) - noteOrder(b) || a.id.localeCompare(b.id));
    const index = pages.findIndex(n => n.id === noteId); if (!pages[index + delta]) return;
    [pages[index], pages[index + delta]] = [pages[index + delta], pages[index]];
    await db.transaction("rw", db.rows, db.outbox, db.conflicts, db.meta, async () => { for (let i = 0; i < pages.length; i++) { const latest = await db.rows.get(`notebook-note:${pages[i].id}`); await save("notebook-note", { ...(latest?.value as typeof activeNote || pages[i]), order: i * 1024 }); } });
    window.dispatchEvent(new CustomEvent("leafmark-clipped", { detail: { id: noteId } }));
  });
  const addNote = () => run(async () => {
    if (!current) { setCreating(true); return; }
    await flushActive(); await ensureNotebookSection(current.id);
    const note = { id: uid(), notebookId: current.id, sectionId: currentSection, order: Math.max(0, ...notes.filter(n => noteSection(n) === currentSection).map(noteOrder)) + 1024, title: "Untitled note", document: emptyDocument(), tags: [], createdAt: now(), updatedAt: now() };
    await save("notebook-note", note); setParams({ note: note.id }); setNavigator(false);
  });
  const filtered = notes.filter(n => n.notebookId === currentId && (query || noteSection(n) === currentSection) && `${n.title} ${plainText(n.document)} ${n.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => noteOrder(a) - noteOrder(b) || a.id.localeCompare(b.id));
  return <div className={`notebooks-page workspace-notebooks ${navigator ? "navigator-open" : ""} ${focus ? "notebook-focus" : ""} ${activeNote ? "has-open-page" : ""}`}>
    <header className="page-header"><div><h1>Notebooks<span className="count">{notebooks.length}</span></h1><p className="muted">A place to connect what you read with what you think.</p></div><div className="button-row"><button className="secondary" onClick={() => { setTitle(""); setCreating(true); }}><Plus size={17} />New notebook</button><label className="export-select"><Download size={17} /><select aria-label="Export notebooks" value="" onChange={e => { if (e.target.value) run(() => exportResearch(e.target.value as "md" | "json")); }}><option value="">Export</option><option value="md">Markdown</option><option value="json">JSON backup</option></select></label><label className="text-button notebook-import">Restore backup<input type="file" accept="application/json,.json" aria-label="Restore research backup" onChange={e => { const file = e.target.files?.[0]; if (file) run(async () => { const result = await restoreResearchBackup(JSON.parse(await file.text())); setError(`Restored ${result.restored} records; kept ${result.skipped} existing records.`); }); e.target.value = ""; }} /></label></div></header>
    {error && <p className="notice" role="status">{error}</p>}
    <div className={`notebook-layout ${research ? "with-research" : ""}`}>
      <aside className="notebook-list" aria-label="Notebooks and notes">
        <label>Notebook<select aria-label="Choose notebook" value={currentId} onChange={e => { const next = e.target.value; run(async () => { await flushActive(); setNotebookId(next); setSectionId(""); setParams({}); }); }}><option value="" disabled>Choose a notebook</option>{notebooks.map(n => <option key={n.id} value={n.id}>{n.title}</option>)}</select></label>
        {current && <div className="notebook-management"><button className="text-button" aria-label="Rename notebook" onClick={() => { const title = prompt("Notebook name", current.title); if (title?.trim()) run(() => save("notebook", { ...current, title: title.trim().slice(0, 200) })); }}><Pencil size={15} />Rename</button></div>}
        <h2 className="navigator-heading">Sections</h2>
        <nav className="notebook-sections" aria-label="Notebook sections">{currentSections.map(s => <button key={s.id} className={s.id === currentSection ? "active" : ""} aria-current={s.id === currentSection ? "page" : undefined} onClick={() => run(async () => { await flushActive(); setSectionId(s.id); setParams({}); })}><span className="section-tab" /><strong>{s.title}</strong><small>{notes.filter(n => noteSection(n) === s.id).length}</small></button>)}</nav>
        <button className="text-button" disabled={!current} onClick={() => { const title = prompt("Section name"); if (title?.trim() && current) run(async () => { await flushActive(); const section = { id: uid(), notebookId: current.id, title: title.trim().slice(0, 200), order: Math.max(0, ...currentSections.map(s => s.order)) + 1, createdAt: now() }; await save("notebook-section", section); setSectionId(section.id); setParams({}); }); }}><Plus size={15} />New section</button>
        {currentSections.some(s => s.id === currentSection) && <div className="section-actions"><button aria-label="Move section up" onClick={() => swapSection(-1)}><ArrowUp size={16} /></button><button aria-label="Move section down" onClick={() => swapSection(1)}><ArrowDown size={16} /></button><button aria-label="Rename section" onClick={() => { const s = currentSections.find(s => s.id === currentSection)!; const title = prompt("Section name", s.title); if (title?.trim()) run(() => save("notebook-section", { ...s, title: title.trim().slice(0, 200) })); }}><Pencil size={16} /></button><button aria-label="Delete section" disabled={currentSection === defaultSectionId(currentId)} onClick={() => run(async () => { await flushActive(); if (confirm("Delete this section? Its pages will move to Notes.")) { await deleteNotebookSection(currentSection); setSectionId(defaultSectionId(currentId)); setParams({}); } })}><Trash2 size={16} /></button></div>}
        {current && <button className="text-button danger notebook-trash" onClick={() => run(async () => { if (!confirm(`Move “${current.title}” and its pages to trash?`)) return; await flushActive(); await db.transaction("rw", db.rows, db.outbox, db.conflicts, db.meta, async () => { await save("notebook", current, true); for (const n of notes.filter(n => n.notebookId === current.id)) await save("notebook-note", n, true); for (const s of currentSections) await save("notebook-section", s, true); }); setNotebookId(""); setParams({}); })}>Trash notebook</button>}
      </aside>
      <aside className="notebook-pages" aria-label="Notebook pages">
        <h2 className="navigator-heading">{currentSections.find(s => s.id === currentSection)?.title || "Pages"}</h2>
        <label className="search-field"><Search size={17} /><input aria-label="Search notebook" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search notes or tags" /></label>
        <button className="text-button" onClick={addNote}><Plus size={16} />New note</button>
        <nav>{filtered.map(n => <button className={n.id === noteId ? "active" : ""} aria-current={n.id === noteId ? "page" : undefined} key={n.id} onClick={() => selectNote(n.id)}><strong>{n.title}</strong><span>{plainText(n.document).slice(0, 90) || "Start writing…"}</span>{n.tags.length > 0 && <small>{n.tags.join(", ")}</small>}</button>)}</nav>
        {!filtered.length && <p className="muted">{query ? "No matching pages." : "Create a page in this section."}</p>}
      </aside>
      <main className="notebook-detail">
        <div className="notebook-detail-actions"><button className="text-button notebook-navigator-toggle" aria-expanded={navigator} onClick={() => { setFocus(false); setNavigator(!navigator); }}><PanelLeft size={17} />Pages</button><span>{current?.title || "Your ideas, together"} / {currentSections.find(s => s.id === currentSection)?.title || "Notes"}</span><div className="button-row"><button className="text-button" aria-label="Focus notebook page" aria-pressed={focus} onClick={() => { setFocus(!focus); setNavigator(false); }}><Maximize2 size={17} /></button><button className="text-button" aria-pressed={research} onClick={() => setResearch(!research)}><Sparkles size={17} />Research</button></div></div>
        {activeNote && <div className="page-organization"><label>Section<select aria-label="Move page to section" value={currentSection} onChange={e => { const next = e.target.value; run(async () => { await flushActive(); const latest = await db.rows.get(`notebook-note:${noteId}`); await save("notebook-note", { ...(latest?.value as typeof activeNote || activeNote), sectionId: next }); window.dispatchEvent(new CustomEvent("leafmark-clipped", { detail: { id: noteId } })); }); }}>{currentSections.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label><button aria-label="Move page up" onClick={() => movePage(-1)}><ArrowUp size={16} /></button><button aria-label="Move page down" onClick={() => movePage(1)}><ArrowDown size={16} /></button></div>}
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
      return <article className="research-pending" key={v.key}><h3>{old.title}</h3><p>{plainText(old.document).slice(0, 300)}</p><button className="secondary" onClick={() => run(async () => { const recovered = await recoverNotebookNote(old, activeNote.notebookId); setParams({ note: recovered.id }); setVersionsOpen(false); })}>Recover as a new note</button></article>;
    })}</Dialog>}
  </div>;
}
