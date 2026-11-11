import { expect, it, afterEach, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { lookupEnglish, normalizeWord, wordBucket } from "../src/dictionary";
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
