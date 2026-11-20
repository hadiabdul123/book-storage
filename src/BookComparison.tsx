import { useState } from "react";
import { Columns2, NotebookPen } from "lucide-react";
import { Dialog } from "./components";
import { SourceLink } from "./Citation";
import { enqueueResearch } from "./research";
import { sourceLabel } from "./sourceReferences";
import { comparisonText, type ComparisonBook } from "../supabase/functions/research/comparison";
import type { Book } from "./model";
import type { ResearchMessage, SourceRef } from "./researchTypes";
import "./bookComparison.css";

export function queueBookComparison(threadId: string, question: string, books: ComparisonBook[]) {
  return enqueueResearch(threadId, { question, mode: "sources", sources: [], history: [], comparison: { books } }, true);
}

export function BookComparisonPicker({ books, selected: initial = [], question: initialQuestion = "", onClose, onCompare }: {
  books: Book[]; selected?: string[]; question?: string; onClose: () => void;
  onCompare: (question: string, books: ComparisonBook[]) => Promise<unknown>;
}) {
  const [selected, setSelected] = useState(initial.filter(id => books.some(book => book.id === id)).slice(0, 4));
  const [question, setQuestion] = useState(initialQuestion);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choices = books.filter(book => selected.includes(book.id) || `${book.title} ${book.author}`.toLowerCase().includes(query.toLowerCase()));
  return <Dialog title="Compare books" onClose={busy ? () => {} : onClose} wide>
    <form className="comparison-form" onSubmit={async event => {
      event.preventDefault();
      if (busy || selected.length < 2 || !question.trim()) return;
      setBusy(true); setError("");
      try {
        const chosen = selected.flatMap(id => books.filter(book => book.id === id).map(book => ({ bookId: id, title: book.title.slice(0, 300) })));
        if (chosen.length < 2) throw new Error("Choose at least two books still in your library.");
        await onCompare(question.trim(), chosen);
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { setBusy(false); }
    }}>
      <label>What would you like to compare?
        <textarea aria-label="Comparison question" value={question} onChange={event => setQuestion(event.target.value)}
          rows={3} required maxLength={1500} autoFocus placeholder="How do these books explain the same idea?" />
      </label>
      <fieldset>
        <legend>Choose two to four books</legend>
        <input type="search" aria-label="Find books to compare" placeholder="Find by title or author" value={query} onChange={event => setQuery(event.target.value)} />
        <div className="comparison-book-list">{choices.map(book => <label key={book.id}>
          <input type="checkbox" checked={selected.includes(book.id)} disabled={busy || (selected.length === 4 && !selected.includes(book.id))}
            onChange={event => setSelected(ids => event.target.checked ? [...ids, book.id] : ids.filter(id => id !== book.id))} />
          <span><strong>{book.title}</strong>{book.author && <small>{book.author}</small>}</span>
        </label>)}</div>
        {!choices.length && <p>{books.length ? "No matching books." : "Add books to your library to compare them."}</p>}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <div className="comparison-form-footer"><span aria-live="polite">{selected.length} selected</span>
        <button className="primary" disabled={busy || selected.length < 2 || !question.trim()}>{busy ? "Saving…" : "Start comparison"}</button>
      </div>
    </form>
  </Dialog>;
}

export function BookComparisonView({ message, onSave, onInspect }: {
  message: ResearchMessage & { comparison: NonNullable<ResearchMessage["comparison"]> };
  onSave: (text: string, sources: SourceRef[]) => void;
  onInspect?: (source: SourceRef) => void;
}) {
  const { comparison, sources } = message;
  const refs = (ids: string[]) => sources.filter(source => ids.includes(source.id));
  return <article className="book-comparison" aria-label="Book comparison">
    <header><Columns2 size={19} /><h3>{message.question}</h3></header>
    <div className="comparison-columns" style={{ "--comparison-count": comparison.columns.length } as React.CSSProperties}>
      {comparison.columns.map(column => <section key={column.bookId} aria-label={column.title}>
        <h4>{column.title}</h4>
        {column.answer && <p>{column.answer}</p>}
        {column.gap && <p className="comparison-gap">{column.gap}</p>}
        {refs(column.sourceIds).map(source => onInspect ? <button className="text-button comparison-evidence-link" key={source.id} title={sourceLabel(source)} onClick={() => onInspect(source)}>
          {source.locator?.type === "pdf" ? `Evidence on page ${source.locator.page}` : "Supporting passage"}
        </button> : <details key={source.id}>
          <summary>{source.locator?.type === "pdf" ? `Evidence on page ${source.locator.page}` : "Supporting passage"}</summary>
          <blockquote>{source.excerpt}</blockquote><SourceLink source={source} />
        </details>)}
        {column.answer && <button className="text-button" onClick={() => onSave(`${column.title}\n\n${column.answer}`, refs(column.sourceIds))}>Save finding</button>}
      </section>)}
    </div>
    <section className="comparison-synthesis">
      <h4>Agreement and differences</h4>
      <p>{comparison.synthesis.text}</p>
      {refs(comparison.synthesis.sourceIds).map(source => onInspect ? <button className="text-button comparison-evidence-link" key={source.id} onClick={() => onInspect(source)}>{sourceLabel(source)}</button> : <SourceLink key={source.id} source={source} />)}
    </section>
    <button className="text-button" onClick={() => onSave(comparisonText(comparison), refs([...comparison.columns.flatMap(column => column.sourceIds), ...comparison.synthesis.sourceIds]))}><NotebookPen size={16} />Save comparison</button>
  </article>;
}
