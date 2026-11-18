import { useState } from "react";
import { Plus } from "lucide-react";
import { Dialog } from "./components";
import { ItemMenu } from "./ItemMenu";
import { followupLimit, priorities, saveFollowup, setHighlightTags, type HighlightFollowup, type HighlightPriority } from "./highlightStudy";

export function HighlightLabels({ tags, priority }: { tags: string[]; priority?: HighlightPriority }) {
  if (!tags.length && !priority) return null;
  return <span className="highlight-labels">
    {priority && <span className={`highlight-priority priority-${priority}`}>{priorities[priority]}</span>}
    {tags.map((tag, index) => <span key={`${tag}:${index}`} className="highlight-tag">{tag}</span>)}
  </span>;
}

export function HighlightFollowups({ annotationId, notes }: { annotationId: string; notes: HighlightFollowup[] }) {
  const [editing, setEditing] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function apply(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); setEditing(""); setText(""); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return <section className="highlight-followups" aria-label="Follow-up notes">
    <h3>Follow-up notes</h3>
    {notes.map(note => <article key={note.id} className="highlight-followup">
      <ItemMenu title={`follow-up from ${new Date(note.createdAt).toLocaleDateString()}`} actions={[
        { label: "Edit follow-up", disabled: busy || !!editing, run: () => { setText(note.text); setEditing(note.id); } },
        { label: "Delete follow-up", danger: true, disabled: busy || !!editing, run: () => {
          if (confirm("Delete this follow-up note?")) void apply(() => saveFollowup(annotationId, note.text, note.id, true));
        } },
      ]}><time dateTime={note.createdAt}>{new Date(note.createdAt).toLocaleDateString()}</time></ItemMenu>
      <p>{note.text}</p>
    </article>)}
    {editing ? <form onSubmit={e => { e.preventDefault(); void apply(() => saveFollowup(annotationId, text, editing === "new" ? undefined : editing)); }}>
      <label>{editing === "new" ? "New follow-up note" : "Edit follow-up note"}
        <textarea rows={4} autoFocus value={text} maxLength={followupLimit} onChange={e => setText(e.target.value)} />
      </label>
      <div className="button-row"><button className="primary" disabled={!text.trim() || busy}>Save follow-up note</button><button type="button" className="text-button" disabled={busy} onClick={() => { setEditing(""); setText(""); setError(""); }}>Cancel</button></div>
    </form> : <button className="text-button" disabled={busy} onClick={() => setEditing("new")}><Plus size={16} />Add follow-up note</button>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

export function EditHighlightTags({ annotationId, tags, onClose }: { annotationId: string; tags: string[]; onClose: () => void }) {
  const [text, setText] = useState(tags.join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <Dialog title="Edit highlight tags" onClose={onClose}>
    <form className="clip-form" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError("");
      try { await setHighlightTags(annotationId, [...new Set(text.split(",").map(tag => tag.trim()).filter(Boolean))]); onClose(); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(false); }
    }}>
      <label>Tags<input autoFocus value={text} onChange={e => setText(e.target.value)} placeholder="Separate tags with commas" /></label>
      {error && <p role="alert">{error}</p>}
      <button className="primary" disabled={busy}>Save tags</button>
    </form>
  </Dialog>;
}
