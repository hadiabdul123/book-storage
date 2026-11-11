import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import JSZip from "jszip";
const checksum =
  "7d749f6e2c39e6970e4997839dcf6e42fd281f3c2fae0171d2192bae8cfa4b51";
const version = `oewn-2025-${checksum.slice(0, 12)}-v1`;
const directory = "public/dictionary";
const archive = readFileSync("vendor/wordnet/english-wordnet-2025-json.zip");
if (createHash("sha256").update(archive).digest("hex") !== checksum)
  throw new Error("Dictionary source checksum mismatch");
mkdirSync(directory, { recursive: true });
const notices = ["README.md", "LICENSE.md", "CC-BY-4.0.txt"]
  .map((name) => readFileSync(`vendor/wordnet/${name}`, "utf8"))
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
      source: "Open English Wordnet 2025",
      license: "CC BY 4.0",
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
