import { gunzipSync } from "node:zlib";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import JSZip from "jszip";
const checksum =
  "7d749f6e2c39e6970e4997839dcf6e42fd281f3c2fae0171d2192bae8cfa4b51";
const simpleChecksum =
  "ddcd73f43d23daff9c38510e8f7a63c5a7262dc962f7cce85f105da4c418e79f";
const simpleArchive = readFileSync(
  "vendor/simple-wiktionary/simple-2026-10-02.jsonl.gz",
);
if (createHash("sha256").update(simpleArchive).digest("hex") !== simpleChecksum)
  throw new Error("Simple dictionary checksum mismatch");
const version = `simple-2026-10-02-${simpleChecksum.slice(0, 12)}-oewn-2025-v2`;
const directory = "public/dictionary";
const archive = readFileSync("vendor/wordnet/english-wordnet-2025-json.zip");
if (createHash("sha256").update(archive).digest("hex") !== checksum)
  throw new Error("Dictionary source checksum mismatch");
mkdirSync(directory, { recursive: true });
const notices = ["README.md", "LICENSE.md", "CC-BY-4.0.txt"]
  .map((name) => readFileSync(`vendor/wordnet/${name}`, "utf8"))
  .concat(
    readFileSync("vendor/simple-wiktionary/README.md", "utf8"),
    readFileSync("vendor/simple-wiktionary/CC-BY-SA-4.0.txt", "utf8"),
  )
  .join("\n\n");
writeFileSync(
  `${directory}/licenses.html`,
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Dictionary attribution and licenses</title><main><h1>Dictionary attribution and licenses</h1><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${notices.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</pre></main></html>`,
);
if (
  !existsSync(`${directory}/manifest.json`) ||
  JSON.parse(readFileSync(`${directory}/manifest.json`, "utf8")).version !==
    version
) {
  const zip = await JSZip.loadAsync(archive);
  const synsets = {},
    entries = {};
  for (const file of Object.values(zip.files).filter((f) =>
    f.name.endsWith(".json"),
  )) {
    Object.assign(
      file.name.startsWith("entries-") ? entries : synsets,
      JSON.parse(await file.async("string")),
    );
  }
  const buckets = Array.from({ length: 256 }, () => Object.create(null));
  const normalize = (s) =>
    s.normalize("NFKC").toLowerCase().replaceAll("_", " ");
  const bucket = (s) => {
    let n = 0;
    for (const c of s) n = (n * 31 + c.codePointAt(0)) >>> 0;
    return n % 256;
  };
  const add = (term, record) => {
    const key = normalize(term);
    (buckets[bucket(key)][key] ||= []).push(record);
  };
  for (const [word, parts] of Object.entries(entries)) {
    for (const [pos, entry] of Object.entries(parts)) {
      const senses = (entry.sense || [])
        .map((s) => synsets[s.synset])
        .filter(Boolean)
        .map((s) => ({
          definitions: s.definition || [],
          examples: (s.example || [])
            .map((e) => (typeof e === "string" ? e : e.text))
            .filter(Boolean),
          synonyms: (s.members || [])
            .map((m) => (typeof m === "string" ? m : m[0]))
            .filter((m) => m !== word),
        }));
      if (!senses.length) continue;
      const record = {
        word,
        source: "wordnet",
        partOfSpeech:
          { n: "noun", v: "verb", a: "adjective", s: "adjective", r: "adverb" }[
            pos
          ] || pos,
        senses,
      };
      add(word, record);
      for (const form of entry.form || [])
        if (typeof form === "string" && normalize(form) !== normalize(word))
          add(form, record);
    }
  }
  // Keep source order within Simple Wiktionary, but put it before WordNet.
  const simpleRecords = gunzipSync(simpleArchive)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((r) => r.lang_code === "en");
  const byWord = new Map();
  for (const item of simpleRecords) {
    const canonical = item.forms?.find((f) =>
      f.tags?.includes("canonical"),
    )?.form;
    if (canonical && normalize(canonical) !== normalize(item.word)) continue;
    const senses = (item.senses || [])
      .filter((s) => !s.form_of && s.glosses?.length)
      .map((s) => ({
        definitions: s.glosses,
        examples: (s.examples || []).map((e) => e.text).filter(Boolean),
        synonyms: (s.synonyms || []).map((e) => e.word).filter(Boolean),
      }));
    if (!senses.length) continue;
    const record = {
      word: item.word,
      partOfSpeech:
        {
          adj: "adjective",
          adv: "adverb",
          prep: "preposition",
          pron: "pronoun",
          conj: "conjunction",
          det: "determiner",
          intj: "interjection",
        }[item.pos] || item.pos,
      source: "simple",
      senses,
    };
    const terms = new Set([
      item.word,
      ...(item.forms || [])
        .map((f) => f.form)
        .filter((f) => f && !/\?/.test(f)),
    ]);
    for (const term of terms) {
      const key = normalize(term);
      const list = byWord.get(key) || [];
      if (
        !list.some(
          (r) =>
            r.word === record.word && r.partOfSpeech === record.partOfSpeech,
        )
      )
        list.push(record);
      byWord.set(key, list);
    }
  }
  for (const [term, records] of byWord) {
    const chunk = buckets[bucket(term)];
    chunk[term] = [...records, ...(chunk[term] || [])];
  }
  mkdirSync(directory, { recursive: true });
  let bytes = 0,
    terms = 0;
  for (let i = 0; i < buckets.length; i++) {
    const data = JSON.stringify(buckets[i]);
    if (Buffer.byteLength(data) > 1024 * 1024)
      throw new Error("Dictionary chunk exceeded 1 MB");
    writeFileSync(`${directory}/${i}.json`, data);
    bytes += Buffer.byteLength(data);
    terms += Object.keys(buckets[i]).length;
  }
  writeFileSync(
    `${directory}/manifest.json`,
    JSON.stringify({
      version,
      source:
        "Simple English Wiktionary 2026-10-02 + Open English Wordnet 2025",
      license: "Simple Wiktionary: CC BY-SA 4.0; WordNet: CC BY 4.0",
      url: "https://en-word.net/",
      chunks: buckets.length,
      terms,
      bytes,
    }),
  );
  console.log(
    `Prepared ${terms} dictionary terms in 256 chunks (${(bytes / 1024 / 1024).toFixed(1)} MiB).`,
  );
}
