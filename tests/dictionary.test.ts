import { expect, it, afterEach, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  lookupEnglish,
  normalizeWord,
  wordBucket,
  definitionNote,
} from "../src/dictionary";
afterEach(() => vi.unstubAllGlobals());
it("normalizes selected punctuation while preserving meaningful word characters", () => {
  expect(normalizeWord("  “Running,” ")).toBe("running");
  expect(normalizeWord("reader’s")).toBe("reader's");
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
