import { lazy, Suspense, useMemo, useState } from "react";
import { BrowsePages, SourceNavigator, pageOf, useBrowseState } from "./browse";
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
  const browse = useBrowseState();
  const selected = browse.value("item");
  const query = browse.value("q"), bookId = browse.value("book"), notebookSource = browse.value("notebook"), color = browse.value("color"), sort = browse.value("sort", "newest"), type = browse.value("type", "all"), tag = browse.value("tag");
  const change = (key: string, value: string) => browse.update({ [key]: value, page: "1" });
  const setQuery = (v: string) => change("q", v), setBookId = (v: string) => browse.update({ book: v, notebook: "", page: "1", item: "" }), setColor = (v: string) => change("color", v), setSort = (v: string) => change("sort", v), setType = (v: string) => change("type", v), setTag = (v: string) => change("tag", v);
  const [editing, setEditing] = useState<Annotation>();
  const bookMap = useMemo(() => new Map(books.map(b => [b.id, b])), [books]);
  const filtered = annotations
    .filter(
      (a) =>
        bookMap.has(a.bookId) &&
        (!bookId || a.bookId === bookId) &&
        (!color || a.color === color) &&
        (!tag || a.tags.includes(tag)) &&
        (type === "all" || (a.type || "highlight") === type) &&
        `${a.text} ${a.note} ${a.locator.type === "pdf" ? a.locator.page : ""} ${a.tags.join(" ")} ${bookMap.get(a.bookId)?.title}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "oldest"
        ? a.createdAt.localeCompare(b.createdAt)
        : b.createdAt.localeCompare(a.createdAt),
    );
  const drawingGroups = new Map<string, { sourceId: string; title: string; subtitle: string; href: string; strokes: InkStroke[] }>();
  for (const s of ink) {
    const t = s.target;
    if (t.type === "pdf") {
      const book = bookMap.get(t.bookId); if (!book || book.hash !== t.hash) continue;
      const key = `drawing:${book.id}:${t.page}`;
      if (!drawingGroups.has(key)) drawingGroups.set(key, { sourceId: `book:${book.id}`, title: book.title, subtitle: `Drawing on page ${t.page}`, href: `/read/${book.id}?source=${encodeURIComponent(JSON.stringify({ v: 1, type: "pdf", hash: t.hash, page: t.page, y: 0 }))}`, strokes: [] });
      drawingGroups.get(key)!.strokes.push(s);
    } else {
      const note = notebookPages.find(n => n.id === t.noteId), notebook = note && notebooks.find(n => n.id === note.notebookId);
      if (!note || !notebook || !JSON.stringify(note.document).includes(t.blockId)) continue;
      const key = `drawing:${note.id}:${t.blockId}`;
      if (!drawingGroups.has(key)) drawingGroups.set(key, { sourceId: `notebook:${notebook.id}`, title: notebook.title, subtitle: `Drawing · ${note.title}`, href: `/notebooks?note=${note.id}`, strokes: [] });
      drawingGroups.get(key)!.strokes.push(s);
    }
  }
  const drawings = [...drawingGroups].filter(([, d]) => !color && !tag && (!bookId || d.sourceId === `book:${bookId}`) && (!notebookSource || d.sourceId === `notebook:${notebookSource}`) && `${d.title} ${d.subtitle}`.toLowerCase().includes(query.toLowerCase()));
  const rows = [...(notebookSource ? [] : filtered).map(a => ({ id: a.id, sourceId: `book:${a.bookId}`, title: bookMap.get(a.bookId)?.title || "Book", subtitle: a.locator.type === "pdf" ? `Page ${a.locator.page}` : a.locator.type === "epub" ? "Book passage" : "Document passage", text: a.text || a.note, color: colors[a.color], annotation: a, drawing: undefined as typeof drawings[number][1] | undefined })), ...(type === "all" || type === "drawing" ? drawings.map(([id, d]) => ({ id, sourceId: d.sourceId, title: d.title, subtitle: d.subtitle, text: "Handwritten notes and marks", color: "#315c86", annotation: undefined, drawing: d })) : [])];
  const page = pageOf(rows, browse.value("page"));
  const active = rows.find(r => r.id === selected) || page.items[0];
  const detail = !!selected && !!active;
  const grouped = [...new Set(page.items.map(r => r.sourceId))];
  const drawingCount = (id: string) => [...drawingGroups.values()].filter(d => d.sourceId === id).length;
  const sourceItems = [...books.map(b => ({ id: `book:${b.id}`, title: b.title, detail: b.author, count: annotations.filter(a => a.bookId === b.id).length + drawingCount(`book:${b.id}`) })), ...notebooks.map(n => ({ id: `notebook:${n.id}`, title: n.title, detail: "Notebook drawings", count: drawingCount(`notebook:${n.id}`) }))];
  return (
    <div className={`notes-page notes-browser ${detail ? "notes-detail-open" : ""}`}>
      <header className="page-header">
        <div>
          <p className="page-kicker">Keep the good parts close</p>
          <h1>
            Highlights & notes
            <span className="count">
              {
                annotations.filter((a) => bookMap.has(a.bookId))
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
              if (e.target.value && (type === "drawing" || !!notebookSource)) { void import("./researchBackup").then(m => m.exportInkBackup(drawings.flatMap(([, d]) => d.strokes))); return; }
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
            <option value="md" disabled={type === "drawing" || !!notebookSource}>Markdown</option>
            <option value="csv" disabled={type === "drawing" || !!notebookSource}>CSV</option>
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
      <div className="filter-summary"><span>{rows.length} matching saved items</span>{(query || bookId || notebookSource || color || tag || type !== "all") && <button onClick={() => browse.update({ q: "", book: "", notebook: "", color: "", tag: "", type: "", page: "1", item: "" })}>Clear filters</button>}</div>
      <div className="source-layout"><SourceNavigator label="Books & notebooks" value={bookId ? `book:${bookId}` : notebookSource ? `notebook:${notebookSource}` : ""} items={sourceItems} onChange={id => browse.update({ book: id.startsWith("book:") ? id.slice(5) : "", notebook: id.startsWith("notebook:") ? id.slice(9) : "", page: "1", item: "" })} /><div>
      {rows.length ? (
        <div className="notes-browser-layout">
          <nav className="notes-passage-list" aria-label="Saved passages and drawings"><p className="notes-result-count">{rows.length} saved {rows.length === 1 ? "item" : "items"}</p>{grouped.map(source => <section key={source}><h2>{page.items.find(r => r.sourceId === source)?.title}</h2>{page.items.filter(r => r.sourceId === source).map(r => <button key={r.id} aria-current={active?.id === r.id ? "page" : undefined} style={{ borderLeftColor: r.color }} onClick={() => browse.update({ item: r.id }, false)}><small>{r.subtitle}</small><span>{r.text.slice(0, 150)}</span>{r.annotation?.note && <em>{r.annotation.note.slice(0, 80)}</em>}</button>)}</section>)}</nav>
          <div className="notes-preview-pane"><button className="text-button notes-back-list" onClick={() => browse.update({ item: "" })}>Back to saved items</button>
          {active?.annotation && <AnnotationCard annotation={active.annotation} book={bookMap.get(active.annotation.bookId)} onEdit={() => setEditing(active.annotation)} />}
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
      <BrowsePages {...page} label="Items" onChange={n => browse.update({ page: String(n), item: "" })} /></div></div>
      {editing && (
        <EditAnnotation
          annotation={editing}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}
