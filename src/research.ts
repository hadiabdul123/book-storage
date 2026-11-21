import { readLines } from "../supabase/functions/research/lines";
import { db, get, save } from "./db";
import { cloud } from "./sync";
import { now, uid } from "./model";
import type { ResearchJob, ResearchRequest, ResearchResult } from "./researchTypes";
import { validSourceRef } from "./sourceReferences";
import { validBookComparison } from "../supabase/functions/research/comparison";

export class ResearchFailure extends Error {
  constructor(message: string, public code: string, public retryAfter = 0) { super(message); }
}
export function validResearchResult(value: unknown): value is ResearchResult {
  const r = value as ResearchResult;
  return !!r && typeof r.answer === "string" && r.answer.length <= 12000 && typeof r.model === "string" &&
    (r.visualQuery === undefined || (typeof r.visualQuery === "string" && r.visualQuery.length <= 80)) &&
    Array.isArray(r.sources) && r.sources.length <= 8 && r.sources.every(validSourceRef) &&
    [...r.answer.matchAll(/\[(S\d+)\]/g)].every(m => r.sources.some(s => s.id === m[1])) &&
    (r.comparison === undefined || validBookComparison(r.comparison, r.sources));
}
export async function researchCacheKey(request: Omit<ResearchRequest, "requestId">) {
  const bytes = new TextEncoder().encode(JSON.stringify(request));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
}
export async function enqueueResearch(threadId: string, request: Omit<ResearchRequest, "requestId">, refresh = false) {
  if (!request.question.trim() || request.question.length > 1500) throw new Error("Enter a question of up to 1,500 characters.");
  if (!(await get("research-thread", threadId))) throw new Error("Open a research conversation first.");
  const cacheKey = await researchCacheKey(request);
  const duplicate = (await db.researchJobs.where("threadId").equals(threadId).toArray())
    .find(j => j.cacheKey === cacheKey && (j.state === "queued" || j.state === "running"));
  if (duplicate) return duplicate.id;
  const job: ResearchJob = { id: uid(), threadId, request: { ...request, requestId: uid() }, cacheKey, state: "queued", createdAt: now() };
  if (!refresh) {
    try {
      const cached = JSON.parse((await db.meta.get(`research-cache:${cacheKey}`))?.value || "null");
      if (cached && validResearchResult(cached.result) && (Date.now() - cached.at < 86400000 || navigator.onLine === false)) {
        await save("research-message", { id: job.id, threadId, question: request.question, mode: request.mode, ...cached.result, createdAt: now() });
        return job.id;
      }
    } catch { /* A missing/malformed cache is a normal request. */ }
  }
  await db.researchJobs.put(job);
  window.dispatchEvent(new Event("leafmark-research"));
  return job.id;
}
export async function callResearch(request: ResearchRequest, signal: AbortSignal, onText?: (text:string)=>void): Promise<ResearchResult> {
  if (!cloud) throw new ResearchFailure("Connect your private Supabase backend to use AI research. Offline reading and notebooks still work.", "configuration");
  const { data: { session }, error } = await cloud.auth.getSession();
  if (error || !session) throw new ResearchFailure("Sign in to resume research. Your saved questions and writing are safe.", "auth");
  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/research`, {
    method: "POST", signal,
    headers: { ...(onText && request.meaning ? {Accept:"application/x-ndjson"} : {}), Authorization: `Bearer ${session.access_token}`, apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (response.ok && onText && response.headers.get("content-type")?.includes("application/x-ndjson") && response.body) {
    for await (const line of readLines(response.body)) {
      signal.throwIfAborted();
      if (!line) continue;
      const packet = JSON.parse(line);
      if (validResearchResult(packet.result)) return packet.result;
      if (typeof packet.text === "string" && packet.text.length <= 12000) onText(packet.text);
      if (packet.error) break;
    }
    throw new ResearchFailure("Incomplete explanation. Try again.", "provider");
  }
  let body: any;
  try { body = await response.json(); } catch { throw new ResearchFailure("The research service did not return an answer. Retry your saved question.", "provider"); }
  if (!response.ok) throw new ResearchFailure(typeof body.error === "string" ? body.error : "Research could not finish. Retry your saved question.",
    body.code || (response.status === 401 ? "auth" : "provider"), Math.min(86400, Math.max(0, Number(response.headers.get("retry-after")) || 0)));
  if (!validResearchResult(body)) throw new ResearchFailure("The answer contained invalid source references. Retry your saved question.", "citations");
  return body;
}
let running: Promise<void> | undefined;
const controllers = new Map<string, AbortController>();
type Transport = (request: ResearchRequest, signal: AbortSignal) => Promise<ResearchResult>;
export function runResearchQueue(transport: Transport = callResearch): Promise<void> {
  if (running) return running;
  const drain = async () => {
    const connected = () => navigator.onLine !== false;
    if (!connected()) return;
    // This runs only under the cross-tab lock, so a remaining running job came
    // from a terminated tab. Its stable requestId allows server result replay.
    await db.researchJobs.where("state").equals("running").modify({ state: "queued" });
    while (connected()) {
      const throttle = Number((await db.meta.get("research-next-at"))?.value || 0);
      if (throttle > Date.now()) break;
      const job = (await db.researchJobs.orderBy("createdAt").toArray()).find(j => j.state === "queued" && (!j.retryAt || j.retryAt <= Date.now()));
      if (!job) break;
      if (!(await get("research-thread", job.threadId))) { await db.researchJobs.update(job.id, { state: "cancelled" }); continue; }
      if (await get("research-message", job.id)) { await db.researchJobs.update(job.id, { state: "done" }); continue; }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      controllers.set(job.id, controller);
      await db.researchJobs.update(job.id, { state: "running", message: "Researching your question…" });
      try {
        let request = job.request;
        if (request.comparison && !request.sources.length) {
          const { comparisonSources } = await import("./sourceIndex");
          const sources = await comparisonSources(request.question, request.comparison.books.map(book => book.bookId), controller.signal,
            message => { void db.researchJobs.update(job.id, { message }).catch(() => {}); });
          controller.signal.throwIfAborted();
          request = { ...request, sources };
          await db.researchJobs.update(job.id, { message: "Comparing your books…" });
        }
        timer = setTimeout(() => controller.abort(), 55000);
        const result = await transport(request, controller.signal);
        if (!validResearchResult(result)) throw new ResearchFailure("The answer contained invalid source references.", "citations");
        if (request.comparison && !validBookComparison(result.comparison, result.sources, request.comparison))
          throw new ResearchFailure("The comparison was incomplete. Retry your saved question.", "format");
        await db.transaction("rw", db.rows, db.outbox, db.conflicts, db.meta, db.researchJobs, async () => {
          const currentJob = await db.researchJobs.get(job.id);
          if (!currentJob || currentJob.state === "cancelled" || !(await get("research-thread", job.threadId))) return;
          await save("research-message", { id: job.id, threadId: job.threadId, question: job.request.question, mode: job.request.mode, ...result, createdAt: now() });
          await db.meta.put({ key: `research-cache:${job.cacheKey}`, value: JSON.stringify({ at: Date.now(), result }) });
          await db.researchJobs.update(job.id, { state: "done", message: "Saved on this device" });
        });
        // Bound disposable answer-cache storage. Saved conversations are kept.
        const caches = await db.meta.where("key").startsWith("research-cache:").toArray();
        if (caches.length > 100) {
          caches.sort((a, b) => JSON.parse(a.value).at - JSON.parse(b.value).at);
          await db.meta.bulkDelete(caches.slice(0, caches.length - 100).map(c => c.key));
        }
      } catch (error) {
        if ((await db.researchJobs.get(job.id))?.state === "cancelled") continue;
        const failure = error instanceof ResearchFailure ? error : new ResearchFailure("Connection interrupted. Your question will resume while Leafmark is open and connected.", "connection", 30);
        const delay = failure.retryAfter;
        const paused = ["auth", "configuration", "quota"].includes(failure.code);
        await db.researchJobs.update(job.id, { state: paused ? "paused" : failure.code === "connection" || failure.code === "busy" ? "queued" : "error",
          message: failure.message, retryAt: delay ? Date.now() + delay * 1000 : undefined });
        if (failure.code === "quota" || failure.code === "connection" || failure.code === "busy") {
          await db.meta.put({ key: "research-next-at", value: String(Date.now() + Math.max(delay, 30) * 1000) });
          break;
        }
      } finally { clearTimeout(timer); controllers.delete(job.id); }
    }
  };
  const task: Promise<void> = (navigator.locks ? navigator.locks.request<void>("leafmark-research", { ifAvailable: true }, async lock => { if (lock) await drain(); }).then(() => undefined) : drain())
    .finally(() => { running = undefined; });
  running = task;
  return task;
}
export async function cancelResearch(id: string) {
  await db.researchJobs.update(id, { state: "cancelled", message: "Cancelled" });
  controllers.get(id)?.abort();
}
export async function retryResearch(id: string) {
  const job = await db.researchJobs.get(id);
  if (!job || job.state === "running" || job.state === "done") return;
  if (job.retryAt && job.retryAt > Date.now()) throw new Error(`Try again after ${new Date(job.retryAt).toLocaleTimeString()}.`);
  await db.researchJobs.update(id, { state: "queued", message: "Waiting for a connection", retryAt: undefined });
  window.dispatchEvent(new Event("leafmark-research"));
}
export function startResearchQueue() {
  let active = true;
  const run = () => { if (active) void runResearchQueue().catch(() => {}); };
  run();
  window.addEventListener("online", run);
  window.addEventListener("leafmark-research", run);
  window.addEventListener("focus", run);
  const timer = setInterval(run, 15000);
  return () => { active = false; for (const controller of controllers.values()) controller.abort(); clearInterval(timer); window.removeEventListener("online", run); window.removeEventListener("leafmark-research", run); window.removeEventListener("focus", run); };
}
