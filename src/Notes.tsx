import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BrowsePages, SourceNavigator, pageOf, useBrowseState } from "./browse";
import { Link, useNavigate } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { Search, Download, Highlighter, Copy, FileText } from "lucide-react";
import { list, save } from "./db";
import { type Annotation, type Locator, colors, now, uid } from "./model";
import { AnnotationCard, EditAnnotation, Empty } from "./components";
import { exportAnnotations } from "./export";
import type { InkStroke } from "./inkTypes";
import { ItemMenu, type ItemAction } from "./ItemMenu";
import { EditHighlightTags, HighlightFollowups, HighlightLabels } from "./HighlightStudyPanel";
import { highlightStudyData, priorities, setHighlightPriority, type HighlightFollowup, type HighlightPriority } from "./highlightStudy";
import "./notesBrowser.css";
const InkPreview = lazy(() => import("./InkPreview").then(m => ({ default: m.InkPreview })));
const PdfPreview = lazy(() => import("./HighlightPdfPreview").then(m => ({ default: m.HighlightPdfPreview })));
function PdfPreviewOverlay({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => { element.close(); previous?.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className="dialog notes-pdf-dialog" aria-label="Source PDF page" onCancel={event => {
    event.preventDefault(); onClose();
  }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>{children}</dialog>;
}
function readingOrder(a: Locator, b: Locator) {
  if (a.type === "pdf" && b.type === "pdf") return a.page - b.page ||
    (b.regions?.[0]?.rects[0]?.[3] ?? b.point?.[1] ?? -b.y) - (a.regions?.[0]?.rects[0]?.[3] ?? a.point?.[1] ?? -a.y);
  if (a.type === "epub" && b.type === "epub") return a.cfi.localeCompare(b.cfi, undefined, { numeric: true });
  if (a.type === "docx" && b.type === "docx") return a.start - b.start;
  return 0;
}
export function Notes() {
  const annotations = useLiveQuery(() => list("annotation"), []) || [],
    books = useLiveQuery(() => list("book"), []) || [];
  const ink = useLiveQuery(() => list("ink-stroke"), []) || [];
  const overlays = useLiveQuery(() => list("notebook-overlay"), []) || [];
  const notebookPages = useLiveQuery(() => list("notebook-note"), []) || [];
  const notebooks = useLiveQuery(() => list("notebook"), []) || [];
  const study = useLiveQuery(highlightStudyData, []);
  const browse = useBrowseState();
  const navigate = useNavigate();
  const selected = browse.value("item");
  const query = browse.value("q"), bookId = browse.value("book"), notebookSource = browse.value("notebook"), color = browse.value("color"), sort = browse.value("sort", "newest"), type = browse.value("type", "all"), tag = browse.value("tag");
  const priority = browse.value("priority");
  const change = (key: string, value: string) => browse.update({ [key]: value, page: "1" });
  const setQuery = (v: string) => change("q", v), setBookId = (v: string) => browse.update({ book: v, notebook: "", page: "1", item: "" }), setColor = (v: string) => change("color", v), setSort = (v: string) => change("sort", v), setType = (v: string) => change("type", v), setTag = (v: string) => change("tag", v);
  const [editing, setEditing] = useState<Annotation>();
  const [editingTags, setEditingTags] = useState<string>();
  const [pdfItem, setPdfItem] = useState("");
  const [canDockPdf, setCanDockPdf] = useState(false);
  const [previewPane, setPreviewPane] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!previewPane) return;
    const observer = new ResizeObserver(([entry]) => setCanDockPdf(entry.contentRect.width >= 960));
    observer.observe(previewPane);
    return () => observer.disconnect();
  }, [previewPane]);
  const pdfTrigger = useRef<HTMLButtonElement>(null);
  const closePdf = () => { setPdfItem(""); requestAnimationFrame(() => pdfTrigger.current?.focus({ preventScroll: true })); };
  const [actionError, setActionError] = useState("");
  const [clipboard, setClipboard] = useState("");
  const bookMap = useMemo(() => new Map(books.map(b => [b.id, b])), [books]);
  const priorityMap = useMemo(() => new Map(study?.study.map(item => [item.id, item.priority])), [study]);
  const followupMap = useMemo(() => {
    const map = new Map<string, HighlightFollowup[]>();
    for (const note of study?.followups || []) {
      if (!map.has(note.annotationId)) map.set(note.annotationId, []);
      map.get(note.annotationId)!.push(note);
    }
    for (const notes of map.values()) notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return map;
  }, [study]);
  function studyActions(annotation: Annotation): ItemAction[] {
    const changePriority = (next?: HighlightPriority) => {
      setActionError("");
      void setHighlightPriority(annotation.id, next).catch(error => setActionError(error.message));
    };
    return [
      { label: "Research this highlight", run: () => {
        const id = uid();
        void save("research-thread", { id, title: annotation.text.slice(0, 100).trim() || "Highlight research", bookId: annotation.bookId,
          scope: { bookIds: [], noteIds: [], highlightIds: [annotation.id] }, createdAt: now() })
          .then(() => navigate(`/notebooks?view=research&thread=${encodeURIComponent(id)}`), error => setActionError(error.message));
      } },
      { label: "Edit tags", run: () => setEditingTags(annotation.id) },
      { label: "Mark important", disabled: priorityMap.get(annotation.id) === "important", run: () => changePriority("important") },
      { label: "Mark lower priority", disabled: priorityMap.get(annotation.id) === "lower", run: () => changePriority("lower") },
      { label: "Clear priority", disabled: !priorityMap.has(annotation.id), run: () => changePriority() },
    ];
  }
  const filtered = annotations
    .filter(
      (a) =>
        bookMap.has(a.bookId) &&
        (!bookId || a.bookId === bookId) &&
        (!color || a.color === color) &&
        (!tag || a.tags.includes(tag)) &&
        (!priority || (a.type !== "page-note" && (priority === "unmarked" ? !priorityMap.has(a.id) : priorityMap.get(a.id) === priority))) &&
        (type === "all" || (a.type || "highlight") === type) &&
        `${a.text} ${a.note} ${a.locator.type === "pdf" ? a.locator.page : ""} ${a.tags.join(" ")} ${bookMap.get(a.bookId)?.title} ${followupMap.get(a.id)?.map(note => note.text).join(" ") || ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "reading" ? (bookMap.get(a.bookId)?.title || "").localeCompare(bookMap.get(b.bookId)?.title || "") || a.bookId.localeCompare(b.bookId) || readingOrder(a.locator, b.locator) : sort === "oldest"
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
      const overlay = overlays.some(d => d.id === t.blockId && d.noteId === t.noteId);
      if (!note || !notebook || (!overlay && !JSON.stringify(note.document).includes(t.blockId))) continue;
      const key = `drawing:${note.id}:${t.blockId}`;
      if (!drawingGroups.has(key)) drawingGroups.set(key, { sourceId: `notebook:${notebook.id}`, title: notebook.title, subtitle: `Drawing · ${note.title}`, href: `/notebooks?note=${encodeURIComponent(note.id)}${overlay ? `&drawing=${encodeURIComponent(t.blockId)}` : ""}`, strokes: [] });
      drawingGroups.get(key)!.strokes.push(s);
    }
  }
  const drawings = [...drawingGroups].filter(([, d]) => !color && !tag && !priority && (!bookId || d.sourceId === `book:${bookId}`) && (!notebookSource || d.sourceId === `notebook:${notebookSource}`) && `${d.title} ${d.subtitle}`.toLowerCase().includes(query.toLowerCase()));
  const rows = [...(notebookSource ? [] : filtered).map(a => ({ id: a.id, sourceId: `book:${a.bookId}`, title: bookMap.get(a.bookId)?.title || "Book", subtitle: a.locator.type === "pdf" ? `Page ${a.locator.page}` : a.locator.type === "epub" ? "Book passage" : "Document passage", text: a.text || a.note, color: colors[a.color], annotation: a, drawing: undefined as typeof drawings[number][1] | undefined })), ...(type === "all" || type === "drawing" ? drawings.map(([id, d]) => ({ id, sourceId: d.sourceId, title: d.title, subtitle: d.subtitle, text: "Handwritten notes and marks", color: "#315c86", annotation: undefined, drawing: d })) : [])];
  const page = pageOf(rows, browse.value("page"));
  const active = rows.find(r => r.id === selected) || page.items[0];
  const activeAnnotation = active?.annotation;
  const activeBook = activeAnnotation && bookMap.get(activeAnnotation.bookId);
  const previewLocator = activeAnnotation?.locator.type === "pdf" && activeBook?.hash === activeAnnotation.locator.hash ? activeAnnotation.locator : undefined;
  const previewOpen = !!previewLocator && !!active && pdfItem === active.id;
  const pdf = previewOpen && activeBook && previewLocator && <Suspense fallback={<div className="pdf-preview-loading"><p role="status">Opening PDF preview…</p><button className="text-button" onClick={closePdf}>Close PDF page</button></div>}><PdfPreview key={active.id} book={activeBook} locator={previewLocator} onClose={closePdf} /></Suspense>;
  const tagsAnnotation = annotations.find(annotation => annotation.id === editingTags);
  useEffect(() => { setPdfItem(""); setClipboard(""); }, [active?.id]);
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
            onChange={async (e) => {
              if (e.target.value && (type === "drawing" || !!notebookSource)) { void import("./researchBackup").then(m => m.exportInkBackup(drawings.flatMap(([, d]) => d.strokes))); return; }
              const format = e.target.value as "" | "md" | "csv" | "json";
              if (format)
                exportAnnotations(
                  filtered,
                  books,
                  format,
                  type === "all" ? drawings.flatMap(([, d]) => d.strokes).filter(s => s.target.type === "pdf") : [],
                  study,
                  format === "json" && type === "all" && !color && !tag && !priority
                    ? (await list("pdf-text-box")).filter(box =>
                      (!bookId || box.bookId === bookId) && box.text.toLowerCase().includes(query.trim().toLowerCase()))
                    : [],
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
          <option value="reading">Reading order</option>
          <option value="oldest">Oldest first</option>
        </select>
        <select aria-label="Filter by tag" value={tag} onChange={e => setTag(e.target.value)}><option value="">Every tag</option>{[...new Set(annotations.flatMap(a => a.tags))].sort().map(t => <option key={t}>{t}</option>)}</select>
        <select aria-label="Filter by priority" value={priority} onChange={e => change("priority", e.target.value)}>
          <option value="">Every priority</option>{Object.entries(priorities).map(([id, label]) => <option key={id} value={id}>{label}</option>)}<option value="unmarked">Unmarked highlights</option>
        </select>
      </div>
      <div className="filter-summary"><span>{rows.length} matching saved items</span>{(query || bookId || notebookSource || color || tag || priority || type !== "all") && <button onClick={() => browse.update({ q: "", book: "", notebook: "", color: "", tag: "", priority: "", type: "", page: "1", item: "" })}>Clear filters</button>}</div>
      {actionError && <p role="alert">{actionError}</p>}
      <div className="source-layout"><SourceNavigator label="Books & notebooks" value={bookId ? `book:${bookId}` : notebookSource ? `notebook:${notebookSource}` : ""} items={sourceItems} onChange={id => browse.update({ book: id.startsWith("book:") ? id.slice(5) : "", notebook: id.startsWith("notebook:") ? id.slice(9) : "", page: "1", item: "" })} /><div>
      {rows.length ? (
        <div className="notes-browser-layout">
          <nav className="notes-passage-list" aria-label="Saved passages and drawings"><p className="notes-result-count">{rows.length} saved {rows.length === 1 ? "item" : "items"}</p>{grouped.map(source => <section key={source}><h2>{page.items.find(r => r.sourceId === source)?.title}</h2>{page.items.filter(r => r.sourceId === source).map(r => {
            const open = <button key={r.id} className="notes-passage-open" aria-current={active?.id === r.id ? "page" : undefined} style={{ borderLeftColor: r.color }} onClick={() => { setPdfItem(""); setClipboard(""); browse.update({ item: r.id }, false); }}><small>{r.subtitle}</small>
              {r.annotation && <HighlightLabels tags={r.annotation.tags} priority={priorityMap.get(r.id)} />}
              <span className="notes-passage-text">{r.text.slice(0, 150)}</span>{r.annotation?.note && <em>{r.annotation.note.slice(0, 80)}</em>}
            </button>;
            return r.annotation && r.annotation.type !== "page-note" ? <ItemMenu key={r.id} title={r.text.slice(0, 75) || "highlight"} actions={studyActions(r.annotation)}>{open}</ItemMenu> : open;
          })}</section>)}</nav>
          <div className="notes-preview-pane" ref={setPreviewPane}><button className="text-button notes-back-list" onClick={() => { setPdfItem(""); browse.update({ item: "" }); }}>Back to saved items</button>
          {active && activeAnnotation && <><div className="notes-reference-bar"><strong>{active.title}</strong><span>{active.subtitle}</span><button className="text-button" onClick={async () => {
            try {
              const url = new URL(location.href); url.search = "";
              url.hash = `/read/${encodeURIComponent(active.annotation!.bookId)}?annotation=${encodeURIComponent(active.id)}`;
              await navigator.clipboard.writeText(`${active.annotation!.text || active.annotation!.note}\n\n${active.title}, ${active.subtitle}\n${url.href}`);
              setClipboard("Copied quote and source.");
            } catch { setClipboard("Clipboard unavailable. You can select and copy the quote."); }
          }}><Copy size={15} />Copy quote and source</button>{previewLocator && <button ref={pdfTrigger} className="text-button show-highlight-pdf" aria-expanded={previewOpen} onClick={() => previewOpen ? closePdf() : setPdfItem(active.id)}><FileText size={16} />Show PDF page</button>}
          {activeAnnotation.type !== "page-note" && <ItemMenu title="selected highlight" actions={studyActions(activeAnnotation)}>{null}</ItemMenu>}</div>
          {clipboard && <small role="status">{clipboard}</small>}
          <div className={previewOpen && canDockPdf ? "highlight-study-layout with-pdf-preview" : "highlight-study-layout"}>
            <div className="highlight-study-detail">
              <HighlightLabels tags={activeAnnotation.tags} priority={priorityMap.get(active.id)} />
              <AnnotationCard annotation={activeAnnotation} book={activeBook} showTags={false} onEdit={() => setEditing(activeAnnotation)} />
              {activeAnnotation.type !== "page-note" && <HighlightFollowups key={active.id} annotationId={active.id} notes={followupMap.get(active.id) || []} />}
            </div>
            {pdf && (canDockPdf ? pdf : <PdfPreviewOverlay onClose={closePdf}>{pdf}</PdfPreviewOverlay>)}
          </div></>}
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
      {tagsAnnotation && <EditHighlightTags key={tagsAnnotation.id} annotationId={tagsAnnotation.id} tags={tagsAnnotation.tags} onClose={() => setEditingTags(undefined)} />}
    </div>
  );
}
