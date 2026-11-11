export type DictionaryEntry = {
  word: string;
  partOfSpeech: string;
  senses: { definitions: string[]; examples: string[]; synonyms: string[] }[];
};
export function normalizeWord(word: string) {
  return word
    .normalize("NFKC")
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
export async function lookupEnglish(term: string): Promise<DictionaryEntry[]> {
  const word = normalizeWord(term);
  if (!word || word.length > 100 || word.split(" ").length > 4) return [];
  const direct = await exact(word);
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
    const found = await exact(base);
    if (found.length) return found;
  }
  return [];
}
