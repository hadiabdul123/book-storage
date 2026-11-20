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
import { CardCategories } from "./CardCategories";
import { cardLibrary, emptyCards } from "./cardStore";
import { sourceHref, sourceLabel } from "./sourceReferences";
import { SourceLink } from "./Citation";
import { Dialog } from "./components";
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
  const library = useLiveQuery(cardLibrary, []) || emptyCards;
  const category = browse.value("category");
  const categoryMap = useMemo(() => {
    const map = new Map<string, string[]>();
    const ids = new Set(library.categories.map(c => c.id));
    for (const f of library.filings) if (ids.has(f.categoryId)) map.set(f.cardId, [...(map.get(f.cardId) || []), f.categoryId]);
    return map;
  }, [library]);
  const fitsCategory = (id: string) => !category || (category === "unfiled" ? !categoryMap.has(id) : categoryMap.get(id)?.includes(category));
  const [filing, setFiling] = useState<string[]>();
  const [bulk, setBulk] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [opened, setOpened] = useState("");
  const [origin, setOrigin] = useState<HTMLElement | null>(null);
  useEffect(() => { setChecked([]); }, [query, bookId, notebookSource, color, tag, type, category, browse.value("priority")]);
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
      { label: "Categories", run: () => setFiling([annotation.id]) },
      { label: "Edit tags", run: () => setEditingTags(annotation.id) },
      { label: "Mark important", disabled: priorityMap.get(annotation.id) === "important", run: () => changePriority("important") },
      { label: "Mark lower priority", disabled: priorityMap.get(annotation.id) === "lower", run: () => changePriority("lower") },
      { label: "Clear priority", disabled: !priorityMap.has(annotation.id), run: () => changePriority() },
    ];
  }
  const filtered = annotations
    .filter(
      (a) =>
        fitsCategory(a.id) && (!category || a.type !== "page-note") && bookMap.has(a.bookId) &&
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
  const drawings = [...drawingGroups].filter(([, d]) => !category && !color && !tag && !priority && (!bookId || d.sourceId === `book:${bookId}`) && (!notebookSource || d.sourceId === `notebook:${notebookSource}`) && `${d.title} ${d.subtitle}`.toLowerCase().includes(query.toLowerCase()));
  const researchCards = library.cards.filter(c => fitsCategory(c.id) && !notebookSource && !priority && !tag && !color && (!bookId || c.sources.some(s => s.bookId === bookId))
    && ["all","research"].includes(type) && (c.text + " " + c.sources.map(s => s.title).join(" ")).toLowerCase().includes(query.toLowerCase()))
    .sort((a,b) => sort === "oldest" ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt));
  const rows = [...researchCards.map(c => ({ id: c.id, title: c.kind === "quote" ? "Saved quotation" : "Research note", sourceId: "research", subtitle: c.sources[0]?.title || "Research", text: c.text, color: "#839975", annotation: undefined, drawing: undefined })),...(notebookSource ? [] : filtered).map(a => ({ id: a.id, sourceId: `book:${a.bookId}`, title: bookMap.get(a.bookId)?.title || "Book", subtitle: a.locator.type === "pdf" ? `Page ${a.locator.page}` : a.locator.type === "epub" ? "Book passage" : "Document passage", text: a.text || a.note, color: colors[a.color], annotation: a, drawing: undefined as typeof drawings[number][1] | undefined })), ...(type === "all" || type === "drawing" ? drawings.map(([id, d]) => ({ id, sourceId: d.sourceId, title: d.title, subtitle: d.subtitle, text: "Handwritten notes and marks", color: "#315c86", annotation: undefined, drawing: d })) : [])];
  const cards = rows.filter(r => !r.drawing && r.annotation?.type !== "page-note");
  const cardIndex = cards.findIndex(r => r.id === opened);
  const openCard = cards[cardIndex];
  const researchCard = researchCards.find(c => c.id === opened);
  function closeCard() { setOpened(""); requestAnimationFrame(() => origin?.focus({ preventScroll: true })); }
  const page = pageOf(rows, browse.value("page"));
  const active = openCard || rows.find(r => r.id === selected) || page.items[0];
  const activeAnnotation = active?.annotation;
  const activeBook = activeAnnotation && bookMap.get(activeAnnotation.bookId);
  const previewLocator = activeAnnotation?.locator.type === "pdf" && activeBook?.hash === activeAnnotation.locator.hash ? activeAnnotation.locator : undefined;
  const previewOpen = !!previewLocator && !!active && pdfItem === active.id;
  const pdf = previewOpen && activeBook && previewLocator && <Suspense fallback={<div className="pdf-preview-loading"><p role="status">Opening PDF preview…</p><button className="text-button" onClick={closePdf}>Close PDF page</button></div>}><PdfPreview key={active.id} color={active.color} book={activeBook} locator={previewLocator} onClose={closePdf} /></Suspense>;
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
          <h1>
            Highlights & notes
            <span className="count">
              {
                annotations.filter((a) => bookMap.has(a.bookId)).length + library.cards.length
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
                  format === "json" ? { ...library, cards: researchCards } : undefined,
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
      <div className="filter-row">
        <select
          aria-label="Note type"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="all">All notes</option>
          <option value="highlight">Highlights</option>
          <option value="page-note">Page notes</option>
          <option value="research">Research cards</option>
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
        <details className="card-filters"><summary>More filters</summary><div>
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
        </div></details>
      </div>
      <div className="filter-summary"><span>{rows.length} matching saved items</span>{(category || query || bookId || notebookSource || color || tag || priority || type !== "all") && <button onClick={() => browse.update({ q: "", book: "", notebook: "", color: "", tag: "", priority: "", category: "", type: "", page: "1", item: "" })}>Clear filters</button>}</div>
      {actionError && <p role="alert">{actionError}</p>}
      <div className="card-collection-actions"><button className="secondary" onClick={() => { setBulk(!bulk); setChecked([]); }}>{bulk ? "Finish selection" : "Select cards"}</button>
        {bulk && <><button onClick={() => setChecked([...new Set([...checked, ...page.items.filter(r => !r.drawing && r.annotation?.type !== "page-note").map(r => r.id)])])}>Select page</button>
        <button disabled={!checked.length} onClick={() => setFiling(checked)}>File selected ({checked.length})</button></>}
      </div>
      <div className="source-layout"><aside className="card-sources"><details open><summary>Categories</summary><nav aria-label="Categories">
        {[{ id: "", name: "All highlights & notes" }, { id: "unfiled", name: "Unfiled" }, ...library.categories].map(c => <button key={c.id} aria-current={category === c.id ? "page" : undefined} onClick={() => browse.update({ category:c.id, page:"1", item:"" })}>{c.name}</button>)}
        <button className="text-button" onClick={() => setFiling([])}>Add or manage categories</button></nav></details>
        <SourceNavigator label="Books & notebooks" value={bookId ? `book:${bookId}` : notebookSource ? `notebook:${notebookSource}` : ""} items={sourceItems} onChange={id => browse.update({ book: id.startsWith("book:") ? id.slice(5) : "", notebook: id.startsWith("notebook:") ? id.slice(9) : "", page: "1", item: "" })} /></aside><div>
      {rows.length ? (
        <div className="notes-browser-layout">
          <nav className="notes-passage-list" aria-label="Saved passages and drawings"><p className="notes-result-count">{rows.length} saved {rows.length === 1 ? "item" : "items"}</p>{grouped.map(source => <section key={source}><h2>{page.items.find(r => r.sourceId === source)?.title}</h2>{page.items.filter(r => r.sourceId === source).map(r => {
            const open = <button key={r.id} className="notes-passage-open" aria-current={active?.id === r.id ? "page" : undefined} style={{ borderLeftColor: r.color }} aria-pressed={bulk ? checked.includes(r.id) : undefined} onClick={e => {
              if (!r.drawing && r.annotation?.type !== "page-note") {
                if (bulk) { setChecked(ids => ids.includes(r.id) ? ids.filter(id => id !== r.id) : [...ids,r.id]); return; }
                setOrigin(e.currentTarget); setOpened(r.id);
              } else browse.update({ item:r.id },false);
              setPdfItem(""); setClipboard("");
            }}><small>{r.subtitle}</small>
              {r.annotation && <HighlightLabels tags={r.annotation.tags} priority={priorityMap.get(r.id)} />}
              {categoryMap.has(r.id) && <small>{library.categories.filter(c => categoryMap.get(r.id)?.includes(c.id)).map(c => c.name).join(" · ")}</small>}
              <span className="notes-passage-text">{r.text.slice(0, 150)}</span>{r.annotation?.note && <em>{r.annotation.note.slice(0, 80)}</em>}
            </button>;
            return r.annotation && r.annotation.type !== "page-note" ? <ItemMenu key={r.id} title={r.text.slice(0, 75) || "highlight"} actions={studyActions(r.annotation)}>{open}</ItemMenu> : open;
          })}</section>)}</nav>
          <div className="notes-preview-pane" ref={setPreviewPane}><button className="text-button notes-back-list" onClick={() => { setPdfItem(""); browse.update({ item: "" }); }}>Back to saved items</button>
          {!openCard && active && activeAnnotation && <><div className="notes-reference-bar"><strong>{active.title}</strong><span>{active.subtitle}</span><button className="text-button" onClick={async () => {
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
          {!openCard && active && researchCards.some(c => c.id === active.id) && <article className="paper-quote"><header>{active.title}</header>
            <blockquote>{active.text}</blockquote><button className="secondary" onClick={e => { setOrigin(e.currentTarget); setOpened(active.id); }}>Open card</button></article>}
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
      {openCard && <Dialog title={researchCard?.kind === "finding" ? "Research note" : "Quote card"} onClose={closeCard} wide>
        <article className="paper-quote"><header><strong>{researchCard ? researchCard.sources[0]?.title : openCard.title}</strong>
          <span>{researchCard ? researchCard.sources.length + (researchCard.sources.length === 1 ? " source" : " sources") : openCard.subtitle}</span></header>
          {openCard.annotation && <HighlightLabels tags={openCard.annotation.tags} priority={priorityMap.get(openCard.id)} />}<blockquote>{researchCard?.kind === "finding" ? openCard.text.split(/(\[S\d+\])/g).map((part,i) => {
            const ref = researchCard.sources.find(s => "[" + s.id + "]" === part);
            return ref ? <sup key={i}><a href={sourceHref(ref)} title={sourceLabel(ref)}>{ref.id.slice(1)}</a></sup> : part;
          }) : openCard.text}</blockquote>
          {openCard.annotation?.note && <p className="paper-note">{openCard.annotation.note}</p>}
          <div className="card-chips">{library.categories.filter(c => categoryMap.get(openCard.id)?.includes(c.id)).map(c => <span key={c.id}>{c.name}</span>)}
          <button className="text-button" onClick={() => setFiling([openCard.id])}>Edit categories</button></div>
          {openCard.annotation && <><div className="button-row"><Link to={`/read/${openCard.annotation.bookId}?annotation=${openCard.id}`}>Go to passage</Link>
            {previewLocator && <button onClick={() => setPdfItem(openCard.id)}>Show PDF page</button>}
            <button onClick={() => setEditing(openCard.annotation)}>Edit highlight</button>
            <ItemMenu title="Card actions" actions={studyActions(openCard.annotation)}>{null}</ItemMenu></div>
            <HighlightFollowups key={openCard.id} annotationId={openCard.id} notes={followupMap.get(openCard.id) || []} /></>}
          {(researchCard?.sources || openCard.annotation?.sources)?.map((s,i) => <SourceLink key={i} source={s} />)}
          {researchCard && <div className="research-card-actions">{researchCard.studyId && <Link to={"/notebooks?view=research&thread=" + encodeURIComponent(researchCard.studyId)}>Open study</Link>}<ItemMenu title="Research card" actions={[{ label:"Move to Trash", danger:true, run:() => {
            if (confirm("Move this saved card to Trash?")) void save("research-card",researchCard,true).then(closeCard,e => setActionError(e.message));
          } }]}>{null}</ItemMenu></div>}
          <footer><button disabled={cardIndex === 0} onClick={() => setOpened(cards[cardIndex-1].id)}>Previous</button>
          <small>{cardIndex + 1} of {cards.length}</small>
          <button disabled={cardIndex + 1 === cards.length} onClick={() => setOpened(cards[cardIndex+1].id)}>Next</button></footer>
        </article>
        {pdf && <PdfPreviewOverlay onClose={closePdf}>{pdf}</PdfPreviewOverlay>}
      </Dialog>}
      {filing && <CardCategories ids={filing} close={() => setFiling(undefined)} />}
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
