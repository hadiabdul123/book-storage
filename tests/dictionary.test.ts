import { expect, it, afterEach, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  lookupEnglish,
  normalizeWord,
  wordBucket,
  definitionNote,
  resolveEnglish,
  dictionaryQueryError,
} from "../src/dictionary";
afterEach(() => vi.unstubAllGlobals());
it("normalizes selected punctuation while preserving meaningful word characters", () => {
  expect(normalizeWord("  “Running,” ")).toBe("running");
  expect(normalizeWord("reader’s")).toBe("reader's");
});

it("repairs line-end hyphenation only for lookup and preserves genuine compounds", async () => {
  vi.stubGlobal("fetch", async (url: string) => new Response(await readFile(`public${url}`, "utf8"), {
    headers: { "content-type": "application/json" },
  }));
  for (const term of ["differ-\nence", "differ- ence", "differ-ence", "dif\u00adference", "“differ-\r\nence,”"]) {
    const found = await resolveEnglish(term);
    expect(found.term).toBe("difference");
    expect(found.entries[0].word).toBe("difference");
  }
  expect((await resolveEnglish("well-being")).term).toBe("well-being");
  expect((await resolveEnglish("re-creates")).entries[0].word).toBe("re-create");
  expect((await resolveEnglish("zzun- knownzz")).term).toBe("zzun- knownzz");
});

it("looks up a complete phrase with context and original explanatory examples", async () => {
  vi.stubGlobal("fetch", async (url: string) => new Response(await readFile(`public${url}`, "utf8"), {
    headers: { "content-type": "application/json" },
  }));
  const energy = await lookupEnglish("psychic energy");
  expect(energy[0]).toMatchObject({ source: "glossary", word: "psychic energy", context: "Flow / attention" });
  expect(energy[1].context).toBe("Psychoanalytic theory");
  const entropy = await lookupEnglish("psychic entropy");
  expect(entropy[0].senses[0].definitions[0]).toContain("worries");
  expect(entropy[0].senses[0].examples[0]).toContain("unfinished task");
  expect(definitionNote(energy[1], energy[1].senses[0])).toContain("https://dictionary.apa.org/psychic-energy");
  expect(definitionNote(energy[0], energy[0].senses[0])).toContain("Flow / attention");
});

it("bounds the entire query before any request and accounts for split-word whitespace", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(dictionaryQueryError("one two three four five")).toContain("four words");
  expect(dictionaryQueryError("a".repeat(101))).toContain("100 characters");
  expect(dictionaryQueryError("difference|Earth")).toContain("punctuation");
  expect(dictionaryQueryError("a differ-\nence in thinking")).toBe("");
  expect(await lookupEnglish("one two three four five")).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});
it("looks up real bundled definitions and irregular forms using only local chunks", async () => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    requests.push(url);
    expect(url).toMatch(/^\/dictionary\/\d+\.json$/);
    return new Response(await readFile(`public${url}`, "utf8"), {
      headers: { "content-type": "application/json" },
    });
  });
  expect((await lookupEnglish("flow")).some((e) => e.senses.length)).toBe(true);
  expect((await lookupEnglish("went")).some((e) => e.word === "go")).toBe(true);
  expect(await lookupEnglish("zzxnonexistentwordzz")).toEqual([]);
  expect(requests.length).toBeGreaterThan(0);
  expect(wordBucket("flow")).toBeGreaterThanOrEqual(0);
});

it("prefers simple definitions, resolves inflections, and preserves source attribution", async () => {
  vi.stubGlobal(
    "fetch",
    async (url: string) =>
      new Response(await readFile(`public${url}`, "utf8"), {
        headers: { "content-type": "application/json" },
      }),
  );
  const comfort = await lookupEnglish("comfort");
  expect(comfort[0].source).toBe("simple");
  expect(comfort[0].senses[0].examples.length).toBeGreaterThan(0);
  expect(comfort.some((e) => e.source === "wordnet")).toBe(true);
  expect((await lookupEnglish("went"))[0].word).toBe("go");
  expect(definitionNote(comfort[0], comfort[0].senses[0])).toContain(
    "CC BY-SA 4.0",
  );
  const standard = comfort.find((e) => e.source === "wordnet")!;
  expect(definitionNote(standard, standard.senses[0])).toContain(
    "Open English Wordnet",
  );
});
