import { db } from "./db";
import { dictionaryQueryError, normalizeWord, resolveEnglish } from "./dictionary";

export const onlinePreferenceKey = "leafmark-online-references";
const cacheKey = "dictionary-reference-cache-v1";
const cacheAge = 30 * 24 * 60 * 60 * 1000;
const license = "CC BY-SA 4.0";
const sources = [
  { host: "simple.wikipedia.org", name: "Simple English Wikipedia" },
  { host: "en.wikipedia.org", name: "Wikipedia" },
] as const;

export type Reference = {
  title: string;
  text?: string;
  url: string;
  source: string;
  license: string;
  kind: "summary" | "choice";
};
type CachedReferences = { term: string; references: Reference[]; fetchedAt: number };
export type ReferenceResult = {
  references: Reference[];
  cached: boolean;
  fetchedAt?: number;
  message: string;
};

export async function lookupLocalMeaning(term: string) {
  const error = dictionaryQueryError(term);
  if (error) return { term: normalizeWord(term), entries: [], error, valid: false, needsOnline: false };
  try {
    const result = await resolveEnglish(term);
    return {
      ...result,
      error: "",
      valid: true,
      needsOnline: !result.entries.some((entry) => entry.source === "glossary" || entry.source === "simple"),
    };
  } catch (error) {
    // Online references can still help if the local dictionary is unavailable.
    return { term: normalizeWord(term), entries: [], error: String(error instanceof Error ? error.message : error), valid: true, needsOnline: true };
  }
}

async function readCache(): Promise<CachedReferences[]> {
  try {
    const value: unknown = JSON.parse((await db.meta.get(cacheKey))?.value || "[]");
    return Array.isArray(value) ? value.filter((row) =>
      typeof row?.term === "string" && Number.isFinite(row.fetchedAt) &&
      Array.isArray(row.references) && row.references.every((ref: Reference) =>
        typeof ref.title === "string" && typeof ref.url === "string" &&
        /^https:\/\/(simple|en)\.wikipedia\.org\/wiki\//.test(ref.url) &&
        typeof ref.source === "string" && typeof ref.license === "string" &&
        (ref.kind === "choice" || ref.kind === "summary") &&
        (ref.text === undefined || typeof ref.text === "string"))) : [];
  } catch {
    return [];
  }
}

async function saveCache(row: CachedReferences, signal: AbortSignal) {
  try {
    await db.transaction("rw", db.meta, async () => {
      const rows = await readCache();
      signal.throwIfAborted();
      await db.meta.put({ key: cacheKey, value: JSON.stringify(
        [row, ...rows.filter((item) => item.term !== row.term)].slice(0, 100),
      ) });
    });
  } catch {
    // Reference lookup remains usable when browser storage is full/unavailable.
  }
}

type WikiPage = {
  title?: string;
  ns?: number;
  missing?: boolean;
  extract?: string;
  pageprops?: { disambiguation?: string };
  links?: { ns: number; title: string }[];
};

function reference(source: typeof sources[number], title: string, text?: string): Reference {
  return {
    title, text,
    url: `https://${source.host}/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`,
    source: source.name,
    license,
    kind: text ? "summary" : "choice",
  };
}

async function wikiRequest(source: typeof sources[number], params: Record<string, string>, signal: AbortSignal) {
  const url = new URL(`https://${source.host}/w/api.php`);
  url.search = new URLSearchParams({ action: "query", format: "json", formatversion: "2", origin: "*", ...params }).toString();
  const response = await fetch(url, {
    signal,
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { "Api-User-Agent": "Leafmark/0.1 (https://hadiabdul123.github.io/book-storage/)" },
  });
  if (response.status === 429) {
    const error = new Error("Online references are busy. Try again later.");
    error.name = "RateLimitError";
    throw error;
  }
  if (!response.ok) throw new Error("Online references are unavailable. Try again.");
  const data = await response.json();
  if (data.error) throw new Error("Online references are unavailable. Try again.");
  return data;
}

