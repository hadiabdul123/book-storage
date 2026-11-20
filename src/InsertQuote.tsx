import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Dialog } from "./components";
import { list } from "./db";
import type { SourceRef } from "./researchTypes";
import { sourceLabel, validSourceRef } from "./sourceReferences";
import "./insertQuote.css";

export function InsertQuote({ onClose, onInsert }: {
  onClose: () => void;
  onInsert: (text: string, source: SourceRef) => boolean;
}) {
  const [query, setQuery] = useState("");
  const [bookId, setBookId] = useState("");
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(40);
  const highlights = useLiveQuery(async () => {
    const [books, annotations] = await Promise.all([list("book"), list("annotation")]);
    const editions = new Map(books.map(book => [book.id, book]));
    return annotations.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).flatMap(annotation => {
      const book = editions.get(annotation.bookId);
      if (!book || annotation.type === "page-note" || !annotation.text.trim() || book.hash !== annotation.locator.hash) return [];
      const source: SourceRef = {
        id: annotation.id, kind: "book", title: book.title.slice(0, 1000), bookId: book.id,
        locator: annotation.locator, excerpt: annotation.text.slice(0, 20_000),
      };
      return validSourceRef(source) ? [{ source, text: annotation.text }] : [];
    });
  }, []);
  const books = new Map(highlights?.map(({ source }) => [source.bookId, source.title]));
  const needle = query.trim().toLowerCase();
  const matches = highlights?.filter(({ source, text }) =>
    (!bookId || source.bookId === bookId) && `${text} ${source.title}`.toLowerCase().includes(needle));

  return <Dialog title="Insert quote" onClose={onClose} wide>
    <div className="quote-picker-filters">
      <label>Search highlights<input autoFocus={matchMedia("(pointer: fine)").matches} type="search" value={query} onChange={event => { setQuery(event.target.value); setLimit(40); }} /></label>
      <label>Book<select value={bookId} onChange={event => { setBookId(event.target.value); setLimit(40); }}>
        <option value="">All books</option>
        {[...books].sort((a, b) => a[1].localeCompare(b[1])).map(([id, title]) => <option key={id} value={id}>{title}</option>)}
      </select></label>
    </div>
    {error && <p role="alert">{error}</p>}
    {!highlights ? <p role="status">Opening highlights…</p> : !matches?.length
      ? <p role="status">{highlights.length ? "No matching highlights." : "Highlight text in a book to find it here."}</p>
      : <ul className="quote-picker-list">{matches.slice(0, limit).map(({ source, text }) => <li key={source.id}>
        <button type="button" onClick={() => {
          if (!onInsert(text, source)) setError("The note changed while this picker was open. Close it and place your cursor again.");
        }}><small>{sourceLabel(source)}</small><span>{text}</span></button>
      </li>)}
        {matches.length > limit && <li><button type="button" onClick={() => setLimit(value => value + 40)}>Show more highlights</button></li>}
      </ul>}
  </Dialog>;
}
