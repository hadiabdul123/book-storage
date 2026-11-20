import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { uid, now } from "./model";
import { list, save, get } from "./db";
import { Dialog } from "./components";
import type { SourceRef } from "./researchTypes";
import { saveResearchClip, type ClipTarget } from "./notebookStore";

export function SaveResearch({ text, sources, passage, studyId, notebookOnly, onClose }: {
  notebookOnly?: boolean; studyId?: string; text: string; sources: SourceRef[]; passage?: SourceRef; onClose: () => void;
}) {
  const notebooks = useLiveQuery(() => list("notebook"), []) || [];
  const notes = useLiveQuery(() => list("notebook-note"), []) || [];
  const books = useLiveQuery(() => list("book"), []) || [];
  const [destination, setDestination] = useState(passage ? "passage" : "new");
  const [noteId, setNoteId] = useState("");
  const [notebookId, setNotebookId] = useState("");
  const [notebookTitle, setNotebookTitle] = useState(notebookOnly ? "Reading notes" : "Research");
  const [title, setTitle] = useState(passage?.excerpt.slice(0, 60) || (notebookOnly ? text.slice(0, 60) : "Research note"));
  const [bookId, setBookId] = useState(passage?.locator?.type === "pdf" ? passage.bookId || "" : "");
  const [page, setPage] = useState(passage?.locator?.type === "pdf" ? passage.locator.page : 1);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  return <Dialog title={notebookOnly ? "Add to notebook" : "Save research to…"} onClose={onClose}>
    {saved ? <><p role="status">Excerpt and sources saved on this device.</p><button className="primary" onClick={onClose}>Done</button></> : <form className="clip-form" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError("");
      try {
        if (destination === "card") {
          const quote = sources.length === 1 && text.trim() === sources[0].excerpt.trim();
          const existing = quote && sources[0].annotationId ? await get("annotation",sources[0].annotationId) : undefined;
          if (!existing || existing.text !== text) await save("research-card",{ id:uid(), kind:quote && (!existing || existing.text === text) ? "quote" : "finding", text, sources, studyId, createdAt:now() });
          setSaved(true); return;
        }
        let target: ClipTarget;
        if (destination === "passage" && passage?.bookId && passage.locator) target = { kind: "passage", bookId: passage.bookId, locator: passage.locator, quote: passage.locator.quote?.exact || passage.excerpt };
        else if (destination === "page") target = { kind: "page", bookId, page };
        else if (destination === "note") target = { kind: "note", noteId };
        else target = { kind: "new", notebookId: notebookId || undefined, notebookTitle, title };
        await saveResearchClip(target, text, sources); setSaved(true);
      } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
    }}>
      <blockquote className="clip-preview">{text}</blockquote>
      <label>Destination<select aria-label="Save destination" value={destination} onChange={e => setDestination(e.target.value)}>
        {passage?.bookId && passage.locator && <option value="passage">Note on the selected passage</option>}
        {!notebookOnly && <option value="card">Save as card in Highlights &amp; notes</option>}
        {!notebookOnly && <option value="page">PDF page notebook</option>}<option value="note">Existing topic note</option><option value="new">New topic note</option>
      </select></label>
      {destination === "page" && <><label>PDF<select required value={bookId} onChange={e => setBookId(e.target.value)}><option value="">Choose a PDF</option>{books.filter(b => b.format === "pdf").map(b => <option key={b.id} value={b.id}>{b.title}</option>)}</select></label><label>Page<input type="number" min={1} required value={page} onChange={e => setPage(Number(e.target.value))} /></label></>}
      {destination === "note" && <label>Topic note<select required value={noteId} onChange={e => setNoteId(e.target.value)}><option value="">Choose a note</option>{notes.filter(n => notebooks.some(b => b.id === n.notebookId)).map(n => <option key={n.id} value={n.id}>{notebooks.find(b => b.id === n.notebookId)?.title} / {n.title}</option>)}</select></label>}
      {destination === "new" && <><label>Notebook<select value={notebookId} onChange={e => setNotebookId(e.target.value)}><option value="">Create a notebook</option>{notebooks.map(n => <option key={n.id} value={n.id}>{n.title}</option>)}</select></label>{!notebookId && <label>Notebook name<input required maxLength={150} value={notebookTitle} onChange={e => setNotebookTitle(e.target.value)} /></label>}<label>Note title<input required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></label></>}
      <p className="muted">{sources.length} source reference{sources.length === 1 ? "" : "s"} will be kept with this excerpt.</p>
      {error && <p role="alert" className="error">{error}</p>}<button className="primary" disabled={busy}>{busy ? "Saving…" : destination === "card" ? "Save card" : "Save excerpt"}</button>
    </form>}
  </Dialog>;
}
