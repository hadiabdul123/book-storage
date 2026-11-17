import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, list, save } from "./db";
import { now, uid } from "./model";
import { ResearchPanel } from "./ResearchPanel";
import { BrowsePages, SourceNavigator, pageOf, useBrowseState } from "./browse";
import "./researchBrowser.css";
export function ResearchBrowser() {
  const [error, setError] = useState("");
  const books = useLiveQuery(() => list("book"), []) || [];
  const notebooks = useLiveQuery(() => list("notebook"), []) || [];
  const threads = useLiveQuery(() => list("research-thread"), []) || [];
  const messages = useLiveQuery(() => list("research-message"), []) || [];
  const browse = useBrowseState(), query = browse.value("rq"), book = browse.value("book"), notebook = browse.value("researchNotebook"), selected = browse.value("thread");
  const summaries = useMemo(() => {
    const map = new Map<string, { text: string; count: number; updated: string; preview: string }>();
    for (const m of messages) {
      const prior = map.get(m.threadId) || { text: "", count: 0, updated: "", preview: "" };
      prior.text += ` ${m.question} ${m.answer}`; prior.count++;
      if (m.createdAt >= prior.updated) { prior.updated = m.createdAt; prior.preview = m.question; }
      map.set(m.threadId, prior);
    }
    return map;
  }, [messages]);
  const filtered = threads.filter(t => (!book || t.bookId === book) && (!notebook || t.notebookId === notebook) && `${t.title} ${summaries.get(t.id)?.text || ""}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => (summaries.get(b.id)?.updated || b.createdAt).localeCompare(summaries.get(a.id)?.updated || a.createdAt));
  const page = pageOf(filtered, browse.value("rpage"));
  const active = threads.find(t => t.id === selected);
  const sources = [...books.map(b => ({ id: `book:${b.id}`, title: b.title, detail: b.author, count: threads.filter(t => t.bookId === b.id).length })), ...notebooks.map(n => ({ id: `notebook:${n.id}`, title: n.title, detail: "Notebook", count: threads.filter(t => t.notebookId === n.id).length }))];
  return <div className={`research-browser ${active ? "research-detail-open" : ""}`}>
    {error && <p className="notice" role="status">{error}</p>}
    <div className="research-browser-tools"><label className="search-field"><input aria-label="Search research conversations" placeholder="Search questions, answers, or titles" value={query} onChange={e => browse.update({ rq: e.target.value, rpage: "1" })} /></label><button className="primary" onClick={async () => {
      const thread = { id: uid(), title: "New research", createdAt: now(), ...(book ? { bookId: book } : {}), ...(notebook ? { notebookId: notebook } : {}) };
      try { await save("research-thread", thread); browse.update({ thread: thread.id }, false); } catch (e) { setError(e instanceof Error ? e.message : "Could not save the conversation. Please try again."); }
    }}>New research</button>{(query || book || notebook) && <button className="text-button" onClick={() => browse.update({ rq: "", book: "", researchNotebook: "", thread: "", rpage: "1" })}>Clear research filters</button>}</div>
    <div className="source-layout"><SourceNavigator total={threads.length} label="Research sources" value={book ? `book:${book}` : notebook ? `notebook:${notebook}` : ""} items={sources} onChange={id => browse.update({ book: id.startsWith("book:") ? id.slice(5) : "", researchNotebook: id.startsWith("notebook:") ? id.slice(9) : "", thread: "", rpage: "1" })} />
    <div className="research-history-layout"><aside className="research-conversation-list"><h2>Conversations</h2><nav aria-label="Saved research conversations">{page.items.map(t => <button key={t.id} aria-current={selected === t.id ? "page" : undefined} onClick={() => browse.update({ thread: t.id }, false)}><strong>{t.title}</strong><span>{summaries.get(t.id)?.preview || "Ready for your question"}</span><small>{books.find(b => b.id === t.bookId)?.title || notebooks.find(n => n.id === t.notebookId)?.title || "General research"} · {summaries.get(t.id)?.count || 0} answers</small></button>)}</nav>{!filtered.length && <p>No matching conversations. Start research or clear your filters.</p>}<BrowsePages {...page} label="Conversations" onChange={n => browse.update({ rpage: String(n) })} /></aside>
    <main className="research-browser-detail">{active ? <><div className="research-browser-actions"><button className="text-button" onClick={() => browse.update({ thread: "" })}>Back to conversations</button><button className="text-button" onClick={async () => { const title = prompt("Conversation title", active.title)?.trim(); if (title) try { await save("research-thread", { ...active, title: title.slice(0, 150) }); } catch { setError("Could not rename this conversation. Please try again."); } }}>Rename conversation</button></div><ResearchPanel key={active.id} initialThreadId={active.id} book={books.find(b => b.id === active.bookId)} notebookId={active.notebookId} onThreadChange={id => browse.update({ thread: id }, false)} /></> : <div className="research-browser-welcome"><h2>Follow a question</h2><p>Choose a book or notebook, reopen a conversation, or start a new one. Your saved answers and sources stay together.</p></div>}</main></div></div>
  </div>;
}
