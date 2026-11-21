import { useEffect, useRef, useState } from "react";
import { MeaningGallery, type ImageAction } from "./MeaningGallery";
import { lookupAiMeaning } from "./meaningAi";
import type { SourceRef } from "./researchTypes";
import { normalizeWord, dictionaryQueryError, dictionarySource, definitionNote, type DictionaryEntry } from "./dictionary";
import {
  lookupLocalMeaning, lookupReferences, onlinePreferenceKey, referenceNote,
  type ReferenceResult,
} from "./meaningLookup";

function allowOnlineReferences() {
  try { return localStorage.getItem(onlinePreferenceKey) !== "false"; }
  catch { return true; }
}

export function Meaning({ term, onAdd, compact = false, onExplain, context, onImage }: {
  onImage?: ImageAction;
  term: string;
  onAdd?: (text: string) => Promise<void>;
  compact?: boolean;
  onExplain?: () => void;
  context?: () => Promise<SourceRef | undefined>;
}) {
  const [input, setInput] = useState(term), [query, setQuery] = useState(term);
  const [editing, setEditing] = useState(false), [dictionary, setDictionary] = useState(false);
  const [attempt, setAttempt] = useState(0), [answer, setAnswer] = useState<{ answer: string; model: string; visualQuery?: string; cached: boolean }>();
  const [status, setStatus] = useState(""), [busy, setBusy] = useState(false), [adding, setAdding] = useState(false);
  const [partial,setPartial] = useState("");
  const currentContext = useRef(context); currentContext.current = context;
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => { setInput(term); setQuery(term); setEditing(false); setDictionary(false); setAttempt(0); }, [term]);
  useEffect(() => {
    const controller = new AbortController(); request.current = controller; setPartial("");
    if (dictionary) { setAnswer(undefined); setBusy(false); return () => controller.abort(); }
    setAnswer(undefined); setBusy(false); setStatus("");
    if (!query.trim()) return () => controller.abort();
    setBusy(true);
    void lookupAiMeaning(query, { signal: controller.signal, onText: text => { if (!controller.signal.aborted) setPartial(text); }, context: () => currentContext.current?.() || Promise.resolve(undefined), refresh: attempt > 0 })
      .then(result => { if (!controller.signal.aborted) setAnswer(result); })
      .catch(error => {
        if (controller.signal.aborted) return;
        const code = (error as { code?: string }).code;
        setStatus(code === "quota" ? "AI allowance reached. Showing the dictionary." :
          error instanceof Error && /^(Offline\.|AI timed out\.|Select a word)/.test(error.message) ? error.message : "AI unavailable. Showing the dictionary.");
        setDictionary(true);
      }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [query, attempt, dictionary]);
  return <section className="meaning-panel">
    {compact && !editing && <button className="text-button compact-dictionary-edit" onClick={() => setEditing(true)}>Change word</button>}
    {(!compact || editing) && <form className="meaning-search" onSubmit={event => {
      event.preventDefault(); setDictionary(false); setAttempt(0); setQuery(input); if (input === query) setAttempt(n => n + 1);
    }}><label>Look up a word or phrase<input aria-label="Dictionary word" maxLength={100} value={input} onChange={event => setInput(event.target.value)} /></label><button className="secondary">Look up</button></form>}
    {busy && !partial && <p role="status">Explaining with Groq…</p>}
    {status && <p role="status">{status}</p>}
    {(answer || partial) && <article className="ai-meaning">
      <h3>{query}</h3><p className="muted">AI explanation · Groq{answer?.cached ? " · Saved on this device" : ""}</p>
      {(answer?.answer || partial).split(/\n\s*\n/).map((block, i) => {
        const at = block.indexOf("\n");
        return <div key={i}>{at > 0 ? <><strong>{block.slice(0, at)}</strong><p style={{ whiteSpace: "pre-line" }}>{block.slice(at + 1)}</p></> : <p>{block}</p>}{i === 0 && answer?.visualQuery && allowOnlineReferences() && <MeaningGallery key={answer.visualQuery} topic={answer.visualQuery} onImage={onImage}/>}</div>;
      })}
      {answer && onAdd && <button className="text-button" disabled={adding} onClick={async () => {
        setAdding(true); try { await onAdd(`${query}\n\n${answer.answer}\n\nAI explanation · Groq (${answer.model})`); }
        catch { setStatus("Could not save the explanation. Please try again."); } finally { setAdding(false); }
      }}>Add to page note</button>}
    </article>}
    {query.trim() && <div className="meaning-alternatives">
      <button className="text-button" aria-pressed={dictionary} onClick={() => { request.current?.abort(); setBusy(false); setDictionary(true); }}>Dictionary</button>
      {dictionary && <button className="text-button" onClick={() => { setDictionary(false); setAttempt(n => n + 1); }}>Retry AI</button>}
      {onExplain && <button className="text-button" onClick={onExplain}>Full research</button>}
    </div>}
    {dictionary && <DictionaryMeaning term={query} onAdd={onAdd} compact hideSearch />}
    <p className="dictionary-credit">Explain sends this word or phrase and a short nearby excerpt to Groq. Illustrations use Wikimedia. AI explanations can be mistaken.</p>
  </section>;
}

function DictionaryMeaning({ term, onAdd, compact = false, hideSearch = false }: {
  term: string;
  onAdd?: (text: string) => Promise<void>;
  compact?: boolean;
  hideSearch?: boolean;
}) {
  const [input, setInput] = useState(term), [query, setQuery] = useState(term);
  const [editingWord, setEditingWord] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [resolvedTerm, setResolvedTerm] = useState("");
  const [online, setOnline] = useState(() => {
    try { return localStorage.getItem(onlinePreferenceKey) !== "false"; }
    catch { return true; }
  });
  const [onlineAttempt, setOnlineAttempt] = useState(0);
  const [onlineBusy, setOnlineBusy] = useState(false);
  const [references, setReferences] = useState<ReferenceResult | null>(null);
  const [entries, setEntries] = useState<DictionaryEntry[]>([]);
  const [status, setStatus] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    setExpanded(false);
    setEditingWord(false);
    setInput(term);
    setQuery(term);
    setOnlineAttempt(0);
  }, [term]);
  useEffect(() => {
    const update = () => {
      try { setOnline(localStorage.getItem(onlinePreferenceKey) !== "false"); } catch { /* Keep the current preference. */ }
    };
    window.addEventListener("storage", update);
    window.addEventListener("leafmark-online-references-changed", update);
    return () => {
      window.removeEventListener("storage", update);
      window.removeEventListener("leafmark-online-references-changed", update);
    };
  }, []);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setEntries([]);
    setResolvedTerm("");
    setReferences(null);
    setOnlineBusy(false);
    setStatus(query.trim() ? "Looking up…" : "Select or enter a word or short phrase.");
    if (!query.trim()) return () => controller.abort();
    void lookupLocalMeaning(query).then(async (result) => {
      if (!active) return;
      setResolvedTerm(result.term);
      setEntries(result.entries);
      setStatus(result.error || (result.entries.length ? "" : "No offline definition found."));
      if (result.valid) {
        setOnlineBusy(online && onlineAttempt > 0);
        const found = await lookupReferences(result.term, { signal: controller.signal, allowNetwork: online && onlineAttempt > 0, refresh: onlineAttempt > 0 });
        if (active) {
          setReferences(found.cached || onlineAttempt > 0 || !online ? found : null);
          setOnlineBusy(false);
        }
      }
    }).catch((error) => {
      if (active) {
        setStatus(error instanceof Error ? error.message : String(error));
        setOnlineBusy(false);
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [query, online, onlineAttempt]);

  const addNote = async (text: string) => {
    if (!onAdd) return;
    setAdding(true);
    try { await onAdd(text); }
    catch (error) { setStatus(String(error)); }
    finally { setAdding(false); }
  };

  return (
    <section className="dictionary-fallback">
      {!hideSearch && compact && !editingWord && (
        <button className="text-button compact-dictionary-edit" onClick={() => setEditingWord(true)}>Change word</button>
      )}
      {!hideSearch && (!compact || editingWord) && (
        <form className="meaning-search" onSubmit={(event) => {
          event.preventDefault();
          setExpanded(false);
          setOnlineAttempt(0);
          setQuery(input);
        }}>
          <label>Look up a word or phrase
            <input aria-label="Dictionary word" value={input} maxLength={100} onChange={(event) => setInput(event.target.value)} />
          </label>
          <button className="secondary">Look up</button>
        </form>
      )}
      {resolvedTerm && normalizeWord(query) !== resolvedTerm && (
        <p className="lookup-resolution">Looking up: <strong>{resolvedTerm}</strong></p>
      )}
      {status && <p role="status">{status}</p>}
      {(expanded ? entries : entries.slice(0, 1)).map((entry, i) => (
        <div className="dictionary-entry" key={`${entry.word}-${entry.partOfSpeech}-${i}`}>
          <h3>{entry.word}</h3>
          <p className="muted">
            {entry.partOfSpeech}{entry.context ? ` · ${entry.context}` : ""}
            {normalizeWord(entry.word) !== (resolvedTerm || normalizeWord(query)) ? ` · Base word for “${resolvedTerm || query}”` : ""}
          </p>
          <ol>
            {(expanded ? entry.senses : entry.senses.slice(0, 1)).map((sense, n) => (
              <li key={n}>
                <p>{sense.definitions.join("; ")}</p>
                {(expanded ? sense.examples : sense.examples.slice(0, 1)).map((example, j) => (
                  <p className="dictionary-example" key={j}>“{example}”</p>
                ))}
                {expanded && !!sense.synonyms.length && <p className="muted">Synonyms: {sense.synonyms.join(", ")}</p>}
                {onAdd && <button className="text-button" disabled={adding} onClick={() => void addNote(definitionNote(entry, sense))}>Add to page note</button>}
              </li>
            ))}
          </ol>
          <p className="muted dictionary-source">
            {entry.source === "glossary" ? "Plain-English explanation" : entry.source === "simple" ? "Simple meaning" : "Standard dictionary meaning"}
            {" · "}<a href={dictionarySource(entry).url} target="_blank" rel="noreferrer">
              {entry.source === "glossary" ? entry.context === "Psychoanalytic theory" ? "APA Dictionary of Psychology" : "Flow, chapter 2" : dictionarySource(entry).name}
            </a>
          </p>
        </div>
      ))}
      {entries.length > 0 && (
        <button className="text-button" onClick={() => setExpanded(!expanded)}>{expanded ? "Fewer meanings" : "More meanings"}</button>
      )}
      <div className="online-references">
        {onlineBusy && <p role="status">Looking for an online reference…</p>}
        {references?.message && <p role="status">{references.message}</p>}
        {references?.references.map((ref) => (
          <div className="dictionary-reference" key={ref.url}>
            <h3><a href={ref.url} target="_blank" rel="noreferrer">{ref.title}</a></h3>
            <p className="muted">{ref.kind === "summary" ? "Online reference summary" : "Related reference"} · {ref.source} · {ref.license}</p>
            {ref.text && <p>{ref.text}</p>}
            {ref.text && onAdd && <button className="text-button" disabled={adding} onClick={() => void addNote(referenceNote(ref, references.fetchedAt))}>Add to page note</button>}
          </div>
        ))}
        {query.trim() && resolvedTerm && !dictionaryQueryError(query) && online && (
          <button className="text-button" disabled={onlineBusy} onClick={() => setOnlineAttempt((n) => n + 1)}>
            {references ? "Retry online lookup" : "Find another explanation"}
          </button>
        )}
        <label className="dictionary-online-toggle">
          <input type="checkbox" checked={online} onChange={(event) => {
            const value = event.target.checked;
            setOnline(value);
            try { localStorage.setItem(onlinePreferenceKey, String(value)); } catch { /* The setting still applies to this session. */ }
            window.dispatchEvent(new Event("leafmark-online-references-changed"));
          }} />
          Use online references
        </label>
        <p className="dictionary-credit">Online lookup sends only the word or short phrase to Wikipedia. Saved references are available offline on this device.</p>
      </div>
      <p className="dictionary-credit">
        Offline sources: Leafmark glossary; Simple English Wiktionary: CC BY-SA 4.0. WordNet: CC BY 4.0.{" "}
        <a href={`${import.meta.env.BASE_URL}dictionary/licenses.html`} target="_blank" rel="noreferrer">Attribution and licenses</a>.
      </p>
    </section>
  );
}
