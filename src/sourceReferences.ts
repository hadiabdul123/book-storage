import type { SourceRef } from "./researchTypes";
import type { Book, RichNode } from "./model";
import { validLocator } from "./validation";

export function validSourceRef(value: unknown): value is SourceRef {
  const s = value as SourceRef;
  return !!s && typeof s === "object" && typeof s.id === "string" && s.id.length <= 200 &&
    ["book", "note", "web"].includes(s.kind) && typeof s.title === "string" && s.title.length <= 1000 &&
    typeof s.excerpt === "string" && s.excerpt.length <= 20000 &&
    (s.bookId === undefined || typeof s.bookId === "string") &&
    (s.annotationId === undefined || (s.kind === "book" && typeof s.annotationId === "string" && s.annotationId.length <= 100)) &&
    (s.noteId === undefined || typeof s.noteId === "string") &&
    (s.locator === undefined || validLocator(s.locator)) &&
    (s.retrievedAt === undefined || (typeof s.retrievedAt === "string" && Number.isFinite(Date.parse(s.retrievedAt)))) &&
    (s.kind === "web" ? typeof s.url === "string" && /^https?:\/\//i.test(s.url) && s.url.length <= 4000
      : s.kind === "book" ? !!s.bookId && validLocator(s.locator) : !!s.noteId);
}
export function sourceHref(source: SourceRef): string {
  if (!validSourceRef(source)) return "#";
  if (source.kind === "web") return source.url!;
  if (source.kind === "note") return `#/notebooks?note=${encodeURIComponent(source.noteId!)}`;
  if (source.annotationId) return `#/notes?item=${encodeURIComponent(source.annotationId)}`;
  return `#/read/${encodeURIComponent(source.bookId!)}?source=${encodeURIComponent(JSON.stringify(source.locator))}`;
}
export function sourceLabel(source: SourceRef) {
  return `${source.title}${source.locator?.type === "pdf" ? ` · page ${source.locator.page}` : ""}`;
}
export function originalSource(source: SourceRef): SourceRef {
  if (!source.annotationId) return source;
  const { annotationId: _, ...original } = source;
  return original;
}
export const citationNode = (source: SourceRef): RichNode => ({ type: "citation", attrs: { source } });
export function documentSources(document: RichNode): SourceRef[] {
  const refs = new Map<string, SourceRef>();
  const walk = (n: RichNode) => {
    if (n.type === "citation" && validSourceRef(n.attrs?.source)) {
      const s = n.attrs!.source as SourceRef;
      refs.set(JSON.stringify(s), s);
    }
    n.content?.forEach(walk);
  };
  walk(document);
  return [...refs.values()];
}
export function citedSources(text: string, all: SourceRef[]) {
  const matches = new Set([...text.matchAll(/\[([\w:-]{1,200})\]/g)].map(m => m[1]));
  return all.filter(s => matches.has(s.id));
}
export function sourceMarkdown(source: SourceRef) {
  const title = sourceLabel(source).replace(/[\[\]<>\n]/g, "");
  const href = sourceHref(source).replace(/\)/g, "%29").replace(/\(/g, "%28");
  return `[${title}](${href})${source.retrievedAt ? ` (retrieved ${source.retrievedAt.slice(0, 10)})` : ""}`;
}
export function remapSourceBooks(source: SourceRef, books: Book[]): SourceRef {
  if (source.kind !== "book") return source;
  return { ...source, bookId: books.find(b => b.hash === source.locator?.hash)?.id || `missing:${source.locator?.hash}` };
}
export function remapDocumentBooks(node: RichNode, books: Book[]): RichNode {
  return { ...node, ...(node.type === "citation" && validSourceRef(node.attrs?.source) ? { attrs: { source: remapSourceBooks(node.attrs!.source, books) } } : {}),
    ...(node.content ? { content: node.content.map(n => remapDocumentBooks(n, books)) } : {}) };
}
