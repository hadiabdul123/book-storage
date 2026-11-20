import { useEffect, useState } from "react";
import { Dialog } from "./components";
import { reviewBatchSize, planBookReview, reviewQuestion, type ReviewSection } from "./bookReview";
import type { Book } from "./model";

export function BookReviewPicker({ books, ranges, focus, previous, onClose, onReview, returnLabel = "Back to conversation" }: {
  ranges?: import("./researchTypes").BookRange[]; books: Book[]; focus: string; previous: Set<string>; onClose: () => void; onReview: (sections: ReviewSection[]) => Promise<void>;
  returnLabel?: string;
}) {
  const [sections, setSections] = useState<ReviewSection[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [reviewed, setReviewed] = useState<Set<string>>(() => new Set());
  const [status, setStatus] = useState("Preparing book text…");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void planBookReview(books, abort.signal, setStatus, ranges).then(plan => {
      if (abort.signal.aborted) return;
      const done = new Set(plan.filter(section => previous.has(reviewQuestion(section, focus))).map(section => section.id));
      setSections(plan); setStatus(""); setReviewed(done);
      setSelected(plan.filter(section => section.sources.length && !done.has(section.id)).slice(0, reviewBatchSize).map(section => section.id));
    }, error => { if (!abort.signal.aborted) { setError(error.message); setStatus(""); } });
    return () => abort.abort();
  }, []);
  const remaining = sections.filter(section => section.sources.length && !reviewed.has(section.id));
  return <Dialog title="Review chapters" onClose={busy ? () => {} : onClose} wide>
    {status && <p role="status">{status}</p>}
    {error && <p role="alert">{error}</p>}
    {!!sections.length && <><p>Each section gets a separate cited review. Longer sections use excerpts sampled across the section.</p>
      <div className="research-chapter-list" aria-label="Book sections">{sections.map(section => <label key={section.id}>
        <input type="checkbox" checked={selected.includes(section.id)} disabled={busy || !section.sources.length || reviewed.has(section.id) || (!selected.includes(section.id) && selected.length >= reviewBatchSize)} onChange={e => {
          setSelected(ids => e.target.checked ? [...ids, section.id] : ids.filter(id => id !== section.id));
        }} />
        <span><strong>{section.label}</strong><small>{section.book.title} · {reviewed.has(section.id) ? "Queued" : section.sources.length ? `${section.sources.length} of ${section.excerpts} excerpts` : "No cached text"}</small></span>
      </label>)}</div>
      <div className="button-row research-chapter-actions"><button className="primary" disabled={busy || !selected.length} onClick={async () => {
        const batch = sections.filter(section => selected.includes(section.id));
        setBusy(true); setError("");
        try {
          await onReview(batch);
          setReviewed(previous => new Set([...previous, ...selected]));
          setSelected(remaining.filter(section => !selected.includes(section.id)).slice(0, reviewBatchSize).map(section => section.id));
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
      }}>{busy ? "Queuing…" : `Review ${selected.length || "selected"} ${selected.length === 1 ? "section" : "sections"}`}</button>
        <button className="secondary" disabled={busy} onClick={onClose}>{returnLabel}</button>
      </div>
      {!!reviewed.size && <p role="status">{reviewed.size} sections queued. Return to the results to read the reviews.</p>}
    </>}
  </Dialog>;
}
