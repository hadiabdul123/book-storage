import { useEffect, useState } from "react";
import {
  lookupEnglish,
  normalizeWord,
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
  const [entries, setEntries] = useState<DictionaryEntry[]>([]),
    [status, setStatus] = useState("Looking up…"),
    [adding, setAdding] = useState(false);
  useEffect(() => {
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
      {entries.map((entry, i) => (
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
          <ol>
            {entry.senses.map((sense, n) => (
              <li key={n}>
                <p>{sense.definitions.join("; ")}</p>
                {sense.examples.map((example, j) => (
                  <p className="dictionary-example" key={j}>
                    “{example}”
                  </p>
                ))}
                {!!sense.synonyms.length && (
                  <p className="muted">Synonyms: {sense.synonyms.join(", ")}</p>
                )}
                {onAdd && (
                  <button
                    className="text-button"
                    disabled={adding}
                    onClick={async () => {
                      setAdding(true);
                      try {
                        await onAdd(
                          `${entry.word} (${entry.partOfSpeech}): ${sense.definitions.join("; ")}\nSource: Open English Wordnet 2025 · CC BY 4.0 · https://en-word.net/`,
                        );
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
            ))}
          </ol>
        </div>
      ))}
      <p className="dictionary-credit">
        Definitions:{" "}
        <a href="https://en-word.net/" target="_blank" rel="noreferrer">
          Open English Wordnet 2025
        </a>
        , derived from Princeton WordNet.{" "}
        <a
          href="https://creativecommons.org/licenses/by/4.0/"
          target="_blank"
          rel="noreferrer"
        >
          CC BY 4.0
        </a>
        .{" "}
        <a
          href={`${import.meta.env.BASE_URL}dictionary/licenses.html`}
          target="_blank"
          rel="noreferrer"
        >
          Attribution and licenses
        </a>
        . Lookup stays on this device.
      </p>
    </section>
  );
}
