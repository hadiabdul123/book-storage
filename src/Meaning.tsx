import { useEffect, useState } from "react";
import { normalizeWord, dictionaryQueryError, dictionarySource, definitionNote, type DictionaryEntry } from "./dictionary";
import {
  lookupLocalMeaning, lookupReferences, onlinePreferenceKey, referenceNote,
  type ReferenceResult,
} from "./meaningLookup";

export function Meaning({ term, onAdd, compact = false, onExplain }: {
  term: string;
  onAdd?: (text: string) => Promise<void>;
  compact?: boolean;
  onExplain?: () => void;
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
      if (result.valid && (result.needsOnline || onlineAttempt > 0)) {
        setOnlineBusy(online);
        const found = await lookupReferences(result.term, { signal: controller.signal, allowNetwork: online, refresh: onlineAttempt > 0 });
        if (active) {
          setReferences(found);
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
    <section className="meaning-panel">
      {onExplain && <button className="text-button" onClick={onExplain}>Explain in this passage</button>}
      {compact && !editingWord && (
        <button className="text-button compact-dictionary-edit" onClick={() => setEditingWord(true)}>Change word</button>
      )}
      {(!compact || editingWord) && (
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