export async function lookupReferences(term: string, options: {
  signal: AbortSignal;
  allowNetwork: boolean;
  refresh?: boolean;
}): Promise<ReferenceResult> {
  const word = normalizeWord(term);
  if (dictionaryQueryError(term)) return { references: [], cached: false, message: dictionaryQueryError(term) };
  // A split word may add whitespace to a valid local query. It must have been
  // resolved locally before the resulting short phrase can be sent online.
  if (word.split(" ").length > 4) return { references: [], cached: false, message: "Select a shorter phrase (up to four words and 100 characters)." };
  const cached = (await readCache()).find((row) => row.term === word);
  options.signal.throwIfAborted();
  const canConnect = options.allowNetwork && globalThis.navigator?.onLine !== false;
  const cachedResult = (message: string): ReferenceResult => ({ references: cached?.references || [], cached: !!cached, fetchedAt: cached?.fetchedAt, message });
  if (!canConnect) return cachedResult(cached ? "Saved online reference · available offline." : options.allowNetwork ? "No saved online reference. Connect to look this up online." : "Online references are turned off.");
  if (cached && !options.refresh && Date.now() - cached.fetchedAt < cacheAge)
    return cachedResult("Saved online reference.");

  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Online lookup timed out. Try again.")), 8000);
  try {
    const unavailable = new Set<string>();
    let serviceError: unknown;
    const request = async (source: typeof sources[number], params: Record<string, string>) => {
      if (unavailable.has(source.host)) return null;
      try {
        return await wikiRequest(source, params, controller.signal);
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === "RateLimitError")) throw error;
        unavailable.add(source.host);
        serviceError = error;
        return null;
      }
    };
    const choices: Reference[] = [];
    for (const source of sources) {
      const data = await request(source, {
        titles: word, redirects: "1", prop: "extracts|pageprops|links",
        exintro: "1", explaintext: "1", exchars: "650",
        plnamespace: "0", pllimit: "5",
      });
      if (!data) continue;
      for (const page of (data.query?.pages || []) as WikiPage[]) {
        if (page.missing || page.ns !== 0 || !page.title) continue;
        if (page.pageprops && Object.hasOwn(page.pageprops, "disambiguation")) {
          choices.push(...(page.links || []).filter((link) => link.ns === 0).map((link) => reference(source, link.title)));
        } else if (typeof page.extract === "string" && page.extract.trim()) {
          const row = { term: word, references: [reference(source, page.title, page.extract.trim())], fetchedAt: Date.now() };
          await saveCache(row, controller.signal);
          options.signal.throwIfAborted();
          return { references: row.references, cached: false, fetchedAt: row.fetchedAt, message: "" };
        }
      }
    }
    if (!choices.length) {
      // A full-text match is a related article, not a definition of the phrase.
      for (const source of sources) {
        const data = await request(source, { list: "search", srsearch: `"${word}"`, srnamespace: "0", srlimit: "3", srprop: "" });
        if (!data) continue;
        const hits = data.query?.search;
        if (Array.isArray(hits)) choices.push(...hits.filter((hit) => hit.ns === 0 && typeof hit.title === "string").map((hit) => reference(source, hit.title)));
        if (choices.length) break;
      }
    }
    const references = choices.slice(0, 5);
    if (!references.length && serviceError) throw serviceError;
    if (references.length) await saveCache({ term: word, references, fetchedAt: Date.now() }, controller.signal);
    options.signal.throwIfAborted();
    return { references, cached: false, message: references.length ? "Choose a related reference; these are not exact phrase definitions." : "No matching online reference found. Try a different spelling or phrase." };
  } catch (error) {
    options.signal.throwIfAborted();
    const message = controller.signal.aborted ? "Online lookup timed out. Try again." : error instanceof Error ? error.message : "Online references are unavailable. Try again.";
    return cachedResult(`${message}${cached ? " Showing the saved reference." : ""}`);
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", cancel);
  }
}

export function referenceNote(ref: Reference, fetchedAt?: number) {
  return `${ref.title}: ${ref.text || "Related reference"}\nSource: ${ref.source} · ${ref.license} · ${ref.url}${fetchedAt ? `\nRetrieved: ${new Date(fetchedAt).toISOString().slice(0, 10)}` : ""}`;
}
