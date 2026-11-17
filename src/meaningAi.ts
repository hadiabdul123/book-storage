import { db } from "./db";
import { uid } from "./model";
import { callResearch, researchCacheKey, validResearchResult } from "./research";
import type { ResearchRequest, ResearchResult, SourceRef } from "./researchTypes";

const prefix = "meaning-ai:v1:";
const maxAge = 30 * 86400000;
type Options = { signal: AbortSignal; context?: () => Promise<SourceRef | undefined>; refresh?: boolean };
type Transport = (request: ResearchRequest, signal: AbortSignal) => Promise<ResearchResult>;
export async function lookupAiMeaning(term: string, options: Options, transport: Transport = callResearch) {
  const word = term.normalize("NFKC").replaceAll("\u00ad", "").trim().replace(/\s+/g, " ");
  if (!word || word.length > 100) throw new Error("Select a word or short phrase up to 100 characters.");
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", cancel, { once: true });
  if (options.signal.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new Error("AI timed out. Showing the dictionary.")), 8000);
  let aborted!: () => void;
  const abort = new Promise<never>((_, reject) => {
    aborted = () => reject(controller.signal.reason || new DOMException("Cancelled", "AbortError"));
    controller.signal.addEventListener("abort", aborted, { once: true });
    if (controller.signal.aborted) aborted();
  });
  const lookup = async () => {
    const context = await options.context?.().catch(() => undefined);
    controller.signal.throwIfAborted();
    const request: Omit<ResearchRequest, "requestId"> = {
      mode: "explain", meaning: { term: word }, question: `Explain the meaning and usage of: ${word}`,
      sources: context ? [{ ...context, excerpt: context.excerpt.slice(0, 1800) }] : [], history: [],
    };
    const key = prefix + await researchCacheKey(request);
    if (!options.refresh) {
      try {
        const cached = JSON.parse((await db.meta.get(key))?.value || "null");
        controller.signal.throwIfAborted();
        if (cached && Date.now() - cached.at < maxAge && validResearchResult(cached.result) && cached.result.answer.trim() && cached.result.sources.length === 0)
          return { ...cached.result as ResearchResult, cached: true };
      } catch { controller.signal.throwIfAborted(); }
    }
    if (globalThis.navigator?.onLine === false) throw new Error("Offline. Showing the dictionary.");
    const result = await transport({ ...request, requestId: uid() }, controller.signal);
    controller.signal.throwIfAborted();
    if (!validResearchResult(result) || !result.answer.trim() || result.sources.length) throw new Error("The AI explanation was incomplete. Showing the dictionary.");
    try {
      await db.transaction("rw", db.meta, async () => {
        controller.signal.throwIfAborted();
        await db.meta.put({ key, value: JSON.stringify({ at: Date.now(), result }) });
        const rows = await db.meta.where("key").startsWith(prefix).toArray();
        if (rows.length > 100) {
          const at = (s: string) => { try { return Number(JSON.parse(s).at) || 0; } catch { return 0; } };
          rows.sort((a, b) => at(a.value) - at(b.value));
          await db.meta.bulkDelete(rows.slice(0, rows.length - 100).map(r => r.key));
        }
      });
    } catch { controller.signal.throwIfAborted(); /* The answer remains usable if local caching fails. */ }
    return { ...result, cached: false };
  };
  try { return await Promise.race([lookup(), abort]); }
  finally { clearTimeout(timer); controller.signal.removeEventListener("abort", aborted); options.signal.removeEventListener("abort", cancel); }
}
