export type ComparisonBook = { bookId: string; title: string };
export type ComparisonRequest = { books: ComparisonBook[] };
export type ComparisonFinding = { text: string; sourceIds: string[] };
export type BookComparison = {
  columns: (ComparisonBook & { answer: string; gap: string; sourceIds: string[] })[];
  synthesis: ComparisonFinding;
};

type Evidence = { id: string; bookId?: string; kind?: string; noteId?: string; annotationId?: string };
export function comparisonSourceId(source: Evidence) {
  if (source.kind === "note") return "note:" + source.noteId;
  if (source.annotationId) return "highlight:" + source.annotationId;
  return source.bookId;
}

export function validComparisonRequest(value: unknown): value is ComparisonRequest {
  const request = value as ComparisonRequest;
  return Array.isArray(request?.books) && request.books.length >= 2 && request.books.length <= 4 &&
    request.books.every(book => typeof book?.bookId === "string" && /^[a-zA-Z0-9:-]{1,120}$/.test(book.bookId) &&
      typeof book.title === "string" && !!book.title.trim() && book.title.length <= 300) &&
    new Set(request.books.map(book => book.bookId)).size === request.books.length;
}

const validText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max && !/\[S\d+\]/.test(value);

export function validBookComparison(value: unknown, evidence: Evidence[], request?: ComparisonRequest): value is BookComparison {
  const result = value as BookComparison;
  if (!Array.isArray(result?.columns) || !result.synthesis) return false;
  const books = result.columns.map(column => ({ bookId: column?.bookId, title: column?.title }));
  if (!validComparisonRequest({ books }) || (request && JSON.stringify(request.books) !== JSON.stringify(books))) return false;
  const refs = (ids: unknown, bookId?: string): ids is string[] =>
    Array.isArray(ids) && ids.length <= 7 && new Set(ids).size === ids.length && ids.every(id =>
      typeof id === "string" && evidence.some(source => source.id === id && (source.kind === "book" || source.kind === "note") &&
        (bookId ? comparisonSourceId(source) === bookId : books.some(book => book.bookId === comparisonSourceId(source)))));
  return result.columns.every(column => validText(column.answer, 1200) && validText(column.gap, 400) &&
    refs(column.sourceIds, column.bookId) && (column.answer.trim() ? column.sourceIds.length > 0 : !!column.gap.trim())) &&
    validText(result.synthesis.text, 1800) && !!result.synthesis.text.trim() && refs(result.synthesis.sourceIds) &&
    (!result.columns.some(column => column.answer.trim()) || result.synthesis.sourceIds.length > 0);
}

export function comparisonText(result: BookComparison) {
  const cite = (ids: string[]) => ids.map(id => `[${id}]`).join(" ");
  return [...result.columns.map(column => [column.title.replace(/\[(S\d+)\]/g, "($1)"), column.answer, cite(column.sourceIds), column.gap].filter(Boolean).join("\n")),
    `Agreement and differences\n${result.synthesis.text} ${cite(result.synthesis.sourceIds)}`.trim()].join("\n\n");
}

export const noBookEvidence = "No relevant text was available for this book. Try another question or prepare the book’s text.";
