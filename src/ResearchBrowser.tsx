import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowLeft, Columns2, FileSearch, Library, Pencil, Plus, Search } from "lucide-react";
import { BookComparisonPicker, queueBookComparison } from "./BookComparison";
import { BrowsePages, pageOf, useBrowseState } from "./browse";
import { Dialog } from "./components";
import { db, get, list, save } from "./db";
import { ItemMenu, RenameItem } from "./ItemMenu";
import { now, uid, type Book } from "./model";
import { cancelResearch } from "./research";
import type { ResearchMessage, ResearchScope, ResearchThread, SourceRef } from "./researchTypes";
import { SaveResearch } from "./SaveResearch";
import { searchPreparedPassages } from "./sourceIndex";
import { PassageResults } from "./StudyEvidence";
import { StudySources, type StudySourceOption } from "./StudySources";
import { StudyWorkspace } from "./StudyWorkspace";
import "./researchBrowser.css";

const emptyScope: ResearchScope = { bookIds: [], highlightIds: [], noteIds: [] };

function SearchLibrary({ books, onClose }: { books: Book[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ hits: SourceRef[]; notice?: string }>();
  const [clip, setClip] = useState<{ text: string; sources: SourceRef[] }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  return <>
    <Dialog title="Search library" onClose={onClose} wide>
      <form className="study-library-search" onSubmit={async event => {
        event.preventDefault();
        if (busy || !query.trim()) return;
        const abort = new AbortController();
        request.current = abort;
        setError(""); setResult(undefined); setBusy(true);
        try {
          const { hits, indexedBooks } = await searchPreparedPassages(query, books, emptyScope, abort.signal);
          if (abort.signal.aborted) return;
          const missing = books.length - indexedBooks.size;
          const notice = missing ? `${missing} ${missing === 1 ? "book has" : "books have"} no prepared text here. To prepare a book, add it to a study and use Find passages.` : undefined;
          setResult({ hits, notice });
        } catch (cause) {
          if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
        } finally { if (!abort.signal.aborted) setBusy(false); }
      }}>
        <label>Search prepared book text<input type="search" value={query} autoFocus onChange={event => setQuery(event.target.value)} /></label>
        <button className="primary" disabled={busy || !query.trim()}><Search size={17} />Search</button>
      </form>
      {busy && <p role="status">Searching this device…</p>}
      {error && <p role="alert">{error}</p>}
      {result && <PassageResults {...result} onSave={(text, sources) => setClip({ text, sources })} />}
    </Dialog>
    {clip && <SaveResearch {...clip} onClose={() => setClip(undefined)} />}
  </>;
}

export function ResearchBrowser() {
  const [error, setError] = useState("");
  const [rename, setRename] = useState<ResearchThread>();
  const [action, setAction] = useState<"new" | "compare" | "search">();

  const [busy, setBusy] = useState(false);
  const books = useLiveQuery(() => list("book"), []) || [];
  const notebooks = useLiveQuery(() => list("notebook"), []) || [];
  const notes = useLiveQuery(() => list("notebook-note"), []) || [];
  const highlights = useLiveQuery(() => list("annotation"), []) || [];
  const threads = useLiveQuery(() => list("research-thread"), []) || [];
  const messages = useLiveQuery(() => list("research-message"), []) || [];
  const browse = useBrowseState();
  const query = browse.value("rq"), book = browse.value("book"), notebook = browse.value("researchNotebook"), selected = browse.value("thread");
  const active = threads.find(study => study.id === selected);
  const byStudy = useMemo(() => {
    const groups = new Map<string, { messages: ResearchMessage[]; text: string; updated: string }>();
    for (const message of messages) {
      const group = groups.get(message.threadId) || { messages: [], text: "", updated: "" };
      group.messages.push(message);
      group.text += ` ${message.question} ${message.answer}`;
      if (message.createdAt > group.updated) group.updated = message.createdAt;
      groups.set(message.threadId, group);
    }
    return groups;
  }, [messages]);
  const options = useMemo<StudySourceOption[]>(() => {
    const editions = new Map(books.map(item => [item.id, item]));
    const titles = new Map(notebooks.map(item => [item.id, item.title]));
    return [
      ...books.map(item => ({ kind: "bookIds" as const, id: item.id, title: item.title, detail: item.author === "Unknown author" ? undefined : item.author })),
      ...highlights.flatMap(item => {
        const source = editions.get(item.bookId);
        return source && item.type !== "page-note" && item.text.trim() && item.locator.hash === source.hash
          ? [{ kind: "highlightIds" as const, id: item.id, title: item.text, detail: source.title }]
          : [];
      }),
      ...notes.map(item => ({ kind: "noteIds" as const, id: item.id, title: item.title, detail: titles.get(item.notebookId) })),
    ];
  }, [books, highlights, notes, notebooks]);
  const filterBook = books.find(item => item.id === book);
  const filterNotebook = notebooks.find(item => item.id === notebook);
  const needle = query.trim().toLowerCase();
  const filtered = threads.filter(study =>
    (!book || study.bookId === book || study.scope?.bookIds.includes(book)) &&
    (!notebook || study.notebookId === notebook || notes.some(note => note.notebookId === notebook && study.scope?.noteIds.includes(note.id))) &&
    `${study.title} ${byStudy.get(study.id)?.text || ""}`.toLowerCase().includes(needle),
  ).sort((a, b) => (byStudy.get(b.id)?.updated || b.createdAt).localeCompare(byStudy.get(a.id)?.updated || a.createdAt));
  const paged = pageOf(filtered, browse.value("rpage"));

  async function trash(study: ResearchThread) {
    if (!confirm(`Move “${study.title}” to Trash?`)) return;
    try {
      const latest = await get("research-thread", study.id);
      if (!latest) return;
      await save("research-thread", latest, true);
      const jobs = await db.researchJobs.where("threadId").equals(study.id).toArray();
      for (const job of jobs) if (job.state !== "done") await cancelResearch(job.id);
      if (selected === study.id) browse.update({ thread: "", result: "" });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  function open(id: string, result = "", clearFilters = false) {
    if (id && result) localStorage.setItem("last-study-result:" + id,result);
    browse.update({ thread: id, result: result, ...(clearFilters ? { rq: "", rpage: "1", book: "", researchNotebook: "" } : {}) }, false);
  }
  async function create(scope: ResearchScope) {
    if (!scope.bookIds.length && !scope.noteIds.length && !scope.highlightIds.length) throw new Error("Select at least one source.");
    if (busy) return;
    setBusy(true); setError("");
    try {
      const study: ResearchThread = { id: uid(), title: (options.filter(o => scope[o.kind].includes(o.id)).map(o => o.title).join(" & ") || "New study").slice(0,150), createdAt: now(),
        notebookId: filterNotebook?.id, scope };
      await save("research-thread", study);
      setAction(undefined); open(study.id, "", true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); throw cause; }
    finally { setBusy(false); }
  }

  return <div className={`research-browser ${active ? "research-detail-open" : ""}`}>
    {error && action !== "new" && <p className="notice" role="status">{error}</p>}
    <div className="research-browser-tools">
      <button className="primary" onClick={() => { setError(""); setAction("new"); }}><Plus size={17} />Start a study</button>
      <button className="secondary" onClick={() => setAction("search")}><FileSearch size={17} />Search library</button>
    </div>
    <div className="research-history-layout">
      <aside className="research-conversation-list">
        <h2>Recent studies</h2>
        <label className="search-field"><Search size={16} /><input type="search" aria-label="Search studies" placeholder="Find a study" value={query}
          onChange={event => browse.update({ rq: event.target.value, rpage: "1" })} /></label>
        {(book || notebook) && <button className="text-button study-clear-filter" onClick={() => browse.update({ book: "", researchNotebook: "", rpage: "1" })}>
          Clear filter{filterBook || filterNotebook ? ` · ${filterBook?.title || filterNotebook?.title}` : ""}
        </button>}
        {!filtered.length && <p>{threads.length ? "No matching studies." : "Your studies will appear here."}</p>}
        <nav aria-label="Saved studies">{paged.items.map(study => {
          const history = byStudy.get(study.id)?.messages || [];
          const last = history.find(m => m.id === localStorage.getItem("last-study-result:" + study.id)) || [...history].sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0];
          const count = history.length;
          return <ItemMenu title={study.title} key={study.id} touch actions={[
            { label: "Rename", run: () => setRename(study) },
            { label: "Move to Trash", danger: true, run: () => void trash(study) },
          ]}><button aria-current={selected === study.id ? "page" : undefined} onClick={() => open(study.id)}>
            <strong>{study.title}</strong>{last && <span className="last-question">{last.question}</span>}<small>{options.filter(o => study.scope?.[o.kind].includes(o.id)).map(o => o.title).join(" · ").slice(0,110)}</small><small>{count} {count === 1 ? "result" : "results"}</small>
          </button></ItemMenu>;
        })}</nav>
        {paged.pages > 1 && <BrowsePages {...paged} label="Studies" onChange={page => browse.update({ rpage: String(page) })} />}
      </aside>
      <main className="research-browser-detail">
        {active ? <>
          <div className="research-browser-actions">
            <button className="text-button" onClick={() => open("")}><ArrowLeft size={16} />All studies</button>
            <button className="text-button" onClick={() => setRename(active)}><Pencil size={15} />Rename study</button>
          </div>
          <StudyWorkspace key={active.id} study={active} books={books} options={options} messages={byStudy.get(active.id)?.messages || []}
            resultId={browse.value("result") || localStorage.getItem("last-study-result:" + active.id) || ""} onSelectResult={id => { localStorage.setItem("last-study-result:" + active.id,id); browse.update({ result:id }); }} />
        </> : <section className="research-browser-welcome">
          <Library size={28} aria-hidden="true" />
          <h2>Compare books</h2>
          <p>See where authors agree or differ, with a passage for each finding.</p>
          <button className="secondary" onClick={() => setAction("compare")}><Columns2 size={17} />Compare books</button>
        </section>}
      </main>
    </div>
    {action === "search" && <SearchLibrary books={books} onClose={() => setAction(undefined)} />}
    {action === "new" && <StudySources creating scope={{ ...emptyScope, bookIds: filterBook ? [filterBook.id] : [] }} options={options} books={books} onSave={create} onClose={() => setAction(undefined)} />}
    {action === "compare" && <BookComparisonPicker books={books} selected={filterBook ? [filterBook.id] : []} onClose={() => setAction(undefined)}
      onCompare={async (question, chosen) => {
        const study: ResearchThread = { id: uid(), title: question.slice(0, 150), createdAt: now(), notebookId: filterNotebook?.id,
          scope: { ...emptyScope, bookIds: chosen.map(item => item.bookId) } };
        await save("research-thread", study);
        setError("");
        try { open(study.id, await queueBookComparison(study.id, question, chosen), true); }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); open(study.id, "", true); }
        setAction(undefined);
      }} />}
    {rename && <RenameItem label="study" value={rename.title} onClose={() => setRename(undefined)} onSave={async name => {
      await db.transaction("rw", db.rows, db.outbox, db.conflicts, db.meta, async () => {
        const current = await get("research-thread", rename.id);
        if (!current) throw new Error("This study is no longer available.");
        await save("research-thread", { ...current, title: name });
      });
    }} />}
  </div>;
}
