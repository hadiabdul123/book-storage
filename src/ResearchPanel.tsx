import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { BookOpen, Globe, Plus, Sparkles, ArrowUp, Copy, NotebookPen, RefreshCw, X, LoaderCircle, CircleAlert, Clock3, ChevronDown, SlidersHorizontal, Quote, WifiOff, MessageSquare } from "lucide-react";
import { db, get, list, save } from "./db";
import { now, uid, type Book } from "./model";
import type { ResearchMode, ResearchScope, ResearchThread, SourceRef } from "./researchTypes";
import { enqueueResearch, cancelResearch, retryResearch } from "./research";
import { indexBook, rankChunks, retrieveSources } from "./sourceIndex";
import { citedSources } from "./sourceReferences";
import { SourceLink } from "./Citation";
import { SaveResearch } from "./SaveResearch";
import { BookReviewPicker } from "./BookReviewPicker";
import { reviewQuestion, type ReviewSection } from "./bookReview";
import "./researchPanel.css";

function Answer({ text, sources, prefix }: { text: string; sources: SourceRef[]; prefix: string }) {
  return <>{text.split(/\n\s*\n/).map((paragraph, i) => <p key={i}>{paragraph.split(/(\[S\d+\])/g).map((part, n) => {
    const ref = sources.find(s => `[${s.id}]` === part);
    return ref ? <sup key={n}><a href={`#research-source-${prefix}-${ref.id}`} onClick={e => { e.preventDefault(); const target = document.getElementById(`research-source-${prefix}-${ref.id}`); const details = target?.closest("details"); if (details) details.open = true; target?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }); }} title={ref.title}>{part}</a></sup> : <span key={n}>{part}</span>;
  })}</p>)}</>;
}
export function ResearchPanel({ book, selection, notebookId, defaultNoteId, initialThreadId, onThreadChange, libraryFirst = false }: { book?: Book; selection?: SourceRef; notebookId?: string; defaultNoteId?: string; initialThreadId?: string; onThreadChange?: (id: string) => void; libraryFirst?: boolean }) {
  const books = useLiveQuery(() => list("book"), []) || [];
  const notes = useLiveQuery(() => list("notebook-note"), []) || [];
  const threads = useLiveQuery(() => list("research-thread"), []) || [];
  const annotations = useLiveQuery(() => list("annotation"), []) || [];
  const [sourceQuery, setSourceQuery] = useState(""), [visibleAnswers, setVisibleAnswers] = useState(50);
  const [thread, setThread] = useState<ResearchThread>();
  const [mode, setMode] = useState<ResearchMode>(selection ? "explain" : book || libraryFirst ? "sources" : "web");
  const [question, setQuestion] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [bookIds, setBookIds] = useState<string[]>(book ? [book.id] : []);
  const [noteIds, setNoteIds] = useState<string[]>(defaultNoteId ? [defaultNoteId] : []);
  const [highlightIds, setHighlightIds] = useState<string[]>([]);
  const [review, setReview] = useState(false);
  const [matches, setMatches] = useState<SourceRef[]>();
  useEffect(() => { if (defaultNoteId) { setNoteIds(ids => ids.includes(defaultNoteId) ? ids : [...ids, defaultNoteId]); setMode("sources"); } }, [defaultNoteId]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [clip, setClip] = useState<{ text: string; sources: SourceRef[] }>();
  const [selectedClip, setSelectedClip] = useState<{ id: string; text: string; sources: SourceRef[] }>();
  const [refresh, setRefresh] = useState(false);
  const [passageExpanded, setPassageExpanded] = useState(false);
  const conversation = useRef<HTMLDivElement>(null);
  const questionInput = useRef<HTMLTextAreaElement>(null);
  const nearEnd = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const signature = JSON.stringify(selection?.locator || null);
  useEffect(() => {
    let active = true; controller.current?.abort(); setBusy(false);
    void (async () => {
      const existing = initialThreadId ? (await list("research-thread")).find(t => t.id === initialThreadId) : (await list("research-thread")).filter(t => t.bookId === book?.id && t.notebookId === notebookId && JSON.stringify(t.selection?.locator || null) === signature).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const next = existing || { id: uid(), title: selection?.locator?.quote?.exact?.slice(0, 80) || selection?.excerpt.slice(0, 80) || book?.title || "Research", bookId: book?.id, notebookId, selection, createdAt: now() };
      if (!existing) await save("research-thread", next);
      if (active) {
        setThread(next);
        setMode(next.selection ? "explain" : book || defaultNoteId || libraryFirst || next.scope ? "sources" : "web");
        setBookIds(next.scope?.bookIds || (book ? [book.id] : []));
        setNoteIds(next.scope?.noteIds || (defaultNoteId ? [defaultNoteId] : []));
        setHighlightIds(next.scope?.highlightIds || []);
      }
    })().catch(e => { if (active) setStatus(e.message); });
    return () => { active = false; };
  }, [book?.id, signature, notebookId, initialThreadId]);
  const currentSelection = thread?.selection || selection;
  const term = currentSelection?.locator?.quote?.exact || currentSelection?.excerpt || "";
  useEffect(() => {
    let active = true;
    if (!thread) return;
    setQuestion(term ? "Explain this passage in simple terms." : "");
    setSearchQuery(term.slice(0, 300));
    void db.meta.get(`research-draft:${thread.id}`).then(r => { if (active && r) { try { const d = JSON.parse(r.value); setQuestion(d.question || ""); setSearchQuery(d.searchQuery || term.slice(0, 300)); if (["explain", "sources", "web"].includes(d.mode)) setMode(d.mode); if (Array.isArray(d.bookIds)) setBookIds(d.bookIds); if (Array.isArray(d.noteIds)) setNoteIds(d.noteIds); if (Array.isArray(d.highlightIds)) setHighlightIds(d.highlightIds); } catch { /* Use the selected passage. */ } } });
    return () => { active = false; };
  }, [thread?.id]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update); window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); controller.current?.abort(); };
  }, []);
  const messages = useLiveQuery(async () => (await list("research-message")).filter(m => m.threadId === thread?.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [thread?.id]) || [];
  const jobs = useLiveQuery(async () => (await db.researchJobs.where("threadId").equals(thread?.id || "").toArray()).filter(j => j.state !== "done" && j.state !== "cancelled"), [thread?.id]) || [];
  useEffect(() => { nearEnd.current = true; setVisibleAnswers(50); setPassageExpanded(false); }, [thread?.id]);
  useEffect(() => {
    if (nearEnd.current && conversation.current) conversation.current.scrollTop = conversation.current.scrollHeight;
  }, [messages.length, jobs.length, jobs.map(j => j.state).join(",")]);
  useEffect(() => {
    const el = conversation.current;
    if (!el) return;
    const resize = new ResizeObserver(() => { if (nearEnd.current) el.scrollTop = el.scrollHeight; });
    resize.observe(el);
    return () => resize.disconnect();
  }, []);
  useEffect(() => {
    const selected = () => {
      const s = window.getSelection(); const r = s?.rangeCount ? s.getRangeAt(0) : null;
      const parent = r?.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? r.commonAncestorContainer as Element : r?.commonAncestorContainer.parentElement;
      const host = parent?.closest("[data-research-message]"); const m = messages.find(m => m.id === host?.getAttribute("data-research-message"));
      if (!s || !r || !m || !s.toString().trim()) return;
      const text = s.toString().trim(); const refs = citedSources(text, m.sources);
      setSelectedClip({ id: m.id, text, sources: refs.length ? refs : m.sources });
    };
    document.addEventListener("selectionchange", selected); return () => document.removeEventListener("selectionchange", selected);
  }, [messages]);
  const scope: ResearchScope = { bookIds, noteIds, highlightIds };
  const count = bookIds.length + noteIds.length + highlightIds.length;
  const chosenBooks = books.filter(b => bookIds.includes(b.id));
  const visibleHighlights = annotations.filter(a => a.type !== "page-note" && books.some(book => book.id === a.bookId));
  const draft = (q: string, search: string, next = scope, nextMode = mode) => { if (thread) void db.meta.put({ key: `research-draft:${thread.id}`, value: JSON.stringify({ question: q, searchQuery: search, mode: nextMode, ...next }) }).catch(() => setStatus("Could not store the question draft. Keep this panel open.")); };
  function choose(key: keyof ResearchScope, id: string, checked: boolean) {
    if (checked && count >= 7) return;
    const ids = checked ? [...scope[key], id] : scope[key].filter(value => value !== id);
    ({ bookIds: setBookIds, noteIds: setNoteIds, highlightIds: setHighlightIds })[key](ids);
    draft(question, searchQuery, { ...scope, [key]: ids });
  }
  function changeMode(next: ResearchMode) { setMode(next); draft(question, searchQuery, scope, next); }
  async function saveScope() {
    if (!thread) return;
    const latest = await get("research-thread", thread.id);
    if (latest && JSON.stringify(latest.scope) !== JSON.stringify(scope)) await save("research-thread", { ...latest, scope });
  }
  async function queueReview(sections: ReviewSection[]) {
    if (!thread) return;
    await saveScope();
    nearEnd.current = true;
    for (const section of sections) await enqueueResearch(thread.id, {
      mode: "sources", question: reviewQuestion(section, question),
      sources: section.sources, history: [],
    }, refresh);
  }
  async function findPassages() {
    if (!question.trim() || busy || !chosenBooks.length) return;
    setBusy(true); setStatus(""); const c = new AbortController(); controller.current = c;
    try {
      for (const book of chosenBooks) await indexBook(book, c.signal, setStatus);
      c.signal.throwIfAborted();
      const chunks = await db.chunks.where("bookId").anyOf(bookIds).toArray();
      setMatches(rankChunks(question, chunks, 12)); setStatus("");
    } catch (e) { if (!c.signal.aborted) setStatus(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (!thread || busy) return;
    setBusy(true); setStatus(""); const c = new AbortController(); controller.current = c;
    try {
      let sources: SourceRef[] = [];
      if (mode === "sources") {
        for (const id of bookIds) {
          const chosen = books.find(b => b.id === id);
          if (chosen) await indexBook(chosen, c.signal, setStatus);
        }
        sources = await retrieveSources(`${question} ${term.slice(0, 200)}`, bookIds, noteIds, highlightIds);
        if (!sources.length) throw new Error("No matching text found. Choose downloaded sources, use more specific terms, or try Web. Scanned pages need cached text recognition.");
        const missing = chosenBooks.filter(book => !sources.some(source => source.bookId === book.id));
        if (missing.length) throw new Error(`No readable text was found for ${missing.map(book => book.title).join(", ")}. Prepare its text or remove it from this question.`);
        await saveScope();
      } else if (currentSelection) sources = [{ ...currentSelection, excerpt: currentSelection.excerpt.slice(0, 2400) }];
      if (mode === "explain" && !sources.length) throw new Error("Select a passage in a book first, or choose My sources or Web.");
      nearEnd.current = true;
      await enqueueResearch(thread.id, { mode, question: question.trim(), ...(mode === "web" ? { searchQuery: searchQuery.trim() || question.trim() } : {}), sources,
        history: messages.slice(-2).map(m => ({ question: m.question.slice(0, 1500), answer: m.answer.slice(0, 1800) })) }, refresh);
      setQuestion(""); draft("", searchQuery); setRefresh(false);
      setStatus("");
    } catch (e) { if (!c.signal.aborted) setStatus(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const hasConversation = messages.length > 0 || jobs.length > 0;
  const relatedThreads = threads.filter(t => t.bookId === book?.id && t.notebookId === notebookId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const suggestions = mode === "web" ? ["Find reliable sources", "What is the latest evidence?"] : mode === "sources" ? ["What are the main ideas?", "How do these ideas connect?"] : ["Explain simply", "Give me an example", "Why does this matter?"];
  const suggest = (label: string) => {
    const text = label === "Explain simply" ? "Explain this passage in simple terms." : label === "Give me an example" ? "Give me a simple everyday example of this idea." : label === "Find reliable sources" ? `Find reliable sources about ${term.slice(0, 180) || searchQuery || "this topic"}.` : label;
    setQuestion(text); draft(text, searchQuery); questionInput.current?.focus();
  };
  return <section className={`research-workspace ${hasConversation ? "has-conversation" : "is-new"}`} aria-label="Research workspace">
    <div className="research-chrome">
      <div className="research-heading">
        <div className="research-context"><BookOpen size={16} /><div><strong title={thread?.title}>{thread?.title || book?.title || "Research"}</strong></div></div>
        <button className="research-new-chat" aria-label="New research conversation" title="Start a new conversation" onClick={async () => {
          try { const t = { id: uid(), title: term.slice(0, 80) || "Research", bookId: book?.id, notebookId, selection: currentSelection, createdAt: now() }; await save("research-thread", t); setThread(t); onThreadChange?.(t.id); setStatus(""); } catch (e) { setStatus(String(e)); }
        }}><Plus size={17} /><span>New</span></button>
      </div>
      <div className="research-tabs" role="tablist" aria-label="Research mode">{([
        ["explain", Sparkles, "Explain"], ["sources", BookOpen, "My sources"], ["web", Globe, "Web"],
      ] as const).map(([value, Icon, label], index) => <button role="tab" aria-selected={mode === value} tabIndex={mode === value ? 0 : -1} key={value} onClick={() => changeMode(value)} onKeyDown={e => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
        e.preventDefault(); const modes = ["explain", "sources", "web"] as const;
        const next = e.key === "Home" ? 0 : e.key === "End" ? 2 : (index + (e.key === "ArrowRight" ? 1 : -1) + 3) % 3;
        changeMode(modes[next]); (e.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus();
      }}><Icon size={16} />{label}</button>)}</div>
      {currentSelection && <div className={`research-passage ${passageExpanded ? "is-expanded" : ""}`}>
        <div className="research-passage-label"><Quote size={14} /><span>Selected passage</span><button aria-label={passageExpanded ? "Collapse selected passage" : "Expand selected passage"} aria-expanded={passageExpanded} onClick={() => setPassageExpanded(!passageExpanded)}><ChevronDown size={16} /></button></div>
        <blockquote>{term.slice(0, 600)}</blockquote>
        <button className="research-collect" onClick={() => setClip({ text: term, sources: [currentSelection] })}><NotebookPen size={14} />Collect passage</button>
      </div>}
      {mode === "sources" && <><details className="research-source-picker"><summary><BookOpen size={15} /><span>Choose books and notes</span><b>{count}</b><ChevronDown size={15} /></summary><div>
        <input aria-label="Search research sources" placeholder="Find books, highlights, or notebook pages" value={sourceQuery} onChange={e => setSourceQuery(e.target.value)} />
        {books.filter(b => `${b.title} ${b.author}`.toLowerCase().includes(sourceQuery.toLowerCase())).slice(0, 50).map(b => <label key={b.id}><input type="checkbox" checked={bookIds.includes(b.id)} disabled={count >= 7 && !bookIds.includes(b.id)} onChange={e => choose("bookIds", b.id, e.target.checked)} />{b.title}</label>)}
        {notes.filter(n => n.title.toLowerCase().includes(sourceQuery.toLowerCase())).slice(0, 50).map(n => <label key={n.id}><input type="checkbox" checked={noteIds.includes(n.id)} disabled={count >= 7 && !noteIds.includes(n.id)} onChange={e => choose("noteIds", n.id, e.target.checked)} />Note: {n.title}</label>)}
        {visibleHighlights.filter(a => `${a.text} ${a.note} ${a.tags.join(" ")}`.toLowerCase().includes(sourceQuery.toLowerCase())).slice(0, 50).map(a => <label key={a.id}><input type="checkbox" checked={highlightIds.includes(a.id)} disabled={count >= 7 && !highlightIds.includes(a.id)} onChange={e => choose("highlightIds", a.id, e.target.checked)} />Highlight: {a.text.slice(0, 160)}</label>)}
        {!books.length && !notes.length && <p>Add a book or write a note to use it as a source.</p>}
        <p>Choose up to seven sources per question. Leafmark sends excerpts from those sources.</p>
      </div></details>
      <div className="research-study-actions"><button className="text-button" disabled={!thread || !chosenBooks.length || busy} onClick={() => setReview(true)}>Review chapters</button>
        <button className="text-button" disabled={chosenBooks.length < 2 || busy} onClick={() => suggest("Compare the chosen books. Explain where they agree and differ. Combine compatible ideas into a study outline, cite evidence from each book, and flag unanswered questions.")}>Compare books</button>
        <button className="text-button" disabled={!chosenBooks.length || !question.trim() || busy} onClick={() => void findPassages()}>Find passages</button>
      </div></>}
      {relatedThreads.length > 1 && <details className="research-history"><summary><Clock3 size={14} />Previous conversations<ChevronDown size={14} /></summary><label>Conversation<select aria-label="Research conversation" value={thread?.id || ""} onChange={e => { setThread(threads.find(t => t.id === e.target.value)); onThreadChange?.(e.target.value); }}>{relatedThreads.map(t => <option key={t.id} value={t.id}>{t.title} · {new Date(t.createdAt).toLocaleDateString()}</option>)}</select></label></details>}
      {!online && <p className="research-offline" role="status"><WifiOff size={15} /><span>Offline. Your questions will wait for a connection.</span></p>}
    </div>
    <div className="research-conversation" ref={conversation} onScroll={e => { const el = e.currentTarget; nearEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
      {matches && <section className="research-passage-results"><header><strong>Matching passages</strong><button className="text-button" onClick={() => setMatches(undefined)}>Close results</button></header>
        {matches.length ? matches.map(source => <article key={source.id}><SourceLink source={source} /><p>{source.excerpt}</p><button className="text-button" onClick={() => setClip({ text: source.excerpt, sources: [source] })}>Save passage…</button></article>) : <p>No matching passages in the selected books.</p>}</section>}
      <div className="research-answers">{messages.length > visibleAnswers && <button className="text-button" onClick={() => { nearEnd.current = false; setVisibleAnswers(n => n + 50); }}>Load earlier answers</button>}{messages.slice(-visibleAnswers).map(m => <article className="research-answer" key={m.id}>
        <div className="research-asked"><MessageSquare size={14} /><h4>{m.question}</h4></div>
        <header><span><Sparkles size={14} />{m.mode === "web" ? "Web research" : m.mode === "sources" ? "From your sources" : "Explanation"}</span><time dateTime={m.createdAt}>{new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></header>
        <div className="research-answer-text" data-research-message={m.id} onPointerUp={e => {
          const s = window.getSelection(); const range = s?.rangeCount ? s.getRangeAt(0) : null;
          if (s && range && e.currentTarget.contains(range.commonAncestorContainer) && s.toString().trim()) {
            const text = s.toString().trim(); const refs = citedSources(text, m.sources);
            setSelectedClip({ id: m.id, text, sources: refs.length ? refs : m.sources });
          }
        }}><Answer text={m.answer} sources={m.sources} prefix={m.id} /></div>
        {selectedClip?.id === m.id && <div className="research-selection-preview"><NotebookPen size={14} /><span>{selectedClip.text.slice(0, 100)}{selectedClip.text.length > 100 ? "…" : ""}</span><button aria-label="Use whole answer" onClick={() => setSelectedClip(undefined)}><X size={15} /></button></div>}
        <div className="research-answer-actions"><button className="research-save-answer" onPointerDown={e => e.preventDefault()} onClick={() => setClip({ text: selectedClip?.id === m.id ? selectedClip.text : m.answer, sources: selectedClip?.id === m.id ? selectedClip.sources : m.sources })}><NotebookPen size={15} />{selectedClip?.id === m.id ? "Save selected excerpt…" : "Save answer…"}</button><button className="research-copy" aria-label="Copy" title="Copy answer or selected excerpt" onClick={() => {
          const text = selectedClip?.id === m.id ? selectedClip.text : m.answer;
          if (!navigator.clipboard) { setStatus("Select the text and use your device’s Copy command."); return; }
          void navigator.clipboard.writeText(text).then(() => setStatus("Copied to clipboard.")).catch(() => setStatus("Select the text and use your device’s Copy command."));
        }}><Copy size={15} /><span>Copy</span></button></div>
        <details className="research-evidence"><summary><BookOpen size={14} /><span>Sources ({m.sources.length})</span><ChevronDown size={15} /></summary>{m.sources.map(s => <div id={`research-source-${m.id}-${s.id}`} key={s.id}><SourceLink source={s} /><p>{s.excerpt}</p></div>)}</details>
      </article>)}</div>
      {jobs.map(j => {
        const failed = j.state === "error" || j.state === "paused";
        const Icon = failed ? CircleAlert : j.state === "running" ? LoaderCircle : Clock3;
        return <article className={`research-pending ${failed ? "needs-attention" : "is-working"}`} key={j.id}>
          <div className="research-job-heading"><Icon size={18} className={j.state === "running" ? "research-spinner" : ""} /><strong>{failed ? "Let’s try that again" : j.state === "running" ? "Finding an answer" : "Question saved"}</strong></div>
          <p className="research-job-question" title={j.request.question}>{j.request.question}</p><p className="research-job-message" role="status">{j.message || (online ? "Waiting to research your question." : "This will run when you reconnect.")}</p>
          <div className="research-job-actions">{j.state !== "running" && <button className="research-retry" onClick={() => void retryResearch(j.id).catch(e => setStatus(e.message))}><RefreshCw size={15} />Retry</button>}<button className="research-cancel" onClick={() => void cancelResearch(j.id).catch(e => setStatus(e.message))}><X size={15} />Cancel request</button></div>
        </article>;
      })}
      {!hasConversation && <div className="research-empty"><Sparkles size={25} /><h4>{currentSelection ? "Make this idea your own" : mode === "web" ? "Follow your curiosity" : "Go a little deeper"}</h4><p>{currentSelection ? "Unpack the meaning, find an example, or explore the evidence behind it." : "Ask a question. Explore a connection. Keep the useful parts with their sources."}</p><div className="research-suggestions">{suggestions.map(label => <button key={label} onClick={() => suggest(label)}>{label}</button>)}</div></div>}
    </div>
    <form onSubmit={submit} className="research-question">
      {status && <p className="research-status" role="status">{status}</p>}
      {mode === "web" && <label className="research-web-query">Search the web for<div><Globe size={15} /><input aria-label="Web search query" maxLength={500} value={searchQuery} onChange={e => { setSearchQuery(e.target.value); draft(question, e.target.value); }} placeholder="A topic or search phrase" /></div></label>}
      <label className="research-question-label">{hasConversation ? "Ask a follow-up" : "Your question"}<textarea ref={questionInput} aria-label="Research question" maxLength={1500} required rows={2} value={question} onChange={e => { setQuestion(e.target.value); draft(e.target.value, searchQuery); }} onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} placeholder={hasConversation ? "What would you like to explore next?" : "What does this mean? How does it connect?"} /></label>
      <div className="research-composer-actions"><details className="research-options"><summary><SlidersHorizontal size={15} />Options</summary><div><label className="research-refresh"><input type="checkbox" checked={refresh} onChange={e => setRefresh(e.target.checked)} />Refresh instead of using a saved answer</label>{mode === "web" && <p>Your book passage stays out of the web search.</p>}<p>Saved answers work offline. Free usage limits apply.</p></div></details>
        <button className="research-send" disabled={busy || !thread || !question.trim()}><span>{busy ? "Preparing…" : online ? "Research" : "Save question for later"}</span>{busy ? <LoaderCircle size={17} className="research-spinner" /> : <ArrowUp size={18} />}</button>
        {busy && <button type="button" className="research-cancel-preparation" aria-label="Cancel source preparation" onClick={() => { controller.current?.abort(); setBusy(false); setStatus("Preparation cancelled. Your question is kept."); }}><X size={17} /></button>}
      </div>
      <p className="research-footnote">Check the sources. AI can make mistakes.</p>
    </form>
    {clip && <SaveResearch text={clip.text} sources={clip.sources} passage={currentSelection} onClose={() => { setClip(undefined); setSelectedClip(undefined); }} />}
    {review && <BookReviewPicker books={chosenBooks} focus={question} previous={new Set([...messages.map(message => message.question), ...jobs.map(job => job.request.question)])} onClose={() => setReview(false)} onReview={queueReview} />}
  </section>;
}
