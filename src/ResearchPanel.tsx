import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { BookOpen, Globe, Plus, Search, Sparkles } from "lucide-react";
import { db, list, save } from "./db";
import { now, uid, type Book } from "./model";
import type { ResearchMode, ResearchThread, SourceRef } from "./researchTypes";
import { enqueueResearch, cancelResearch, retryResearch } from "./research";
import { indexBook, retrieveSources } from "./sourceIndex";
import { citedSources } from "./sourceReferences";
import { SourceLink } from "./Citation";
import { SaveResearch } from "./SaveResearch";

function Answer({ text, sources, prefix }: { text: string; sources: SourceRef[]; prefix: string }) {
  return <>{text.split(/\n\s*\n/).map((paragraph, i) => <p key={i}>{paragraph.split(/(\[S\d+\])/g).map((part, n) => {
    const ref = sources.find(s => `[${s.id}]` === part);
    return ref ? <sup key={n}><a href={`#research-source-${prefix}-${ref.id}`} onClick={e => { e.preventDefault(); const target = document.getElementById(`research-source-${prefix}-${ref.id}`); const details = target?.closest("details"); if (details) details.open = true; target?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }); }} title={ref.title}>{part}</a></sup> : <span key={n}>{part}</span>;
  })}</p>)}</>;
}
export function ResearchPanel({ book, selection, notebookId, defaultNoteId }: { book?: Book; selection?: SourceRef; notebookId?: string; defaultNoteId?: string }) {
  const books = useLiveQuery(() => list("book"), []) || [];
  const notes = useLiveQuery(() => list("notebook-note"), []) || [];
  const threads = useLiveQuery(() => list("research-thread"), []) || [];
  const [thread, setThread] = useState<ResearchThread>();
  const [mode, setMode] = useState<ResearchMode>(selection ? "explain" : book ? "sources" : "web");
  const [question, setQuestion] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [bookIds, setBookIds] = useState<string[]>(book ? [book.id] : []);
  const [noteIds, setNoteIds] = useState<string[]>(defaultNoteId ? [defaultNoteId] : []);
  useEffect(() => { if (defaultNoteId) { setNoteIds(ids => ids.includes(defaultNoteId) ? ids : [...ids, defaultNoteId]); setMode("sources"); } }, [defaultNoteId]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [clip, setClip] = useState<{ text: string; sources: SourceRef[] }>();
  const [selectedClip, setSelectedClip] = useState<{ id: string; text: string; sources: SourceRef[] }>();
  const [refresh, setRefresh] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const signature = JSON.stringify(selection?.locator || null);
  useEffect(() => {
    let active = true;
    void (async () => {
      const existing = (await list("research-thread")).filter(t => t.bookId === book?.id && t.notebookId === notebookId && JSON.stringify(t.selection?.locator || null) === signature).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const next = existing || { id: uid(), title: selection?.locator?.quote?.exact?.slice(0, 80) || selection?.excerpt.slice(0, 80) || book?.title || "Research", bookId: book?.id, notebookId, selection, createdAt: now() };
      if (!existing) await save("research-thread", next);
      if (active) { setThread(next); setMode(selection ? "explain" : book || defaultNoteId ? "sources" : "web"); setBookIds(book ? [book.id] : []); }
    })().catch(e => { if (active) setStatus(e.message); });
    return () => { active = false; };
  }, [book?.id, signature, notebookId]);
  const currentSelection = thread?.selection || selection;
  const term = currentSelection?.locator?.quote?.exact || currentSelection?.excerpt || "";
  useEffect(() => {
    let active = true;
    if (!thread) return;
    setQuestion(term ? `Explain “${term.slice(0, 180)}” in this passage.` : "");
    setSearchQuery(term.slice(0, 300));
    void db.meta.get(`research-draft:${thread.id}`).then(r => { if (active && r) { try { const d = JSON.parse(r.value); setQuestion(d.question || ""); setSearchQuery(d.searchQuery || term.slice(0, 300)); } catch { /* Use the selected passage. */ } } });
    return () => { active = false; };
  }, [thread?.id]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update); window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); controller.current?.abort(); };
  }, []);
  const messages = useLiveQuery(async () => (await list("research-message")).filter(m => m.threadId === thread?.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [thread?.id]) || [];
  const jobs = useLiveQuery(async () => (await db.researchJobs.where("threadId").equals(thread?.id || "").toArray()).filter(j => j.state !== "done" && j.state !== "cancelled"), [thread?.id]) || [];
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
  const draft = (q: string, search: string) => { if (thread) void db.meta.put({ key: `research-draft:${thread.id}`, value: JSON.stringify({ question: q, searchQuery: search }) }).catch(() => setStatus("Could not store the question draft. Keep this panel open.")); };
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
        sources = await retrieveSources(`${question} ${term.slice(0, 200)}`, bookIds, noteIds);
        if (!sources.length) throw new Error("No matching text found. Choose downloaded sources, use more specific terms, or try Web. Scanned pages need cached text recognition.");
      } else if (currentSelection) sources = [{ ...currentSelection, excerpt: currentSelection.excerpt.slice(0, 2400) }];
      if (mode === "explain" && !sources.length) throw new Error("Select a passage in a book first, or choose My sources or Web.");
      await enqueueResearch(thread.id, { mode, question: question.trim(), ...(mode === "web" ? { searchQuery: searchQuery.trim() || question.trim() } : {}), sources,
        history: messages.slice(-2).map(m => ({ question: m.question.slice(0, 1500), answer: m.answer.slice(0, 1800) })) }, refresh);
      setQuestion(""); draft("", searchQuery); setRefresh(false);
      setStatus(online ? "Question saved. Research will appear below." : "Question saved offline. It will run while Leafmark is open and connected.");
    } catch (e) { if (!c.signal.aborted) setStatus(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <section className="research-workspace" aria-label="Research workspace">
    <div className="research-heading"><div><h3>{thread?.title || "Research"}</h3><p className="muted">Follow an idea. Keep its sources.</p></div><button className="icon-button" aria-label="New research conversation" onClick={async () => {
      try { const t = { id: uid(), title: term.slice(0, 80) || "Research", bookId: book?.id, notebookId, selection: currentSelection, createdAt: now() }; await save("research-thread", t); setThread(t); } catch (e) { setStatus(String(e)); }
    }}><Plus size={18} /></button></div>
    {threads.filter(t => t.bookId === book?.id && t.notebookId === notebookId).length > 1 && <label className="research-history-label">Conversation<select aria-label="Research conversation" value={thread?.id || ""} onChange={e => setThread(threads.find(t => t.id === e.target.value))}>{threads.filter(t => t.bookId === book?.id && t.notebookId === notebookId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(t => <option key={t.id} value={t.id}>{t.title} · {new Date(t.createdAt).toLocaleDateString()}</option>)}</select></label>}
    {currentSelection && <div className="research-passage"><span>Selected passage</span><blockquote>{term.slice(0, 600)}</blockquote><button className="text-button" onClick={() => setClip({ text: term, sources: [currentSelection] })}>Collect passage</button></div>}
    <div className="research-tabs" role="tablist" aria-label="Research mode">{([
      ["explain", Sparkles, "Explain"], ["sources", BookOpen, "My sources"], ["web", Globe, "Web"],
    ] as const).map(([value, Icon, label]) => <button role="tab" aria-selected={mode === value} key={value} onClick={() => setMode(value)}><Icon size={16} />{label}</button>)}</div>
    {mode === "sources" && <details className="research-source-picker"><summary>Choose books and notes ({bookIds.length + noteIds.length})</summary>
      {books.map(b => <label key={b.id}><input type="checkbox" checked={bookIds.includes(b.id)} onChange={e => setBookIds(e.target.checked ? [...bookIds, b.id] : bookIds.filter(id => id !== b.id))} />{b.title}</label>)}
      {notes.map(n => <label key={n.id}><input type="checkbox" checked={noteIds.includes(n.id)} onChange={e => setNoteIds(e.target.checked ? [...noteIds, n.id] : noteIds.filter(id => id !== n.id))} />Note: {n.title}</label>)}
      <p className="muted">Downloaded text is indexed on this device. Only matching excerpts are sent for an answer.</p>
    </details>}
    {!online && <p className="research-offline" role="status">Offline · saved answers are available. New questions wait for a connection.</p>}
    <form onSubmit={submit} className="research-question">
      {mode === "web" && <label>Public web search query<input aria-label="Web search query" maxLength={500} value={searchQuery} onChange={e => { setSearchQuery(e.target.value); draft(question, e.target.value); }} placeholder="e.g. Big Bang theory evidence" /><small>Only this query is sent to Tavily. Book context is sent to Groq for the explanation.</small></label>}
      <label>{mode === "explain" ? "What would you like explained?" : "Ask a question"}<textarea aria-label="Research question" maxLength={1500} required rows={3} value={question} onChange={e => { setQuestion(e.target.value); draft(e.target.value, searchQuery); }} placeholder="What does this mean? How does it connect to…?" /></label>
      <div className="research-question-actions"><button className="primary" disabled={busy || !thread || !question.trim()}><Search size={17} />{busy ? "Preparing sources…" : online ? "Research" : "Save question for later"}</button>{busy && <button type="button" className="text-button" onClick={() => { controller.current?.abort(); setBusy(false); setStatus("Preparation cancelled. Your question is kept."); }}>Cancel</button>}</div>
      <label className="research-refresh"><input type="checkbox" checked={refresh} onChange={e => setRefresh(e.target.checked)} />Refresh instead of using a saved answer</label>
    </form>
    {status && <p className="research-status" role="status">{status}</p>}
    {jobs.map(j => <article className="research-pending" key={j.id}><strong>{j.request.question}</strong><p role="status">{j.message || (online ? "Waiting to research…" : "Saved for when you reconnect")}</p><div className="button-row">{j.state !== "running" && <button className="text-button" onClick={() => void retryResearch(j.id).catch(e => setStatus(e.message))}>Retry</button>}<button className="text-button" onClick={() => void cancelResearch(j.id).catch(e => setStatus(e.message))}>Cancel request</button></div></article>)}
    <div className="research-answers">{messages.map(m => <article className="research-answer" key={m.id}>
      <header><h4>{m.question}</h4><small>{m.mode === "web" ? "Web research" : m.mode === "sources" ? "From your sources" : "AI explanation"} · {new Date(m.createdAt).toLocaleString()}</small></header>
      <div className="research-answer-text" data-research-message={m.id} onPointerUp={e => {
        const s = window.getSelection(); const range = s?.rangeCount ? s.getRangeAt(0) : null;
        if (s && range && e.currentTarget.contains(range.commonAncestorContainer) && s.toString().trim()) {
          const text = s.toString().trim(); const refs = citedSources(text, m.sources);
          setSelectedClip({ id: m.id, text, sources: refs.length ? refs : m.sources });
        }
      }}><Answer text={m.answer} sources={m.sources} prefix={m.id} /></div>
      {selectedClip?.id === m.id && <p className="research-selection-preview">Selected: {selectedClip.text.slice(0, 100)}{selectedClip.text.length > 100 ? "…" : ""}</p>}
      <div className="research-answer-actions"><button className="secondary" onPointerDown={e => e.preventDefault()} onClick={() => setClip({ text: selectedClip?.id === m.id ? selectedClip.text : m.answer, sources: selectedClip?.id === m.id ? selectedClip.sources : m.sources })}>{selectedClip?.id === m.id ? "Save selected excerpt…" : "Save answer…"}</button><button className="text-button" onClick={() => {
        const text = selectedClip?.id === m.id ? selectedClip.text : m.answer;
        if (!navigator.clipboard) { setStatus("Select the text and use your device’s Copy command."); return; }
        void navigator.clipboard.writeText(text).then(() => setStatus("Copied to clipboard.")).catch(() => setStatus("Select the text and use your device’s Copy command."));
      }}>Copy</button>{selectedClip?.id === m.id && <button className="text-button" onClick={() => setSelectedClip(undefined)}>Use whole answer</button>}</div>
      <details className="research-evidence"><summary>Sources ({m.sources.length})</summary>{m.sources.map(s => <div id={`research-source-${m.id}-${s.id}`} key={s.id}><SourceLink source={s} /><p>{s.excerpt}</p></div>)}</details>
    </article>)}</div>
    {!messages.length && !jobs.length && <p className="research-empty">Ask about this passage, compare ideas in your books, or explore a topic on the web. Answers keep links to their evidence.</p>}
    <p className="research-footnote">AI can misread or misunderstand sources. Check the cited passages. Free allowances apply; new research pauses when they run out.</p>
    {clip && <SaveResearch text={clip.text} sources={clip.sources} passage={currentSelection} onClose={() => { setClip(undefined); setSelectedClip(undefined); }} />}
  </section>;
}
