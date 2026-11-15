import { glossaryEntries } from "./glossary";

export type DictionaryEntry = {
  source?: "simple" | "wordnet" | "glossary";
  context?: string;
  attribution?: { name: string; license: string; url: string };
  word: string;
  partOfSpeech: string;
  senses: { definitions: string[]; examples: string[]; synonyms: string[] }[];
};
export function normalizeWord(word: string) {
  return word
    .normalize("NFKC")
    .replaceAll("\u00ad", "")
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .replaceAll("’", "'")
    .toLowerCase()
    .replace(/\s+/g, " ");
}
export function wordBucket(word: string) {
  let n = 0;
  for (const c of word) n = (n * 31 + c.codePointAt(0)!) >>> 0;
  return n % 256;
}
const chunks = new Map<number, Promise<Record<string, DictionaryEntry[]>>>();
async function exact(word: string) {
  const bucket = wordBucket(word);
  let pending = chunks.get(bucket);
  if (!pending) {
    pending = fetch(`${import.meta.env.BASE_URL}dictionary/${bucket}.json`)
      .then(async (r) => {
        if (!r.ok || !(r.headers.get("content-type") || "").includes("json"))
          throw new Error(
            "Dictionary is not available yet. Reopen the app online to finish offline preparation.",
          );
        return r.json();
      })
      .catch((error) => {
        chunks.delete(bucket);
        throw error;
      });
    chunks.set(bucket, pending);
    if (chunks.size > 12) chunks.delete(chunks.keys().next().value!);
  }
  return Object.hasOwn(await pending, word) ? (await pending)[word] : [];
}
// Only lookup text is repaired: annotations keep the document's original text.
export function lookupCandidates(term: string) {
  const original = normalizeWord(term);
  const joined = original.replace(/(?<=[\p{L}\p{M}])[-\u2010]\s+(?=[\p{L}\p{M}])/gu, "");
  // PDF text layers sometimes omit the line break entirely. These candidates
  // are accepted only if a dictionary knows them, after the original spelling.
  const unhyphenated = joined.replace(/(?<=[\p{L}\p{M}])[-\u2010](?=[\p{L}\p{M}])/gu, "");
  return [...new Set([original, joined, unhyphenated])];
}

export function dictionaryQueryError(term: string) {
  const candidates = lookupCandidates(term);
  if (!candidates[0]) return "Select or enter a word or short phrase.";
  if (candidates[0].length > 100 || candidates.every((word) => word.split(" ").length > 4))
    return "Select a shorter phrase (up to four words and 100 characters).";
  if (!/^[\p{L}\p{M}\p{N} .'\-\u2010\u2011]+$/u.test(candidates[0]))
    return "Select a word or short phrase without sentence punctuation.";
  return "";
}

async function entriesFor(word: string): Promise<DictionaryEntry[]> {
  const glossary = glossaryEntries(word);
  if (glossary.length) {
    // The glossary is bundled in the app and must work even if a dictionary
    // chunk is temporarily unavailable.
    return [...glossary, ...(await exact(word).catch(() => []))];
  }
  return exact(word);
}

async function inflected(word: string) {
  const direct = await entriesFor(word);
  if (direct.length) return direct;
  const candidates = new Set<string>();
  if (word.endsWith("ies")) candidates.add(word.slice(0, -3) + "y");
  if (word.endsWith("s")) candidates.add(word.slice(0, -1));
  if (word.endsWith("es")) candidates.add(word.slice(0, -2));
  for (const suffix of ["ing", "ed", "er", "est"])
    if (word.endsWith(suffix)) {
      const base = word.slice(0, -suffix.length);
      candidates.add(base);
      candidates.add(base + "e");
      if (/(.)\1$/.test(base)) candidates.add(base.slice(0, -1));
    }
  for (const base of candidates) {
    const found = await entriesFor(base);
    if (found.length) return found;
  }
  return [];
}

export async function resolveEnglish(term: string): Promise<{ term: string; entries: DictionaryEntry[] }> {
  const candidates = lookupCandidates(term);
  if (dictionaryQueryError(term)) return { term: candidates[0], entries: [] };
  // Preserve a recognized original spelling, including its inflected forms,
  // before trying a repaired spelling. Never split a phrase into separate words.
  for (const word of candidates) {
    if (word.split(" ").length > 4) continue;
    const entries = await inflected(word);
    if (entries.length) return { term: word, entries };
  }
  // Never send an unverified dehyphenation to an online source.
  return { term: candidates[0], entries: [] };
}

export async function lookupEnglish(term: string): Promise<DictionaryEntry[]> {
  return (await resolveEnglish(term)).entries;
}

export function dictionarySource(entry: DictionaryEntry) {
  if (entry.attribution) return entry.attribution;
  return entry.source === "simple"
    ? {
        name: "Simple English Wiktionary",
        license: "CC BY-SA 4.0",
        url: `https://simple.wiktionary.org/wiki/${encodeURIComponent(entry.word)}`,
      }
    : {
        name: "Open English Wordnet 2025",
        license: "CC BY 4.0",
        url: "https://en-word.net/",
      };
}
export function definitionNote(
  entry: DictionaryEntry,
  sense: DictionaryEntry["senses"][number],
) {
  const source = dictionarySource(entry);
  return `${entry.word} (${entry.partOfSpeech}${entry.context ? `; ${entry.context}` : ""}): ${sense.definitions.join("; ")}\nSource: ${source.name} \u00b7 ${source.license} \u00b7 ${source.url}`;
}
