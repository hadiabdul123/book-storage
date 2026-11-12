import { useEffect, useState } from "react";
import {
  lookupEnglish,
  normalizeWord,
  dictionarySource,
  definitionNote,
  type DictionaryEntry,
} from "./dictionary";
export function Meaning({
  term,
  onAdd,
  compact = false,
}: {
  term: string;
  onAdd?: (text: string) => Promise<void>;
  compact?: boolean;
}) {
  const [input, setInput] = useState(term),
    [query, setQuery] = useState(term);
  const [editingWord, setEditingWord] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<DictionaryEntry[]>([]),
    [status, setStatus] = useState("Looking up…"),
    [adding, setAdding] = useState(false);
  useEffect(() => {
    setExpanded(false);
    setInput(term);
    setQuery(term);
  }, [term]);
  useEffect(() => {
    let active = true;
    setEntries([]);
    setStatus("Looking up…");
    void lookupEnglish(query)
      .then((result) => {
        if (active) {
          setEntries(result);
          setStatus(
            result.length
              ? ""
              : "No definition found. Try a different spelling or base word.",
          );
        }
      })
      .catch((e) => {
        if (active) setStatus(e.message);
      });
    return () => {
      active = false;
    };
  }, [query]);
  return (
    <section className="meaning-panel">
      {compact && !editingWord && (
        <button
          className="text-button compact-dictionary-edit"
          onClick={() => setEditingWord(true)}
        >
          Change word
        </button>
      )}
      {(!compact || editingWord) && (
        <form
          className="meaning-search"
          onSubmit={(e) => {
            e.preventDefault();
            setExpanded(false);
            setQuery(input);
          }}
        >
          <label>
            Look up a word
            <input
              aria-label="Dictionary word"
              value={input}
              maxLength={100}
              onChange={(e) => setInput(e.target.value)}
            />
          </label>
          <button className="secondary">Look up</button>
        </form>
      )}
      {status && <p role="status">{status}</p>}
      {(expanded ? entries : entries.slice(0, 1)).map((entry, i) => (
        <div
          className="dictionary-entry"
          key={`${entry.word}-${entry.partOfSpeech}-${i}`}
        >
          <h3>{entry.word}</h3>
          <p className="muted">
            {entry.partOfSpeech}
            {normalizeWord(entry.word) !== normalizeWord(query)
              ? ` · Base word for “${query}”`
              : ""}
          </p>
          <p className="muted">
            {entry.source === "simple"
              ? "Simple meaning"
              : "Standard dictionary meaning"}{" "}
            &middot;{" "}
            <a
              href={dictionarySource(entry).url}
              target="_blank"
              rel="noreferrer"
            >
              {dictionarySource(entry).name}
            </a>
          </p>
          <ol>
            {(expanded ? entry.senses : entry.senses.slice(0, 1)).map(
              (sense, n) => (
                <li key={n}>
                  <p>{sense.definitions.join("; ")}</p>
                  {(expanded ? sense.examples : sense.examples.slice(0, 1)).map(
                    (example, j) => (
                      <p className="dictionary-example" key={j}>
                        “{example}”
                      </p>
                    ),
                  )}
                  {expanded && !!sense.synonyms.length && (
                    <p className="muted">
                      Synonyms: {sense.synonyms.join(", ")}
                    </p>
                  )}
                  {onAdd && (
                    <button
                      className="text-button"
                      disabled={adding}
                      onClick={async () => {
                        setAdding(true);
                        try {
                          await onAdd(definitionNote(entry, sense));
                        } catch (e) {
                          setStatus(String(e));
                        } finally {
                          setAdding(false);
                        }
                      }}
                    >
                      Add to page note
                    </button>
                  )}
                </li>
              ),
            )}
          </ol>
        </div>
      ))}
      {entries.length > 0 && (
        <button className="text-button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Fewer meanings" : "More meanings"}
        </button>
      )}
      <p className="dictionary-credit">
        Lookup stays on this device. Simple English Wiktionary definitions: CC
        BY-SA 4.0. WordNet definitions: CC BY 4.0.{" "}
        <a
          href={`${import.meta.env.BASE_URL}dictionary/licenses.html`}
          target="_blank"
          rel="noreferrer"
        >
          Attribution and licenses
        </a>
        .
      </p>
    </section>
  );
}
