import { useEffect, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import type { Book } from "./model";
import { preparationKey } from "./pdfText";
import type { PdfPreparationQueue, Preparation } from "./pdfPreparation";

export function useBookPreparation(books: Book[]) {
  const latest = useRef(books), queue = useRef<PdfPreparationQueue | undefined>(undefined);
  latest.current = books;
  const enabled = books.some(book => book.format === "pdf");
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const timer = setTimeout(() => {
      void import("./pdfPreparation").then(({ PdfPreparationQueue }) => {
        if (active) { queue.current = new PdfPreparationQueue(); queue.current.enqueue(latest.current); }
      });
    }, 600);
    return () => { active = false; clearTimeout(timer); queue.current?.destroy(); queue.current = undefined; };
  }, [enabled]);
  useEffect(() => queue.current?.enqueue(books), [books]);
}
export function BookPreparationStatus({ book }: { book: Book }) {
  const saved = useLiveQuery(() => db.meta.get(preparationKey(book)), [book.id, book.hash]);
  if (book.format !== "pdf" || !saved) return null;
  let state: Preparation;
  try { state = JSON.parse(saved.value); } catch { return null; }
  return <div className="book-preparation muted" aria-label={`Text preparation for ${book.title}`}>
    <span>{state.status === "ready" ? "Text ready · saved" : state.status === "error" ? "Text preparation paused" :
      state.status === "paused" ? `Text saved · ${state.done} of ${state.total} pages` :
      state.total ? `Preparing text · ${state.done} of ${state.total} pages` : "Preparing book text…"}</span>
    {state.status === "error" && <button className="text-button" title={state.error} onClick={() => window.dispatchEvent(new CustomEvent("leafmark-prepare-book", { detail: book.id }))}>Retry text preparation</button>}
  </div>;
}
