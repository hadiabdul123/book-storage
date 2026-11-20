import { useEffect, useState } from "react";
import { planBookReview, type ReviewSection } from "./bookReview";
import type { Book } from "./model";
import type { BookRange } from "./researchTypes";

export function StudyBookRange({ book, ranges, onChange }: { book: Book; ranges: BookRange[]; onChange: (ranges: BookRange[]) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [sections, setSections] = useState<ReviewSection[]>([]);
  const [status, setStatus] = useState("");
  const [start, setStart] = useState("1"), [end, setEnd] = useState("");
  useEffect(() => {
    if (!expanded) return;
    const ctrl = new AbortController();
    setStatus("Loading sections…");
    void planBookReview([book],ctrl.signal,setStatus).then(items => {
      if (!ctrl.signal.aborted) { setSections(items); setStatus(""); }
    }, e => { if (!ctrl.signal.aborted) setStatus(e.message); });
    return () => ctrl.abort();
  }, [book.id,expanded]);
  function add(from: number, to: number, label: string) {
    if (ranges.some(r => r.start === from && r.end === to)) return;
    onChange([...ranges, { bookId:book.id, start:from, end:to, label }]);
  }
  const from = Number(start), to = Number(end || start), last = sections.at(-1)?.end;
  const valid = Number.isSafeInteger(from) && Number.isSafeInteger(to) && from > 0 && to >= from && to <= (last ?? 100000);
  return <section className="source-bounds">
    <button type="button" className="text-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{book.title} · {ranges.length ? ranges.map(r => r.label).join(", ") : "Whole book"}</button>
    {expanded && <><label>Chapter or section<select value="" onChange={e => { const s = sections.find(x => x.id === e.target.value); if (s) add(s.start,s.end,s.label); }}>
      <option value="">Choose a section</option>{sections.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
      {book.format === "pdf" && <div className="range-inputs"><label>From page<input type="number" min={1} value={start} onChange={e => setStart(e.target.value)} /></label>
        <label>To page<input type="number" min={from} placeholder={start} value={end} onChange={e => setEnd(e.target.value)} /></label>
        <button type="button" disabled={!valid} onClick={() => add(from,to,from === to ? "Page " + from : "Pages " + from + "–" + to)}>Add pages</button></div>}
      {status && <small role="status">{status}</small>}
      {ranges.map(r => <button key={r.start + ":" + r.end} type="button" onClick={() => onChange(ranges.filter(x => x !== r))}>Remove {r.label}</button>)}
    </>}
  </section>;
}
