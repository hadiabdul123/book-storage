import "fake-indexeddb/auto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { db } from "../src/db";
import { lookupLocalMeaning, lookupReferences, referenceNote } from "../src/meaningLookup";

beforeEach(async () => {
  await db.meta.clear();
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const options = () => ({ signal: new AbortController().signal, allowNetwork: true });
const response = (data: unknown) => Response.json(data);
const page = (title = "Cognitive dissonance") => ({ query: { pages: [{ ns: 0, title, extract: "Discomfort when beliefs and actions conflict." }] } });

it("sends just the normalized term to the anonymous API and caches its attributed summary", async () => {
  const fetch = vi.fn(async (input: URL, init: RequestInit) => {
    expect(input.hostname).toBe("simple.wikipedia.org");
    expect(input.searchParams.get("titles")).toBe("cognitive dissonance");
    expect(input.searchParams.get("origin")).toBe("*");
    expect(init.credentials).toBe("omit");
    expect(init.referrerPolicy).toBe("no-referrer");
    return response(page());
  });
  vi.stubGlobal("fetch", fetch);
  const result = await lookupReferences("“Cognitive dissonance,”", options());
  expect(result.references[0]).toMatchObject({ kind: "summary", source: "Simple English Wikipedia", license: "CC BY-SA 4.0" });
  expect(referenceNote(result.references[0], result.fetchedAt)).toContain("Retrieved:");
  expect(referenceNote(result.references[0])).toContain("https://simple.wikipedia.org/wiki/Cognitive_dissonance");
  expect((await lookupReferences("cognitive dissonance", options())).cached).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.stubGlobal("navigator", { onLine: false });
  expect((await lookupReferences("cognitive dissonance", options())).references).toEqual(result.references);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("uses English Wikipedia after a miss and keeps disambiguation choices out of definitions", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(response({ query: { pages: [{ title: "Psychic energy", ns: 0, pageprops: { disambiguation: "" }, extract: "A disambiguation page", links: [{ ns: 0, title: "Energy (psychological)" }] }] } }))
    .mockResolvedValueOnce(response({ query: { pages: [{ title: "Psychic energy", ns: 0, missing: true }] } }));
  vi.stubGlobal("fetch", fetch);
  const result = await lookupReferences("psychic energy", options());
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(result.references).toHaveLength(1);
  expect(result.references[0]).toMatchObject({ title: "Energy (psychological)", kind: "choice" });
  expect(result.references[0].text).toBeUndefined();
  expect(result.message).toContain("not exact phrase definitions");
});

it("returns phrase search matches as related choices, never as fabricated phrase meanings", async () => {
  const fetch = vi.fn(async (url: URL) => response(url.searchParams.has("titles")
    ? { query: { pages: [{ ns: 0, missing: true }] } }
    : { query: { search: [{ ns: 0, title: "Flow (psychology)" }] } }));
  vi.stubGlobal("fetch", fetch);
  const result = await lookupReferences("psychic entropy", options());
  expect(result.references[0]).toMatchObject({ kind: "choice", title: "Flow (psychology)" });
  expect(result.references[0].text).toBeUndefined();
  const search = fetch.mock.calls[2][0];
  expect(search.searchParams.get("srsearch")).toBe('"psychic entropy"');
});

it("sends nothing for invalid selections, disabled lookup, or an offline cache miss", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect((await lookupReferences("one two three four five", options())).references).toEqual([]);
  expect((await lookupReferences("a".repeat(101), options())).references).toEqual([]);
  expect((await lookupReferences("a differ- ence in thinking", options())).references).toEqual([]);
  expect((await lookupReferences("word", { ...options(), allowNetwork: false })).message).toContain("turned off");
  vi.stubGlobal("navigator", { onLine: false });
  expect((await lookupReferences("word", options())).message).toContain("Connect");
  expect(fetch).not.toHaveBeenCalled();
});

it("still tries English Wikipedia when the Simple English service fails", async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(response(page()));
  vi.stubGlobal("fetch", fetch);
  const result = await lookupReferences("cognitive dissonance", options());
  expect(result.references[0].source).toBe("Wikipedia");
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("retains stale cached references when refresh fails or the service rate limits", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response(page())));
  const saved = await lookupReferences("cognitive dissonance", options());
  vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 429 })));
  const refreshed = await lookupReferences("cognitive dissonance", { ...options(), refresh: true });
  expect(refreshed.references).toEqual(saved.references);
  expect(refreshed.message).toContain("busy");
  vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);
  const expired = await lookupReferences("cognitive dissonance", options());
  expect(expired.cached).toBe(true);
  expect(expired.message).toContain("Showing the saved reference");
});

it("cancels outdated lookups and times out a stalled service without throwing away local results", async () => {
  const fetch = vi.fn((_url: URL, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }));
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  const cancelled = lookupReferences("cognitive dissonance", { signal: controller.signal, allowNetwork: true });
  const rejection = expect(cancelled).rejects.toThrow();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  controller.abort();
  await rejection;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const timed = lookupReferences("another phrase", options());
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await vi.advanceTimersByTimeAsync(8000);
  expect((await timed).message).toContain("timed out");
});

it("keeps only 100 successful cached terms and survives unavailable local dictionary chunks", async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ term: `term ${i}`, references: [], fetchedAt: Date.now() }));
  await db.meta.put({ key: "dictionary-reference-cache-v1", value: JSON.stringify(rows) });
  vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => typeof url === "string" ? new Response("missing", { status: 404 }) : response(page())));
  const local = await lookupLocalMeaning("psychic entropy");
  expect(local.entries[0].source).toBe("glossary");
  expect(local.needsOnline).toBe(false);
  const missing = await lookupLocalMeaning("unavailableword");
  expect(missing.needsOnline).toBe(true);
  expect(missing.error).toContain("not available yet");
  await lookupReferences("cognitive dissonance", options());
  const cache = JSON.parse((await db.meta.get("dictionary-reference-cache-v1"))!.value);
  expect(cache).toHaveLength(100);
  expect(cache[0].term).toBe("cognitive dissonance");
  expect(cache.some((row: { term: string }) => row.term === "term 99")).toBe(false);
});
