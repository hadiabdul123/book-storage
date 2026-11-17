import { lazy, Suspense, useState } from "react";
import { Link } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { Search, Download, Highlighter } from "lucide-react";
import { list } from "./db";
import { type Annotation, colors } from "./model";
import { AnnotationCard, EditAnnotation, Empty } from "./components";
import { exportAnnotations } from "./export";
import type { InkStroke } from "./inkTypes";
import "./notesBrowser.css";
const InkPreview = lazy(() => import("./InkPreview").then(m => ({ default: m.InkPreview })));
export function Notes() {
  const annotations = useLiveQuery(() => list("annotation"), []) || [],
    books = useLiveQuery(() => list("book"), []) || [];
  const ink = useLiveQuery(() => list("ink-stroke"), []) || [];
  const notebookPages = useLiveQuery(() => list("notebook-note"), []) || [];
  const notebooks = useLiveQuery(() => list("notebook"), []) || [];
  const [selected, setSelected] = useState("");
  const [tag, setTag] = useState("");
  const [detail, setDetail] = useState(false);
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
        (!tag || a.tags.includes(tag)) &&
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
  const drawingGroups = new Map<string, { title: string; subtitle: string; href: string; strokes: InkStroke[] }>();
  for (const s of ink) {
    const t = s.target;
    if (t.type === "pdf") {
      const book = books.find(b => b.id === t.bookId); if (!book || book.hash !== t.hash || bookId && bookId !== book.id) continue;
      const key = `drawing:${book.id}:${t.page}`;
      if (!drawingGroups.has(key)) drawingGroups.set(key, { title: book.title, subtitle: `Drawing on page ${t.page}`, href: `/read/${book.id}?source=${encodeURIComponent(JSON.stringify({ v: 1, type: "pdf", hash: t.hash, page: t.page, y: 0 }))}`, strokes: [] });
      drawingGroups.get(key)!.strokes.push(s);
    } else if (!bookId) {
      const note = notebookPages.find(n => n.id === t.noteId), notebook = note && notebooks.find(n => n.id === note.notebookId);
      if (!note || !notebook || !JSON.stringify(note.document).includes(t.blockId)) continue;
      const key = `drawing:${note.id}:${t.blockId}`;
      if (!drawingGroups.has(key)) drawingGroups.set(key, { title: notebook.title, subtitle: `Drawing · ${note.title}`, href: `/notebooks?note=${note.id}`, strokes: [] });
      drawingGroups.get(key)!.strokes.push(s);
    }
  }
  const drawings = [...drawingGroups].filter(([, d]) => !color && !tag && `${d.title} ${d.subtitle}`.toLowerCase().includes(query.toLowerCase()));
  const rows = [...filtered.map(a => ({ id: a.id, title: books.find(b => b.id === a.bookId)?.title || "Book", subtitle: a.locator.type === "pdf" ? `Page ${a.locator.page}` : a.locator.type === "epub" ? "Book passage" : "Document passage", text: a.text || a.note, color: colors[a.color], annotation: a, drawing: undefined as typeof drawings[number][1] | undefined })), ...(type === "all" || type === "drawing" ? drawings.map(([id, d]) => ({ id, title: d.title, subtitle: d.subtitle, text: "Handwritten notes and marks", color: "#315c86", annotation: undefined, drawing: d })) : [])];
  const active = rows.find(r => r.id === selected) || rows[0];
  const grouped = [...new Set(rows.map(r => r.title))];
  return (
    <div className={`notes-page notes-browser ${detail ? "notes-detail-open" : ""}`}>
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
              if (e.target.value && type === "drawing") { void import("./researchBackup").then(m => m.exportInkBackup(drawings.flatMap(([, d]) => d.strokes))); return; }
              if (e.target.value)
                exportAnnotations(
                  filtered,
                  books,
                  e.target.value as "md" | "csv" | "json",
                  type === "all" ? drawings.flatMap(([, d]) => d.strokes).filter(s => s.target.type === "pdf") : [],
                );
            }}
          >
            <option value="">Export</option>
            <option value="md" disabled={type === "drawing"}>Markdown</option>
            <option value="csv" disabled={type === "drawing"}>CSV</option>
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
          <option value="drawing">Drawings</option>
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
        <select aria-label="Filter by tag" value={tag} onChange={e => setTag(e.target.value)}><option value="">Every tag</option>{[...new Set(annotations.flatMap(a => a.tags))].sort().map(t => <option key={t}>{t}</option>)}</select>
      </div>
      {rows.length ? (
        <div className="notes-browser-layout">
          <nav className="notes-passage-list" aria-label="Saved passages and drawings"><p className="notes-result-count">{rows.length} saved {rows.length === 1 ? "item" : "items"}</p>{grouped.map(title => <section key={title}><h2>{title}</h2>{rows.filter(r => r.title === title).map(r => <button key={r.id} aria-current={active?.id === r.id ? "page" : undefined} style={{ borderLeftColor: r.color }} onClick={() => { setSelected(r.id); setDetail(true); }}><small>{r.subtitle}</small><span>{r.text.slice(0, 150)}</span>{r.annotation?.note && <em>{r.annotation.note.slice(0, 80)}</em>}</button>)}</section>)}</nav>
          <div className="notes-preview-pane"><button className="text-button notes-back-list" onClick={() => setDetail(false)}>Back to saved items</button>
          {filtered.map((a) => (
            <div key={a.id} hidden={active?.id !== a.id}>
            <AnnotationCard
              annotation={a}
              book={books.find((b) => b.id === a.bookId)}
              onEdit={() => setEditing(a)}
            />
            </div>
          ))}
          {active?.drawing && <article className="drawing-detail"><h2>{active.title}</h2><p>{active.subtitle}</p><Suspense fallback={<p>Opening drawing preview…</p>}><InkPreview strokes={active.drawing.strokes} /></Suspense><Link className="primary" to={active.drawing.href}>Open drawing</Link><p className="muted">Use Draw to edit or erase strokes. Drawings sync with your library.</p></article>}
          </div>
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
