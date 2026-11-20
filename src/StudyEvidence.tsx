import { BookOpen, NotebookPen } from "lucide-react";
import { SourceLink } from "./Citation";
import type { SourceRef } from "./researchTypes";
import { originalSource, sourceLabel } from "./sourceReferences";

export type SaveFinding = (text: string, sources: SourceRef[]) => void;

function Passage({ source, onSave }: { source: SourceRef; onSave: SaveFinding }) {
  const link = originalSource(source);
  return <>
    <blockquote>{source.excerpt}</blockquote>
    <div className="study-passage-actions">
      <SourceLink source={link} />
      <button className="text-button" onClick={() => onSave(source.excerpt, [source])}><NotebookPen size={16} />Save excerpt</button>
    </div>
  </>;
}

export function StudyEvidence({ id, sources, selected, expanded, onExpand, onSelect, onSave }: {
  id: string; sources: SourceRef[]; selected?: string; expanded: boolean;
  onExpand: () => void; onSelect: (id: string) => void; onSave: SaveFinding;
}) {
  const active = sources.find(source => source.id === selected) || sources[0];
  if (!active) return null;
  return <div className="study-evidence">
    <button type="button" className="secondary study-evidence-toggle" aria-expanded={expanded} aria-controls={id} onClick={onExpand}>
      <BookOpen size={16} />{expanded ? "Hide evidence" : `View evidence (${sources.length})`}
    </button>
    <aside id={id} className="study-evidence-panel" data-expanded={expanded} aria-label="Supporting evidence">
      <h3>Evidence</h3>
      <label className="study-evidence-select">Source<select value={active.id} onChange={event => onSelect(event.target.value)}>
        {sources.map((source, index) => <option key={source.id} value={source.id}>{index + 1}. {sourceLabel(source)}</option>)}
      </select></label>
      <div id={`${id}-excerpt`} tabIndex={-1} className="study-excerpt">
        <Passage source={active} onSave={onSave} />
      </div>
    </aside>
  </div>;
}

export function PassageResults({ hits, notice, onSave }: { hits: SourceRef[]; notice?: string; onSave: SaveFinding }) {
  return <div className="study-passages">
    {notice && <p className="study-muted" role="status">{notice}</p>}
    {!hits.length && <p>No matching passages in the text available on this device.</p>}
    {hits.map((source, index) => <article key={`${source.id}-${index}`}>
      <h4>{sourceLabel(source)}</h4>
      <Passage source={source} onSave={onSave} />
    </article>)}
  </div>;
}
