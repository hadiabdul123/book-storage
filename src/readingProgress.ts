import type { Book, Locator } from "./model";

export function knownAuthor(author: string) {
  const name = author.trim();
  return name.toLowerCase() === "unknown author" ? "" : name;
}

export function readingProgress(
  book: Pick<Book, "format" | "hash">,
  locator?: Locator,
  progress = 0,
  totalPages?: number,
  finished = false,
) {
  const position = locator?.type === book.format && locator.hash === book.hash ? locator : undefined;
  const page = position?.type === "pdf" && Number.isSafeInteger(position.page) && position.page > 0
    ? position.page : undefined;
  const total = book.format === "pdf" && totalPages && Number.isSafeInteger(totalPages) && totalPages >= (page ?? 1)
    ? totalPages : undefined;
  const fraction = finished ? 1 : page && total ? page / total
    : position && Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  const percent = fraction === 1 ? 100 : Math.min(99, Math.round(fraction * 100));
  const pageLabel = page ? (total ? `Page ${page} of ${total}` : `Page ${page}`)
    : total ? `${total} ${total === 1 ? "page" : "pages"}` : undefined;

  return { fraction, percent, pageLabel };
}

export type ReadingProgress = ReturnType<typeof readingProgress>;
