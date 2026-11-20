import { db } from "./db";
import { defaultPdfLayout, type PdfLayout, type Preferences } from "./model";

export type DeviceReading = Partial<Pick<Preferences, "theme" | "font" | "fontSize" | "lineHeight">> & {
  pageTurnEffect?: "curl" | "none";
  pdfOriginalColors?: boolean;
  swipeToTurn?: boolean;
  hidePageControls?: boolean;
  pdfLayout?: PdfLayout;
  zoom?: number;
  rotation?: number;
  width?: number;
  flow?: Preferences["flow"];
  spread?: boolean;
};
const defaultsKey = "device-reading:defaults:v1";
const documentKeys = ["rotation", "pdfOriginalColors"] as const;
async function storedReading(key: string): Promise<DeviceReading> {
  try { return JSON.parse((await db.meta.get(key))?.value || "{}"); } catch { return {}; }
}
async function readStoredDeviceReading(id: string): Promise<DeviceReading> {
  const [legacy, global] = await Promise.all([storedReading(`device-reading:${id}`), db.meta.get(defaultsKey)]);
  if (!global) return legacy;
  const appearance = await storedReading(defaultsKey);
  return { ...appearance, rotation: legacy.rotation, pdfOriginalColors: legacy.pdfOriginalColors };
}
const journalKey = "device-reading:pending:v1";
type ReadingChange = Omit<DeviceReading,"pdfLayout"> & { pdfLayout?: Partial<PdfLayout> };
type JournalEntry = { id: string; token: string; value: ReadingChange };
function readJournal(): JournalEntry[] {
  try { const value = JSON.parse(localStorage.getItem(journalKey) || "[]"); return Array.isArray(value) ? value.filter(v => typeof v?.id === "string" && typeof v?.token === "string" && v.value && typeof v.value === "object") : []; } catch { return []; }
}
function saveJournal(entries: JournalEntry[]) {
  try { entries.length ? localStorage.setItem(journalKey, JSON.stringify(entries)) : localStorage.removeItem(journalKey); } catch { /* IndexedDB remains the primary store when localStorage is unavailable. */ }
}
function acknowledge(tokens: string[]) { saveJournal(readJournal().filter(e => !tokens.includes(e.token))); }
const snapshots = new Map<string, DeviceReading>();
let recovery: Promise<void> | undefined;
function recoverReading() {
  // A live query can be the first reader. Replay in a separate task because
  // Dexie deliberately prohibits writes inside its read-only query context.
  return recovery ??= new Promise<void>(resolve => setTimeout(() => {
    void (async () => {
      for (const entry of readJournal()) {
        try { await writeDeviceReading(entry.id, entry.value); acknowledge([entry.token]); } catch { break; }
      }
    })().then(resolve);
  }, 0));
}
export async function readDeviceReading(id: string): Promise<DeviceReading> {
  await recoverReading();
  const value = await readStoredDeviceReading(id);
  snapshots.set(id, value);
  return value;
}
/** Seed once, atomically, before constructing the first reader on this device. */
export async function initializeDeviceReading(id: string, seed: DeviceReading): Promise<DeviceReading> {
  await recoverReading();
  await db.transaction("rw", db.meta, async () => {
    if (await db.meta.get(`${defaultsKey}:seeded`)) return;
    const next = { ...seed, ...await storedReading(`device-reading:${id}`), ...await storedReading(defaultsKey) };
    for (const key of documentKeys) delete next[key];
    await db.meta.put({ key: defaultsKey, value: JSON.stringify(next) });
    await db.meta.put({ key: `${defaultsKey}:seeded`, value: "1" });
  });
  return readDeviceReading(id);
}
export async function writeDeviceReading(id: string, patch: ReadingChange | ((prior: DeviceReading) => ReadingChange)) {
  await db.transaction("rw", db.meta, async () => {
    const prior = await readStoredDeviceReading(id);
    const update = typeof patch === "function" ? patch(prior) : patch;
    const global = mergeReading(prior, update);
    for (const key of documentKeys) delete global[key];
    await db.meta.put({ key: defaultsKey, value: JSON.stringify(global) });
    const document = await storedReading(`device-reading:${id}`);
    for (const key of documentKeys) if (update[key] !== undefined) Object.assign(document, { [key]: update[key] });
    await db.meta.put({ key: `device-reading:${id}`, value: JSON.stringify(document) });
  });
}
type ReadingPatch = Parameters<typeof writeDeviceReading>[1];
function mergeReading(prior: DeviceReading, change: ReadingChange): DeviceReading {
  const { pdfLayout, ...rest } = change;
  const next = { ...prior, ...rest };
  if (pdfLayout) next.pdfLayout = { ...defaultPdfLayout, ...prior.pdfLayout, ...pdfLayout };
  return next;
}
type QueuedReading = { entry: JournalEntry; resolve: () => void; reject: (e: unknown) => void };
let queued: QueuedReading[] = [];
let writeTimer: ReturnType<typeof setTimeout> | undefined;
const failed = new Map<string, JournalEntry>();
export async function flushDeviceReading(_id?: string) {
  clearTimeout(writeTimer);
  const batch = queued; queued = [];
  const records = [...new Map([...failed.values(), ...readJournal(), ...batch.map(item => item.entry)].map(entry => [entry.token, entry])).values()];
  if (!records.length) return;
  try {
    // Device defaults are shared across books. Commit the captured intents in
    // input order, atomically, so an older book's timer cannot overwrite a
    // newer choice and an interrupted batch cannot recover halfway through.
    await db.transaction("rw", db.meta, async () => {
      for (const entry of records) await writeDeviceReading(entry.id, entry.value);
    });
    acknowledge(records.map(entry => entry.token));
    records.forEach(entry => failed.delete(entry.token));
    batch.forEach(item => item.resolve());
  } catch (error) {
    records.forEach(entry => failed.set(entry.token, entry));
    batch.forEach(item => item.reject(error));
  }
}
export function queueDeviceReading(id: string, patch: ReadingPatch) {
  const journal = readJournal();
  const prior = journal.filter(e => e.id === id).reduce((value, entry) => mergeReading(value, entry.value), snapshots.get(id) || {});
  const change = typeof patch === "function" ? patch(prior) : patch;
  const next = mergeReading(prior, change);
  snapshots.set(id, next);
  const token = `${Date.now()}:${Math.random()}`;
  // Synchronous write-ahead recovery protects changes even if Android closes
  // the page before the coalesced IndexedDB transaction gets its turn.
  saveJournal([...journal, { id, token, value: change }]);
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => void flushDeviceReading(), 150);
  return new Promise<void>((resolve, reject) => queued.push({ entry: { id, token, value: change }, resolve, reject }));
}
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => void flushDeviceReading());
  document.addEventListener("visibilitychange", () => { if (document.hidden) void flushDeviceReading(); });
}
export function devicePdfLayout(
  local: DeviceReading | undefined,
  legacy: PdfLayout | undefined,
  phone: boolean,
) {
  return (
    local?.pdfLayout || (phone ? defaultPdfLayout : legacy) || defaultPdfLayout
  );
}
