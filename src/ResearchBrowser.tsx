import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, get, list, save } from "./db";
import { now, uid } from "./model";
import { ResearchPanel } from "./ResearchPanel";
import { BrowsePages, SourceNavigator, pageOf, useBrowseState } from "./browse";
import { ItemMenu, RenameItem } from "./ItemMenu";
import { cancelResearch } from "./research";
import { BookComparisonPicker, queueBookComparison } from "./BookComparison";
import { Columns2 } from "lucide-react";
import type { ResearchThread } from "./researchTypes";
import "./researchBrowser.css";
export function ResearchBrowser() {
  const [error, setError] = useState("");
  const [rename, setRename] = useState<ResearchThread>();
  const [compare, setCompare] = useState(false);
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
  const filtered = threads.filter(t => (!book || t.bookId === book || t.scope?.bookIds.includes(book)) && (!notebook || t.notebookId === notebook) && `${t.title} ${summaries.get(t.id)?.text || ""}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => (summaries.get(b.id)?.updated || b.createdAt).localeCompare(summaries.get(a.id)?.updated || a.createdAt));
  const page = pageOf(filtered, browse.value("rpage"));
  const active = threads.find(t => t.id === selected);
  const sources = [...books.map(b => ({ id: `book:${b.id}`, title: b.title, detail: b.author, count: threads.filter(t => t.bookId === b.id || t.scope?.bookIds.includes(b.id)).length })), ...notebooks.map(n => ({ id: `notebook:${n.id}`, title: n.title, detail: "Notebook", count: threads.filter(t => t.notebookId === n.id).length }))];
  async function trash(thread: ResearchThread) {
    if (!confirm(`Move “${thread.title}” to Trash?`)) return;
    try {
      const latest = await get("research-thread", thread.id);
      if (!latest) return;
      await save("research-thread", latest, true);
      const jobs = await db.researchJobs.where("threadId").equals(thread.id).toArray();
      for (const job of jobs) if (job.state !== "done") await cancelResearch(job.id);
      if (selected === thread.id) browse.update({ thread: "" });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  return <div className={`research-browser ${active ? "research-detail-open" : ""}`}>
    {error && <p className="notice" role="status">{error}</p>}
    <div className="research-browser-tools"><button className="primary" onClick={() => setCompare(true)}><Columns2 size={17} />Compare books</button><label className="search-field"><input aria-label="Search research conversations" placeholder="Search saved research" value={query} onChange={e => browse.update({ rq: e.target.value, rpage: "1" })} /></label><button className="secondary" aria-label="New research" onClick={async () => {
      const thread = { id: uid(), title: "New research", createdAt: now(), ...(book ? { bookId: book } : {}), ...(notebook ? { notebookId: notebook } : {}) };
      try { await save("research-thread", thread); browse.update({ thread: thread.id }, false); } catch (e) { setError(e instanceof Error ? e.message : "Could not save the conversation. Please try again."); }
    }}>Ask a question</button>{(query || book || notebook) && <button className="text-button" onClick={() => browse.update({ rq: "", book: "", researchNotebook: "", thread: "", rpage: "1" })}>Clear research filters</button>}</div>
    <div className="research-history-layout"><aside className="research-conversation-list"><h2>Saved research</h2>
    <SourceNavigator total={threads.length} label="Research sources" value={book ? `book:${book}` : notebook ? `notebook:${notebook}` : ""} items={sources} onChange={id => browse.update({ book: id.startsWith("book:") ? id.slice(5) : "", researchNotebook: id.startsWith("notebook:") ? id.slice(9) : "", thread: "", rpage: "1" })} />
    <nav aria-label="Saved research conversations">{page.items.map(t => <ItemMenu title={t.title} key={t.id} actions={[
      { label: "Rename", run: () => setRename(t) },
      { label: "Move to Trash", danger: true, run: () => void trash(t) },
    ]}><button aria-current={selected === t.id ? "page" : undefined} onClick={() => browse.update({ thread: t.id }, false)}><strong>{t.title}</strong><span>{summaries.get(t.id)?.preview}</span><small>{books.find(b => b.id === t.bookId)?.title || notebooks.find(n => n.id === t.notebookId)?.title || "General research"} · {summaries.get(t.id)?.count || 0} answers</small></button></ItemMenu>)}</nav>{!filtered.length && <p>No matching conversations.</p>}<BrowsePages {...page} label="Conversations" onChange={n => browse.update({ rpage: String(n) })} /></aside>
    <main className="research-browser-detail">{active ? <><div className="research-browser-actions"><button className="text-button" onClick={() => browse.update({ thread: "" })}>Back to conversations</button><button className="text-button" onClick={() => setRename(active)}>Rename conversation</button></div><ResearchPanel key={active.id} initialThreadId={active.id} libraryFirst book={books.find(b => b.id === active.bookId)} notebookId={active.notebookId} onThreadChange={id => browse.update({ thread: id }, false)} /></> : <div className="research-browser-welcome"><h2>Study across your books</h2><p>Choose books and a question to compare their answers with passages you can open and save.</p></div>}</main></div>
    {compare && <BookComparisonPicker books={books} selected={book ? [book] : []} onClose={() => setCompare(false)} onCompare={async (question, chosen) => {
      const thread: ResearchThread = { id: uid(), title: question.slice(0, 150), createdAt: now(), notebookId: notebook || undefined,
        scope: { bookIds: chosen.map(book => book.bookId), noteIds: [], highlightIds: [] } };
      await save("research-thread", thread);
      await queueBookComparison(thread.id, question, chosen);
      setCompare(false);
      browse.update({ thread: thread.id, rq: "", rpage: "1" }, false);
    }} />}
    {rename && <RenameItem label="conversation" value={rename.title} onClose={() => setRename(undefined)} onSave={async title => {
      const latest = await get("research-thread", rename.id);
      if (!latest) throw new Error("The conversation was removed.");
      await save("research-thread", { ...latest, title });
    }} />}
  </div>;
}
