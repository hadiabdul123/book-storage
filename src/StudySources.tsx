import { useState } from "react";
import { StudyBookRange } from "./StudyBookRange";
import type { Book } from "./model";
import { Dialog } from "./components";
import type { ResearchScope } from "./researchTypes";

export type StudySourceOption = { kind: "bookIds" | "noteIds" | "highlightIds"; id: string; title: string; detail?: string };
export const studySourceCount = (scope: ResearchScope) => scope.bookIds.length + scope.highlightIds.length + scope.noteIds.length;
const kinds = [
  { id: "bookIds", label: "Books" },
  { id: "highlightIds", label: "Highlights" },
  { id: "noteIds", label: "Notebook pages" },
] as const;

export function StudySources({ scope, options, books = [], creating = false, onClose, onSave }: {
  creating?: boolean; books?: Book[]; scope: ResearchScope; options: StudySourceOption[]; onClose: () => void; onSave: (scope: ResearchScope) => Promise<void>;
}) {
  const [draft, setDraft] = useState(scope);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<StudySourceOption["kind"]>(scope.bookIds.length || !studySourceCount(scope) ? "bookIds" : scope.highlightIds.length ? "highlightIds" : "noteIds");
  const [limit, setLimit] = useState(50);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const count = studySourceCount(draft);
  const needle = query.trim().toLowerCase();
  const choices = options.filter(option => option.kind === kind);
  const unavailable = draft[kind].filter(id => !choices.some(option => option.id === id))
    .map(id => ({ id, title: "Unavailable source", detail: "Uncheck to remove this source from the study" }));
  const visible = [...unavailable, ...choices].filter(option => `${option.title} ${option.detail || ""}`.toLowerCase().includes(needle));
  function choose(id: string, checked: boolean) {
    setDraft(current => ({
      ...current, [kind]: checked ? [...current[kind], id] : current[kind].filter(item => item !== id),
    }));
  }
  return <Dialog title="Study sources" onClose={busy ? () => {} : onClose} wide>
    <form className="study-source-picker" onSubmit={async event => {
      event.preventDefault();
      setError(""); setBusy(true);
      try { await onSave({ ...draft, ranges: (draft.ranges || []).filter(r => draft.bookIds.includes(r.bookId)) }); onClose(); }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { setBusy(false); }
    }}>
      <div className="study-source-kinds" role="group" aria-label="Source type">
        {kinds.map(item => <button type="button" aria-pressed={kind === item.id} key={item.id} onClick={() => {
          setKind(item.id); setQuery(""); setLimit(50);
        }}>{item.label}{draft[item.id].length ? ` (${draft[item.id].length})` : ""}</button>)}
      </div>
      <label>Find sources<input type="search" value={query} onChange={event => { setQuery(event.target.value); setLimit(50); }} /></label>
      {!visible.length && <p>{query ? "No matching sources." : "There are no sources of this type in your library yet."}</p>}
      <div className="study-source-choices">{visible.slice(0, limit).map(option => <label key={option.id}>
        <input type="checkbox" checked={draft[kind].includes(option.id)}
          disabled={busy || (!draft[kind].includes(option.id) && count >= 7)} onChange={event => choose(option.id, event.target.checked)} />
        <span><strong>{option.title}</strong>{option.detail && <small>{option.detail}</small>}</span>
      </label>)}
        {visible.length > limit && <button type="button" className="text-button" onClick={() => setLimit(value => value + 50)}>Show more sources</button>}
      </div>
      {books.filter(b => draft.bookIds.includes(b.id)).map(b => <StudyBookRange key={b.id} book={b} ranges={(draft.ranges || []).filter(r => r.bookId === b.id)}
        onChange={ranges => setDraft(d => ({ ...d,ranges:[...(d.ranges || []).filter(r => r.bookId !== b.id),...ranges] }))} />)}
      {error && <p role="alert">{error}</p>}
      <div className="study-source-footer"><span role="status">{count} of 7 sources selected</span><button className="primary" disabled={busy || (creating && !count)}>{creating ? "Start study" : "Save sources"}</button></div>
    </form>
  </Dialog>;
}
