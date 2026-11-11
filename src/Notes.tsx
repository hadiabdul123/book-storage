import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Search, Download, Highlighter } from "lucide-react";
import { list } from "./db";
import { type Annotation, colors } from "./model";
import { AnnotationCard, EditAnnotation, Empty } from "./components";
import { exportAnnotations } from "./export";
export function Notes() {
  const annotations = useLiveQuery(() => list("annotation"), []) || [],
    books = useLiveQuery(() => list("book"), []) || [];
  const [query, setQuery] = useState(""),
    [bookId, setBookId] = useState(""),
    [color, setColor] = useState(""),
    [sort, setSort] = useState("newest"),
    [type, setType] = useState("all"),
    [editing, setEditing] = useState<Annotation>();
  const filtered = annotations
    .filter(
      (a) =>
        books.some((b) => b.id === a.bookId) &&
        (!bookId || a.bookId === bookId) &&
        (!color || a.color === color) &&
        (type === "all" || (a.type || "highlight") === type) &&
        `${a.text} ${a.note} ${a.locator.type === "pdf" ? a.locator.page : ""} ${a.tags.join(" ")} ${books.find((b) => b.id === a.bookId)?.title}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "oldest"
        ? a.createdAt.localeCompare(b.createdAt)
        : b.createdAt.localeCompare(a.createdAt),
    );
  return (
    <div className="notes-page">
      <header className="page-header">
        <div>
          <p className="page-kicker">Keep the good parts close</p>
          <h1>
            Highlights & notes
            <span className="count">
              {
                annotations.filter((a) => books.some((b) => b.id === a.bookId))
                  .length
              }
            </span>
          </h1>
        </div>
        <label className="export-select">
          <Download size={17} />
          <select
            aria-label="Export notes"
            value=""
            onChange={(e) => {
              if (e.target.value)
                exportAnnotations(
                  filtered,
                  books,
                  e.target.value as "md" | "csv" | "json",
                );
            }}
          >
            <option value="">Export</option>
            <option value="md">Markdown</option>
            <option value="csv">CSV</option>
            <option value="json">JSON backup</option>
          </select>
        </label>
      </header>
      <p className="page-intro">
        The passages you kept. The ideas you made your own.
      </p>
      <div className="filter-row">
        <select
          aria-label="Note type"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="all">All notes</option>
          <option value="highlight">Highlights</option>
          <option value="page-note">Page notes</option>
        </select>
        <label className="search-field">
          <Search size={18} />
          <input
            aria-label="Search annotations"
            placeholder="Search quotes, notes, or tags…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          aria-label="Filter by book"
          value={bookId}
          onChange={(e) => setBookId(e.target.value)}
        >
          <option value="">Every book</option>
          {books.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by highlight color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
        >
          <option value="">Every color</option>
          {Object.keys(colors).map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select
          aria-label="Sort notes"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>
      {filtered.length ? (
        <div className="annotations-grid">
          {filtered.map((a) => (
            <AnnotationCard
              key={a.id}
              annotation={a}
              book={books.find((b) => b.id === a.bookId)}
              onEdit={() => setEditing(a)}
            />
          ))}
        </div>
      ) : (
        <Empty
          icon={<Highlighter size={33} />}
          title={
            annotations.length
              ? "No matching annotations"
              : "A home for your favorite passages"
          }
        >
          <p>
            Highlight something as you read.
            <br />
            Your quotes and notes will be waiting here.
          </p>
        </Empty>
      )}
      {editing && (
        <EditAnnotation
          annotation={editing}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}
