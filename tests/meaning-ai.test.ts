import "fake-indexeddb/auto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { db } from "../src/db";
import { lookupAiMeaning } from "../src/meaningAi";
import type { SourceRef } from "../src/researchTypes";
const result = { answer: "Definition\nA pleasant feeling.\n\nExamples\n1. A\n2. B\n3. C", model: "test", sources: [] };
const source: SourceRef = { id: "selection", kind: "book", bookId: "book", title: "Reading", locator: { v: 1, type: "pdf", hash: "a".repeat(64), page: 1, y: 0 }, excerpt: "A calm, comfortable room." };
const options = () => ({ signal: new AbortController().signal });
beforeEach(async () => { await db.meta.clear(); vi.stubGlobal("navigator", { onLine: true }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("bounds context, caches by term and passage, and reuses saved AI offline", async () => {
  const transport = vi.fn(async () => result);
  const context = async () => ({ ...source, excerpt: "x".repeat(2500) });
  expect((await lookupAiMeaning("comfort", { ...options(), context }, transport)).cached).toBe(false);
  expect(transport.mock.calls[0][0]).toMatchObject({ meaning: { term: "comfort" }, mode: "explain", history: [] });
  expect(transport.mock.calls[0][0].sources[0].excerpt.length).toBe(1800);
  vi.stubGlobal("navigator", { onLine: false });
  expect((await lookupAiMeaning("comfort", { ...options(), context }, transport)).cached).toBe(true);
  expect(transport).toHaveBeenCalledTimes(1);
  await expect(lookupAiMeaning("comfort", options(), transport)).rejects.toThrow("Offline");
  vi.stubGlobal("navigator", { onLine: true });
  await lookupAiMeaning("comfort", { ...options(), context: async () => source }, transport);
  expect(transport).toHaveBeenCalledTimes(2);
});
it("times out even while context is stalled and never calls the provider afterward", async () => {
  vi.useFakeTimers(); const transport = vi.fn(async () => result);
  const pending = lookupAiMeaning("comfort", { ...options(), context: () => new Promise(() => {}) }, transport);
  const assertion = expect(pending).rejects.toThrow("AI timed out");
  await vi.advanceTimersByTimeAsync(8001); await assertion;
  expect(transport).not.toHaveBeenCalled();
});
it("cancels on close and prevents a late provider answer from entering the cache", async () => {
  const controller = new AbortController(); let finish!: (v: typeof result) => void;
  const transport = vi.fn(() => new Promise<typeof result>(resolve => { finish = resolve; }));
  const pending = lookupAiMeaning("comfort", { signal: controller.signal }, transport);
  const assertion = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce()); controller.abort(); await assertion;
  finish(result); await new Promise(resolve => setTimeout(resolve, 0));
  expect(await db.meta.where("key").startsWith("meaning-ai:").count()).toBe(0);
});
it("rejects malformed answers, preserves provider failures, and does not retry", async () => {
  const malformed = vi.fn(async () => ({ ...result, answer: "" }));
  await expect(lookupAiMeaning("word", options(), malformed)).rejects.toThrow("incomplete");
  const quota = vi.fn(async () => { throw Object.assign(new Error("quota"), { code: "quota" }); });
  await expect(lookupAiMeaning("word", options(), quota)).rejects.toMatchObject({ code: "quota" });
  expect(quota).toHaveBeenCalledOnce();
  await expect(lookupAiMeaning("x".repeat(101), options(), quota)).rejects.toThrow("100 characters");
});
