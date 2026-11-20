import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { BookOpen, Columns2, FileSearch, Globe, Library, ListFilter, MessageSquare, MoreHorizontal, NotebookPen, X } from "lucide-react";
import { BookComparisonPicker, BookComparisonView, queueBookComparison } from "./BookComparison";
import { BookReviewPicker } from "./BookReviewPicker";
import { reviewQuestion } from "./bookReview";
import { db, get, save } from "./db";
import type { Book } from "./model";
import { ResearchAnswer } from "./ResearchAnswer";
import { cancelResearch, enqueueResearch, retryResearch } from "./research";
import type { ResearchJob, ResearchMessage, ResearchScope, ResearchThread, SourceRef } from "./researchTypes";
import { SaveResearch } from "./SaveResearch";
import { indexBook, retrieveSources, searchPreparedPassages } from "./sourceIndex";
import { citedSources } from "./sourceReferences";
import { PassageResults, StudyEvidence } from "./StudyEvidence";
import { StudySources, studySourceCount, type StudySourceOption } from "./StudySources";

type StudyResult = { id: string; question: string; createdAt: string; kind: string; job?: ResearchJob; message?: ResearchMessage };
type PassageSearch = { query: string; hits: SourceRef[]; notice?: string };

function pageNumbers(pages: Set<number>) {
  const spans: { from: number; to: number }[] = [];
  for (const page of [...pages].sort((a,b) => a-b)) {
    const last = spans.at(-1);
    if (last && last.to + 1 === page) last.to = page;
    else spans.push({ from:page,to:page });
  }
  return spans.map(s => s.from === s.to ? String(s.from) : s.from + "–" + s.to).join(", ");
}

function resultKind(question: string, mode: string, comparison: unknown) {
  if (comparison) return "Comparison";
  if (mode === "web") return "Web search";
  if (question.startsWith("Review ") && question.includes("Cite the supplied excerpts and flag gaps in coverage.")) return "Chapter review";
  return mode === "explain" ? "Passage explanation" : "Source answer";
}

