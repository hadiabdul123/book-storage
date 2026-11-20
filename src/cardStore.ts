import { db, get, list, save } from "./db";
import { uid, type ResearchCard, type CardFiling, type HighlightView, type QuoteCategory } from "./model";
import { validSourceRef } from "./sourceReferences";

export const viewKeys = ["q","book","category","tag","notebook","color","type","priority","sort","groupSort"];
export function unpackFacet(raw:string):string[] {
  if (!raw) return [];
  if (!raw.startsWith("[")) return [raw];
  try { const items:unknown = JSON.parse(raw); if (Array.isArray(items) && items.every(s => typeof s === "string")) return items; } catch { /* A plain tag may start with a bracket. */ }
  return [raw];
}
export function packFacet(values:string[]) {
  return values.length === 1 && !values[0].startsWith("[") ? values[0] : values.length ? JSON.stringify(values) : "";
}
export async function cardLibrary() {
  const [categories, filings, cards, views] = await Promise.all([list("quote-category"), list("card-filing"), list("research-card"), list("highlight-view")]);
  const active = new Set(categories.map(c => c.id));
  return { categories: categories.sort((a,b) => a.name.localeCompare(b.name)), filings:filings.filter(f => active.has(f.categoryId)), cards, views };
}
export type CardLibrary = Awaited<ReturnType<typeof cardLibrary>>;
export const emptyCards: CardLibrary = { categories: [], filings: [], cards: [], views: [] };

export function validCardLibrary(value: any): value is CardLibrary {
  const views = value?.views;
  return value && (views === undefined || (Array.isArray(views) && views.every((v:HighlightView) => v && typeof v.id === "string" && typeof v.name === "string" && v.name.trim() && v.name.length <= 80 && v.filters && typeof v.filters === "object" && !Array.isArray(v.filters) && Object.entries(v.filters).every(([k,s]) => viewKeys.includes(k) && typeof s === "string" && s.length <= 12000))))
    && Array.isArray(value.categories) && value.categories.every((c: QuoteCategory) => c && typeof c.id === "string" && typeof c.name === "string" && c.name.trim() && c.name.length <= 80)
    && Array.isArray(value.filings) && value.filings.every((f: CardFiling) => f && typeof f.categoryId === "string" && typeof f.cardId === "string" && f.id === f.categoryId + ":" + f.cardId && ((f.x === undefined && f.y === undefined) || [f.x,f.y].every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e6)))
    && Array.isArray(value.cards) && value.cards.every((c: ResearchCard) => c && typeof c.id === "string" && typeof c.text === "string" && c.text.trim() && c.text.length <= 20000
      && ["quote","finding"].includes(c.kind) && Number.isFinite(Date.parse(c.createdAt)) && Array.isArray(c.sources) && c.sources.every(validSourceRef));
}

export async function editCategory(name: string, id: string = uid()) {
  const title = name.trim();
  if (!title || title.length > 80) throw new Error("Use a category name between 1 and 80 characters.");
  await db.transaction("rw", db.rows, db.outbox, db.meta, db.conflicts, async () => {
    if ((await list("quote-category")).some(c => c.id !== id && c.name.toLowerCase() === title.toLowerCase())) throw new Error("That category already exists.");
    await save("quote-category", { id, name: title });
  });
  return id;
}

export async function fileCards(cardIds: string[], changes: Record<string, boolean>) {
  await db.transaction("rw", db.rows, db.outbox, db.meta, db.conflicts, async () => {
    for (const [categoryId, checked] of Object.entries(changes)) {
      if (!(await get("quote-category", categoryId))) continue;
      for (const cardId of cardIds) {
        const id = categoryId + ":" + cardId;
        if (!!(await get("card-filing", id)) !== checked) await save("card-filing", { id, categoryId, cardId }, !checked);
      }
    }
  });
}
