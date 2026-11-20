import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useSearchParams } from "react-router-dom";
import { NotebookPen, Plus, Search, Trash2, Download, Sparkles, PanelLeft, Maximize2, ArrowUp, ArrowDown } from "lucide-react";
import { db, get, list, save } from "./db";
import { now, uid } from "./model";
import { emptyDocument, plainText } from "./richText";
import { TopicEditor } from "./TopicEditor";
import { ResearchBrowser } from "./ResearchBrowser";
import { BrowsePages, pageOf } from "./browse";
import { documentSources } from "./sourceReferences";
import { SourceLink } from "./Citation";
import { Dialog } from "./components";
import { exportResearch, restoreResearchBackup } from "./researchBackup";
import { recoverNotebookNote, flushTopicNote } from "./notebookStore";
import { defaultSectionId, noteSection, noteOrder, ensureNotebookSection, deleteNotebookSection } from "./notebookSections";
import { ItemMenu, RenameItem } from "./ItemMenu";
import { moveActions, orderedNotebooks, orderedPages, orderedSections, reorder, type Move } from "./reordering";
import { ReorderGrip, useReorderDrag } from "./useReorderDrag";
import type { NotebookNote } from "./researchTypes";
import "./research.css";
import "./notebookWorkspace.css";

export function Notebooks() {
  const notebooks = useLiveQuery(async () => (await list("notebook")).sort(orderedNotebooks), []) || [];
  const notes = useLiveQuery(() => list("notebook-note"), []) || [];
  const sections = useLiveQuery(() => list("notebook-section"), []) || [];
  const [params, writeParams] = useSearchParams();
  const research = params.get("view") === "research";
  const setParams = (patch: Record<string, string>) => writeParams(previous => {
    const next = new URLSearchParams(previous); next.delete("note"); next.delete("drawing"); next.delete("media"); next.delete("at");
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
    return next;
  });
  const setResearch = (value: boolean) => run(async () => { await flushActive(); writeParams(previous => { const next = new URLSearchParams(previous); next.set("view", value ? "research" : "notes"); return next; }); });
  const noteId = params.get("note") || "";
  const activeNote = notes.find(n => n.id === noteId);
  const [notebookId, setNotebookId] = useState("");
  const currentId = activeNote?.notebookId || (notebooks.some(n => n.id === params.get("notebook")) ? params.get("notebook")! : "") || notebookId || notebooks[0]?.id || "";
  const current = notebooks.find(n => n.id === currentId);
  const [sectionId, setSectionId] = useState("");
  const [navigator, setNavigator] = useState(false), [focus, setFocus] = useState(false);
  const currentSections = sections.filter(s => s.notebookId === currentId).sort(orderedSections);
  const currentSection = activeNote ? noteSection(activeNote) : currentSections.some(s => s.id === (params.get("section") || sectionId)) ? (params.get("section") || sectionId) : defaultSectionId(currentId);
  const query = params.get("q") || "";
  const setQuery = (value: string) => writeParams(previous => { const next = new URLSearchParams(previous); next.set("q", value); next.set("np", "1"); return next; }, { replace: true });
  const [notebookQuery, setNotebookQuery] = useState(""), [error, setError] = useState("");
  const [creating, setCreating] = useState(false), [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false), [versionsOpen, setVersionsOpen] = useState(false);
  const [rename, setRename] = useState<{ label: string; title: string; save: (name: string) => Promise<unknown> }>();
  const [moving, setMoving] = useState<NotebookNote>();
  const versions = useLiveQuery(() => db.meta.where("key").startsWith(`note-version:${noteId}:`).toArray(), [noteId]) || [];
  const links = activeNote ? documentSources(activeNote.document) : [];
  const run = (action: () => Promise<unknown>) => { setError(""); void action().catch(e => setError(e.message)); };
  useEffect(() => { if (currentId) run(() => ensureNotebookSection(currentId)); }, [currentId]);
  async function flushActive() { if (activeNote && !(await flushTopicNote(activeNote.id))) throw new Error("Save your writing before changing this page."); }
  async function openPageStudy() {
    await flushActive();
    const related = (await list("research-thread")).filter(study => study.notebookId === currentId && !study.bookId && !study.selection)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const existing = activeNote ? related.find(study => study.scope?.noteIds.includes(activeNote.id)) : related[0];
    const study = existing || {
      id: uid(), title: activeNote?.title || current?.title || "Research", notebookId: currentId || undefined,
      scope: { bookIds: [], noteIds: activeNote ? [activeNote.id] : [], highlightIds: [] }, createdAt: now(),
    };
    if (!existing) await save("research-thread", study);
    writeParams(previous => {
      const next = new URLSearchParams(previous);
      next.set("view", "research"); next.set("researchNotebook", currentId); next.set("thread", study.id); next.delete("result");
      return next;
    });
  }
  const selectNote = (id: string) => run(async () => { await flushActive(); setParams({ note: id, view: "notes" }); setNavigator(false); });
  const order = (kind: "notebook" | "notebook-section" | "notebook-note", id: string, target: Move) => run(async () => {
    if (kind === "notebook-note") await flushActive();
    await reorder(kind, id, target);
  });
  const notebookDrag = useReorderDrag(!notebookQuery, (id, target) => order("notebook", id, target));
  const sectionDrag = useReorderDrag(true, (id, target) => order("notebook-section", id, target));
  const pageDrag = useReorderDrag(!query, (id, target) => order("notebook-note", id, target));
  const detailScroll = useRef<HTMLDivElement>(null);
  const [headerHost, setHeaderHost] = useState<HTMLDivElement | null>(null);
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
  const scrollMemory = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    if (detailScroll.current && !navigator) detailScroll.current.scrollTop = scrollMemory.current.get(noteId) ?? 0;
  }, [noteId, navigator, research]);
  async function changeNote(id: string, patch: Partial<NotebookNote>, deleted = false) {
    await flushActive();
    const latest = await get("notebook-note", id);
    if (!latest) throw new Error("This page was removed.");
    await save("notebook-note", { ...latest, ...patch, updatedAt: now() }, deleted);
    if (deleted && noteId === id) setParams({});
    else window.dispatchEvent(new CustomEvent("leafmark-clipped", { detail: { id } }));
  }
  function trashPage(id: string) {
    if (confirm("Move this note to trash?")) run(() => changeNote(id, {}, true));
  }
  async function trashNotebook(id: string) {
    const notebook = await get("notebook", id);
    if (!notebook || !confirm(`Move “${notebook.title}” and its pages to Trash?`)) return;
    await flushActive();
    await db.transaction("rw", db.rows, db.outbox, db.conflicts, db.meta, async () => {
      for (const page of (await list("notebook-note")).filter(page => page.notebookId === id)) await save("notebook-note", page, true);
      for (const section of (await list("notebook-section")).filter(section => section.notebookId === id)) await save("notebook-section", section, true);
      await save("notebook", notebook, true);
    });
    if (id === currentId) { setNotebookId(""); setSectionId(""); setParams({ notebook: "", section: "", np: "1" }); }
  }
  const addNote = () => run(async () => {
    if (!current) { setCreating(true); return; }
    await flushActive(); await ensureNotebookSection(current.id);
    const note = { id: uid(), notebookId: current.id, sectionId: currentSection, order: Math.max(0, ...notes.filter(n => noteSection(n) === currentSection).map(noteOrder)) + 1024, title: "Untitled note", document: emptyDocument(), tags: [], createdAt: now(), updatedAt: now() };
    await save("notebook-note", note); setParams({ note: note.id }); setNavigator(false);
  });
  const filtered = notes.filter(n => n.notebookId === currentId && (query || noteSection(n) === currentSection) && `${n.title} ${plainText(n.document)} ${n.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase())).sort(orderedPages);
  const page = pageOf(filtered, params.get("np") || "1");
  return <div className={`notebooks-page workspace-notebooks ${research ? "workspace-research" : "workspace-writing"} ${navigator ? "navigator-open" : ""} ${focus ? "notebook-focus" : ""} ${activeNote ? "has-open-page" : ""}`}>
    <header className="page-header"><div><h1>Notebooks<span className="count">{notebooks.length}</span></h1></div><div className="button-row"><button className="secondary" onClick={() => { setTitle(""); setCreating(true); }}><Plus size={17} />New notebook</button><label className="export-select"><Download size={17} /><select aria-label="Export notebooks" value="" onChange={e => { if (e.target.value) run(() => exportResearch(e.target.value as "md" | "json")); }}><option value="">Export</option><option value="md">Markdown</option><option value="json">JSON backup</option></select></label><label className="text-button notebook-import">Restore backup<input type="file" accept="application/json,.json" aria-label="Restore research backup" onChange={e => { const file = e.target.files?.[0]; if (file) run(async () => { const result = await restoreResearchBackup(JSON.parse(await file.text())); setError(`Restored ${result.restored} records; kept ${result.skipped} existing records.`); }); e.target.value = ""; }} /></label></div></header>
    {error && <p className="notice" role="status">{error}</p>}
    <nav className="workspace-tabs" role="tablist" aria-label="Notebook workspace"><button role="tab" aria-selected={!research} onClick={() => setResearch(false)}>Notes</button><button role="tab" aria-selected={research} onClick={() => setResearch(true)}>Research</button></nav>
    {research ? <ResearchBrowser /> : <div className="notebook-layout">
      <aside className="notebook-list" aria-label="Notebooks and notes">
        {navigator && <button className="text-button" aria-label="Close notebook navigation" onClick={() => setNavigator(false)}>Close navigation</button>}
        <label className="search-field"><Search size={16} /><input aria-label="Find a notebook" placeholder="Find a notebook" value={notebookQuery} onChange={e => setNotebookQuery(e.target.value)} /></label>
        <nav aria-label="Notebook list" {...notebookDrag}>{notebooks.filter(n => n.id === currentId || n.title.toLowerCase().includes(notebookQuery.toLowerCase())).map(n => <ItemMenu key={n.id} title={n.title} reorderId={n.id} grip={!notebookQuery && <ReorderGrip title={n.title} />} actions={[
          { label: "Rename", run: () => setRename({ label: "notebook", title: n.title, save: async title => { await flushActive(); const latest = await get("notebook", n.id); if (latest) await save("notebook", { ...latest, title }); } }) },
          ...moveActions(notebooks, n.id, target => order("notebook", n.id, target), !notebookQuery),
          { label: "Move to Trash", danger: true, run: () => run(() => trashNotebook(n.id)) },
        ]}><button aria-current={n.id === currentId ? "page" : undefined} onClick={() => run(async () => {
          await flushActive(); setNotebookId(n.id); setSectionId(""); setParams({ notebook: n.id, section: "", np: "1" }); setNavigator(false);
        })}><strong>{n.title}</strong></button></ItemMenu>)}</nav>
        <h2 className="navigator-heading">Sections</h2>
        <nav className="notebook-sections" aria-label="Notebook sections" {...sectionDrag}>{currentSections.map(section => <ItemMenu key={section.id} title={section.title} reorderId={section.id} grip={<ReorderGrip title={section.title} />} actions={[
          { label: "Rename", run: () => setRename({ label: "section", title: section.title, save: async title => { const latest = await get("notebook-section", section.id); if (latest) await save("notebook-section", { ...latest, title }); } }) },
          ...moveActions(currentSections, section.id, target => order("notebook-section", section.id, target)),
          { label: "Delete section", danger: true, disabled: section.id === defaultSectionId(currentId), run: () => run(async () => {
            if (!confirm("Delete this section? Its pages will move to Notes.")) return;
            await flushActive(); await deleteNotebookSection(section.id);
            if (section.id === currentSection) { setSectionId(defaultSectionId(currentId)); setParams({ section: defaultSectionId(currentId) }); }
          }) },
        ]}><button className={section.id === currentSection ? "active" : ""} aria-current={section.id === currentSection ? "page" : undefined} onClick={() => run(async () => {
          await flushActive(); setSectionId(section.id); setParams({ section: section.id, np: "1" }); setNavigator(false);
        })}><span className="section-tab" /><strong>{section.title}</strong><small>{notes.filter(n => noteSection(n) === section.id).length}</small></button></ItemMenu>)}</nav>
        <button className="text-button" disabled={!current} onClick={() => { const title = prompt("Section name"); if (title?.trim() && current) run(async () => { await flushActive(); const section = { id: uid(), notebookId: current.id, title: title.trim().slice(0, 200), order: Math.max(0, ...currentSections.map(s => s.order)) + 1, createdAt: now() }; await save("notebook-section", section); setSectionId(section.id); setParams({ section: section.id, np: "1" }); setNavigator(false); }); }}><Plus size={15} />New section</button>
      </aside>
      <aside className="notebook-pages" aria-label="Notebook pages">
        <h2 className="navigator-heading">{currentSections.find(s => s.id === currentSection)?.title || "Pages"}</h2>
        <label className="search-field"><Search size={17} /><input aria-label="Search notebook" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search notes or tags" /></label>
        <button className="text-button" onClick={addNote}><Plus size={16} />New note</button>
        <nav aria-label="Pages in this section" {...pageDrag}>{page.items.map(n => <ItemMenu key={n.id} title={n.title} reorderId={n.id} grip={!query && <ReorderGrip title={n.title} />} actions={[
          { label: "Rename", run: () => setRename({ label: "page", title: n.title, save: title => changeNote(n.id, { title }) }) },
          { label: "Move to section", disabled: currentSections.length < 2, run: () => setMoving(n) },
          ...moveActions(filtered, n.id, target => order("notebook-note", n.id, target), !query),
          { label: "Move to Trash", danger: true, run: () => trashPage(n.id) },
        ]}><button className={n.id === noteId ? "active" : ""} aria-current={n.id === noteId ? "page" : undefined} onClick={() => selectNote(n.id)}><strong>{n.title}</strong><span>{plainText(n.document).slice(0, 90)}</span></button></ItemMenu>)}</nav>
        <BrowsePages {...page} label="Pages" onChange={n => writeParams(previous => { const next = new URLSearchParams(previous); next.set("np", String(n)); return next; })} />
        {!filtered.length && <p className="muted">{query ? "No matching pages." : "Create a page in this section."}</p>}
      </aside>
      <main className="notebook-detail">
        <header className="notebook-detail-actions">
          <button className="text-button notebook-navigator-toggle" aria-expanded={navigator} onClick={() => { setFocus(false); setNavigator(!navigator); }}><PanelLeft size={17} />Pages</button>
          <span>{current?.title || "Your ideas, together"} / {currentSections.find(s => s.id === currentSection)?.title || "Notes"}</span>
          <div className="button-row">
            <button className="text-button" aria-label="Focus notebook page" aria-pressed={focus} onClick={() => { setFocus(!focus); setNavigator(false); }}><Maximize2 size={17} /></button>
            <button className="text-button" aria-pressed={research} onClick={() => run(openPageStudy)}><Sparkles size={17} />Research</button>
            {activeNote && <div ref={setHeaderHost} />}
          </div>
        </header>
        {activeNote && <div className="page-organization"><label>Section<select aria-label="Move page to section" value={currentSection} onChange={e => run(() => changeNote(noteId, { sectionId: e.target.value }))}>{currentSections.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label><button aria-label="Move page up" onClick={() => order("notebook-note", noteId, -1)}><ArrowUp size={16} /></button><button aria-label="Move page down" onClick={() => order("notebook-note", noteId, 1)}><ArrowDown size={16} /></button></div>}
        {activeNote && <div className="notebook-toolbar-host" ref={setToolbarHost} />}
        <div className="notebook-page-scroll" ref={detailScroll} onScroll={e => { if (!navigator) scrollMemory.current.set(noteId, e.currentTarget.scrollTop); }}>
        {activeNote ? <><TopicEditor key={activeNote.id} note={activeNote} headerHost={headerHost} toolbarHost={toolbarHost} /><div className="notebook-note-actions"><button className="text-button" disabled={!versions.length} onClick={() => setVersionsOpen(true)}>Recover other versions ({versions.length})</button><button className="text-button danger" onClick={() => trashPage(activeNote.id)}><Trash2 size={15} />Trash note</button></div>
          {links.length > 0 && <details className="note-backlinks"><summary>Connected sources ({links.length})</summary>{links.map((s, i) => <SourceLink key={i} source={s} />)}</details>}
        </> : <div className="notebook-welcome"><NotebookPen size={34} /><h2>{current ? "Make room for an idea" : "Your first topic notebook"}</h2><p>Write freely, collect passages from different books, and keep useful research with its sources.</p><button className="primary" onClick={addNote}>{current ? "Create a note" : "Create a notebook"}</button></div>}
        </div>
      </main>
    </div>}
    {rename && <RenameItem value={rename.title} label={rename.label} onSave={rename.save} onClose={() => setRename(undefined)} />}
    {moving && <Dialog title="Move page to section" onClose={() => setMoving(undefined)}><div className="clip-form">{currentSections.map(section =>
      <button key={section.id} className="secondary" disabled={section.id === noteSection(moving)} onClick={() => run(async () => {
        await changeNote(moving.id, { sectionId: section.id }); setMoving(undefined);
      })}>{section.title}</button>)}</div></Dialog>}
    {creating && <Dialog title="New notebook" onClose={() => setCreating(false)}><form className="clip-form" onSubmit={async e => {
      e.preventDefault(); setBusy(true);
      try { const n = { id: uid(), title: title.trim(), createdAt: now() }; await save("notebook", n); setNotebookId(n.id); setParams({ notebook: n.id, section: "", view: "notes" }); setCreating(false); }
      catch (e) { setError(String(e)); } finally { setBusy(false); }
    }}><label>Notebook name<input autoFocus required maxLength={150} value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Science and the universe" /></label><button className="primary" disabled={busy || !title.trim()}>Create notebook</button></form></Dialog>}
    {versionsOpen && activeNote && <Dialog title="Recover another version" onClose={() => setVersionsOpen(false)}><p>Your current note is kept. Recover a version as a separate note.</p>{versions.map(v => {
      let old: typeof activeNote; try { old = JSON.parse(v.value).value; } catch { return null; }
      if (!old?.document) return null;
      return <article className="research-pending" key={v.key}><h3>{old.title}</h3><p>{plainText(old.document).slice(0, 300)}</p><button className="secondary" onClick={() => run(async () => { const recovered = await recoverNotebookNote(old, activeNote.notebookId); setParams({ note: recovered.id }); setVersionsOpen(false); })}>Recover as a new note</button></article>;
    })}</Dialog>}
  </div>;
}