export function StudyWorkspace({ study, books, options, messages, resultId, onSelectResult }: {
  study: ResearchThread; books: Book[]; options: StudySourceOption[]; messages: ResearchMessage[];
  resultId: string; onSelectResult: (id: string) => void;
}) {
  const [question, setQuestion] = useState("");
  const [search, setSearch] = useState<PassageSearch>();
  const [showSearch, setShowSearch] = useState(false);
  const [followUp, setFollowUp] = useState<ResearchMessage>();
  const [status, setStatus] = useState("");
  const [panel, setPanel] = useState<"sources" | "compare" | "review">();
  const [clip, setClip] = useState<{ text: string; sources: SourceRef[] }>();
  const [evidence, setEvidence] = useState<{ resultId: string; sourceId?: string }>();
  const [preparing, setPreparing] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const prepare = useRef<AbortController | null>(null);
  const questionInput = useRef<HTMLTextAreaElement>(null);
  const editedQuestion = useRef(false);
  const draftKey = `study-draft:${study.id}`;
  const jobs = useLiveQuery(() => db.researchJobs.where("threadId").equals(study.id).toArray(), [study.id]) || [];
  const scope = study.scope || { bookIds: study.bookId && !study.selection ? [study.bookId] : [], noteIds: [], highlightIds: [] };
  const selected = options.filter(source => scope[source.kind].includes(source.id));
  const studyBooks = scope.bookIds.flatMap(id => books.filter(book => book.id === id));
  const count = studySourceCount(scope);
  const answers = new Set(messages.map(message => message.id));
  const results: StudyResult[] = [
    ...messages.map(message => ({ ...message, kind: resultKind(message.question, message.mode, message.comparison), message })),
    ...jobs.filter(job => !answers.has(job.id) && job.state !== "done" && job.state !== "cancelled").map(job => ({
      id: job.id, question: job.request.question, createdAt: job.createdAt,
      kind: resultKind(job.request.question, job.request.mode, job.request.comparison), job,
    })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const current = results.find(item => item.id === resultId) || results[0];
  const message = current?.message;
  const job = current?.job;

  useEffect(() => {
    let active = true;
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update); window.addEventListener("offline", update);
    if (study.selection) setQuestion("Explain this passage in simple terms.");
    void db.meta.get(draftKey).then(value => value || db.meta.get(`research-draft:${study.id}`)).then(value => {
      if (!active || editedQuestion.current || !value) return;
      const draft = JSON.parse(value.value);
      if (typeof draft.question === "string") setQuestion(draft.question.slice(0, 1500));
    }).catch(() => {});
    return () => {
      active = false;
      window.removeEventListener("online", update); window.removeEventListener("offline", update);
      prepare.current?.abort();
    };
  }, [draftKey]);

  function changeQuestion(value: string) {
    editedQuestion.current = true;
    setQuestion(value);
    void db.meta.put({ key: draftKey, value: JSON.stringify({ question: value }) }).catch(() => {});
  }

  async function saveScope(next: ResearchScope) {
    await db.transaction("rw", db.rows, db.outbox, db.conflicts, db.meta, async () => {
      const latest = await get("research-thread", study.id);
      if (!latest) throw new Error("This study is no longer available.");
      await save("research-thread", { ...latest, scope: next });
    });
    setStatus("");
  }

  function saveFinding(text: string, sources: SourceRef[]) {
    const selection = window.getSelection();
    const answer = selection?.anchorNode?.parentElement?.closest(".study-answer");
    const excerpt = answer && selection?.focusNode && answer.contains(selection.focusNode) ? selection.toString().trim() : "";
    const citations = excerpt ? citedSources(excerpt,sources) : [];
    setClip({ text:excerpt || text, sources:citations.length ? citations : sources });
  }
  function inspect(source: SourceRef) {
    if (!message) return;
    setEvidence({ resultId: message.id, sourceId: source.id });
    requestAnimationFrame(() => document.getElementById(`study-evidence-${message.id}-excerpt`)?.focus());
  }
  function showResult(id: string) {
    setShowSearch(false);
    setEvidence(undefined);
    onSelectResult(id);
  }
  function afterQueue(id: string) {
    showResult(id);
    setFollowUp(undefined);
    changeQuestion("");
  }

  function openAction(action: "review" | "compare") {
    if (action === "compare") {
      if (count > 4 && (scope.ranges?.length || scope.noteIds.length || scope.highlightIds.length)) { setStatus("Choose up to four sources for a side-by-side comparison."); setPanel("sources"); return; }
      if (count >= 2 && (scope.ranges?.length || scope.noteIds.length || scope.highlightIds.length)) { void run("compare"); return; }
      if (studyBooks.length < 2) {
        setStatus("Add at least two books to compare them.");
        setPanel("sources");
      } else setPanel("compare");
    } else if (!studyBooks.length) {
      setStatus("Add a book to review its chapters.");
      setPanel("sources");
    } else setPanel("review");
  }

  async function run(action: "find" | "sources" | "web" | "explain" | "compare") {
    const query = question.trim() || (action === "compare" ? "Where do these sources agree and differ?" : "");
    if (prepare.current) return;
    if (!query) { setStatus("Enter a question or search phrase."); questionInput.current?.focus(); return; }
    if ((action === "find" || action === "sources" || action === "compare") && !selected.length && !(action === "sources" && study.selection)) {
      setStatus("Choose sources for this study first.");
      setPanel("sources"); return;
    }
    const abort = new AbortController();
    prepare.current = abort;
    setPreparing(true); setStatus("");
    try {
      const problems: string[] = [];
      const partial: string[] = [];
      if (action === "find" || action === "sources" || action === "compare") {
        for (const book of studyBooks) {
          try {
            const missing = await indexBook(book, abort.signal, setStatus);
            const limits = scope.ranges?.filter(r => r.bookId === book.id);
            if ((missing || limits?.length) && book.format === "pdf") {
              const lastPage = Number((await db.meta.get("pdf-page-count:" + book.hash))?.value);
              const bounds = limits?.length ? limits : [{ start:1, end:lastPage }];
              const readable = new Set((await db.chunks.where("bookId").equals(book.id).toArray()).filter(c => c.hash === book.hash).map(c => c.unit));
              const gaps = new Set<number>();
              for (const r of bounds) for (let page = r.start; page <= r.end && page <= 100000; page++) if (!readable.has(page)) gaps.add(page);
              if (gaps.size) partial.push(book.title + " · pages " + pageNumbers(gaps));
            } else if (missing) partial.push(`${book.title} (${missing} ${book.format === "pdf" ? "pages" : "sections"})`);
          }
          catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
          abort.signal.throwIfAborted();
        }
      }
      const noteIds = selected.filter(item => item.kind === "noteIds").map(item => item.id);
      const highlightIds = selected.filter(item => item.kind === "highlightIds").map(item => item.id);
      if (action === "find") {
        const result = await searchPreparedPassages(query, studyBooks, { ...scope, noteIds, highlightIds }, abort.signal);
        abort.signal.throwIfAborted();
        const missing = studyBooks.filter(book => !result.indexedBooks.has(book.id));
        if (missing.length) problems.push(`No prepared text on this device for ${missing.map(book => book.title).join(", ")}. Scanned pages need text recognition.`);
        if (!missing.length && partial.length) problems.push(`Some pages or sections had no readable text and were skipped in ${partial.join(", ")}.`);
        setSearch({ query, hits: result.hits, notice: problems.join(" ") });
        setShowSearch(true); setStatus("");
        return;
      }
      const contextual = action === "explain" || (action === "sources" && !selected.length && !!study.selection);
      const mode = contextual ? "explain" : action === "compare" ? "sources" : action;
      let sources: SourceRef[] = [];
      if (contextual && study.selection) sources = [{ ...study.selection, excerpt: study.selection.excerpt.slice(0, 2400) }];
      if (mode === "sources") {
        if (problems.length) throw new Error(problems.join(" "));
        sources = await retrieveSources(query, scope.bookIds, noteIds, highlightIds, studyBooks, scope.ranges);
        const missing = studyBooks.filter(book => !sources.some(source => source.bookId === book.id && !source.annotationId));
        if (missing.length && partial.length) throw new Error("No readable text in the selection. Skipped " + partial.join(", "));
        if (missing.length) throw new Error(`Prepare readable text for ${missing.map(book => book.title).join(", ")} or remove it from the study sources. Scanned pages need text recognition.`);
        if (!sources.length) throw new Error("The selected sources have no readable text.");
      }
      abort.signal.throwIfAborted();
      const id = await enqueueResearch(study.id, {
        mode, question: query, sources,
        ...(action === "compare" ? { comparison: { books:selected.map(item => ({
          bookId: item.kind === "noteIds" ? "note:" + item.id : item.kind === "highlightIds" ? "highlight:" + item.id : item.id,
          title:(item.title + (scope.ranges?.filter(r => r.bookId === item.id).map(r => " · " + r.label).join("") || "")).slice(0,300)
        })) } } : {}), ...(mode === "web" ? { searchQuery: query.slice(0, 500) } : {}),
        history: followUp && !scope.ranges?.length ? [{ question: followUp.question.slice(0, 1500), answer: followUp.answer.slice(0, 1800) }] : [],
      });
      if (!abort.signal.aborted) { afterQueue(id); setStatus(partial.length ? "Skipped unreadable text: " + partial.join(", ") : ""); }
    } catch (error) {
      if (!abort.signal.aborted) setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      prepare.current = null; setPreparing(false);
    }
  }

  async function changeJob(id: string, cancel: boolean) {
    try { if (cancel) await cancelResearch(id); else await retryResearch(id); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  }

  return <section className="study-workspace" aria-label="Study workspace">
    <header className="study-heading">
      <h2>{study.title}</h2>
      <div className="study-source-strip">
        <button className="secondary" onClick={() => setPanel("sources")} disabled={preparing}><Library size={17} />{count ? `Sources (${count})` : "Choose sources"}</button>
        {!!selected.length && <ul aria-label="Selected sources">{selected.map(item => <li key={`${item.kind}-${item.id}`} title={item.title}>{item.title}{item.kind === "bookIds" && scope.ranges?.filter(r => r.bookId === item.id).map(r => " · " + r.label).join("")}</li>)}</ul>}
        {count > selected.length && <small>{count - selected.length} missing {count - selected.length === 1 ? "source" : "sources"}</small>}
      </div>
      {study.selection && <details className="study-selected-passage"><summary>Original passage</summary><blockquote>{study.selection.excerpt}</blockquote></details>}
    </header>
    <form className="study-question" onSubmit={event => { event.preventDefault(); void run("sources"); }}>
      {followUp && <div className="study-follow-up">Following up on <strong>{followUp.question}</strong><button className="icon-button" type="button" aria-label="Start an independent question" onClick={() => setFollowUp(undefined)}><X size={16} /></button></div>}
      <label htmlFor="study-question">Research question</label>
      <textarea id="study-question" ref={questionInput} aria-label="Research question" rows={2} maxLength={1500}
        placeholder="Enter a question or search for a passage" value={question} onChange={event => changeQuestion(event.target.value)} />
      <div className="study-question-actions">

        <button type="submit" className="primary" disabled={preparing}><MessageSquare size={16} />{online ? "Investigate" : "Queue question"}</button>
        <button type="button" className="secondary" disabled={preparing} onClick={() => openAction("compare")}><Columns2 size={17} />Compare sources</button>
        <button type="button" className="secondary" disabled={preparing} onClick={() => openAction("review")}><BookOpen size={16} />Review chapters</button>
        <button type="button" className="secondary" disabled={preparing} onClick={() => void run("find")}><FileSearch size={17} />Find passages</button>
        <details className="study-more"><summary><MoreHorizontal size={18} />More actions</summary><div>
          <button type="button" disabled={preparing} onClick={event => { event.currentTarget.closest("details")!.open = false; void run("web"); }}><Globe size={16} />Search the web</button>
          {study.selection && <button type="button" disabled={preparing} onClick={event => { event.currentTarget.closest("details")!.open = false; void run("explain"); }}>Explain passage</button>}
        </div></details>
      </div>
      {(status || preparing) && <div className="study-status" role="status">{status || "Preparing sources…"}
        {preparing && <button type="button" className="text-button" onClick={() => { prepare.current?.abort(); setStatus("Preparation cancelled."); }}>Cancel</button>}
      </div>}
    </form>
    <section className="study-results" aria-label="Study results">
      {(results.length > 0 || search) && <label className="study-result-picker"><ListFilter size={18} /><span>Results</span>
        <select aria-label="Study results" value={showSearch && search ? "passages" : current?.id || ""} onChange={event => {
          if (event.target.value === "passages") setShowSearch(true); else showResult(event.target.value);
        }}>
          {search && <option value="passages">Passages · {search.query}</option>}
          {results.map(item => <option key={item.id} value={item.id}>{item.kind} · {item.question}</option>)}
        </select>
      </label>}
      {showSearch && search ? <PassageResults {...search} onSave={saveFinding} /> : job ? <article className="research-pending study-job">
        <h3>{job.request.question}</h3>
        <p role="status">{job.message || (online ? "Waiting to start…" : "Saved for when you’re online.")}</p>
        <div className="button-row">
          {["error", "paused"].includes(job.state) && <button className="secondary" onClick={() => void changeJob(job.id, false)}>Retry</button>}
          <button className="text-button" onClick={() => void changeJob(job.id, true)}>Cancel question</button>
        </div>
      </article> : message ? <div className="study-result-content">
        <div className="study-result-layout" data-evidence={!!message.sources.length}>
          <div className="research-conversation">
            {message.comparison ? <BookComparisonView message={{ ...message, comparison: message.comparison }} onSave={saveFinding} onInspect={inspect} />
              : <article className="study-answer research-answer">
                <h3>{message.question}</h3>
                <div className="research-answer-text"><ResearchAnswer text={message.answer} sources={message.sources} prefix={message.id} onInspect={inspect} /></div>
                <button className="text-button" onPointerDown={e => e.preventDefault()} onClick={() => {
                  const cited = citedSources(message.answer, message.sources);
                  saveFinding(message.answer, cited.length ? cited : message.sources);
                }}><NotebookPen size={16} />Save finding or selection</button>
              </article>}
            <button className="text-button study-follow-button" onClick={() => { setFollowUp(message); questionInput.current?.focus(); }}>Ask a follow-up</button>
          </div>
          <StudyEvidence id={`study-evidence-${message.id}`} sources={message.sources}
            selected={evidence?.resultId === message.id ? evidence.sourceId : undefined} expanded={evidence?.resultId === message.id}
            onExpand={() => setEvidence(evidence?.resultId === message.id ? undefined : { resultId: message.id })} onSelect={id => setEvidence({ resultId: message.id, sourceId: id })}
            onSave={saveFinding} />
        </div>
      </div> : null}
    </section>
    {panel === "sources" && <StudySources books={books} scope={scope} options={options} onClose={() => setPanel(undefined)} onSave={saveScope} />}
    {panel === "compare" && <BookComparisonPicker books={studyBooks} selected={studyBooks.length <= 4 ? studyBooks.map(book => book.id) : []}
      question={question} onClose={() => setPanel(undefined)} onCompare={async (text, chosen) => {
        const id = await queueBookComparison(study.id, text, chosen);
        setPanel(undefined); afterQueue(id);
      }} />}
    {panel === "review" && <BookReviewPicker ranges={scope.ranges} books={studyBooks} focus={question} previous={new Set(results.map(item => item.question))}
      onClose={() => setPanel(undefined)} returnLabel="Back to study" onReview={async sections => {
        let first: string | undefined;
        for (const section of sections) {
          const id = await enqueueResearch(study.id, { mode: "sources", question: reviewQuestion(section, question), sources: section.sources, history: [] });
          first ??= id;
        }
        if (first) showResult(first);
      }} />}
    {clip && <SaveResearch studyId={study.id} text={clip.text} sources={clip.sources} passage={study.selection} onClose={() => setClip(undefined)} />}
  </section>;
}
