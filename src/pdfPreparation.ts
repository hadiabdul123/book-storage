import { db } from "./db";
import { publishPreparedText } from "./preparedText";
import { downloadBook } from "./sync";
import type { Book } from "./model";
import { pdfLibrary, pdfOptions } from "./pdf";
import { preparationKey, preparePageText, savePageCache } from "./pdfText";
import { PageOcr } from "./reader/ocr";

export type Preparation = { status: "queued" | "working" | "paused" | "ready" | "error"; done: number; total: number; error?: string };
const pause = () => new DOMException("Preparation paused", "AbortError");

/** Only the library owns this queue. Leaving it saves the current page, then
 * releases its decoder/worker; opening a reader never waits for the whole book. */
export class PdfPreparationQueue {
  private books = new Map<string, Book>();
  private stopped = false;
  private busy = false;
  private timer?: ReturnType<typeof setTimeout>;
  private lastInput = Date.now();
  private ocr = new PageOcr();
  private activity = () => { this.lastInput = Date.now(); };
  private visibility = () => { if (!document.hidden) this.schedule(); };
  private retry = (event: Event) => {
    const book = this.books.get((event as CustomEvent<string>).detail);
    if (book) void db.meta.delete(preparationKey(book)).then(() => this.schedule());
  };
  constructor() {
    window.addEventListener("pointerdown", this.activity, { passive: true });
    window.addEventListener("keydown", this.activity);
    window.addEventListener("wheel", this.activity, { passive: true });
    window.addEventListener("leafmark-prepare-book", this.retry);
    document.addEventListener("visibilitychange", this.visibility);
  }
  enqueue(books: Book[]) {
    this.books = new Map(books.filter(book => book.format === "pdf").map(book => [book.id, book]));
    this.schedule();
  }
  private available() { return !this.stopped && !document.hidden; }
  private check() { if (!this.available()) throw pause(); }
  private schedule() {
    clearTimeout(this.timer);
    if (this.available() && !this.busy && this.books.size) this.timer = setTimeout(() => void this.run(), 800);
  }
  private async run() {
    if (!this.available() || Date.now() - this.lastInput < 700) { this.schedule(); return; }
    this.busy = true;
    let unfinished = false;
    try {
      for (const book of this.books.values()) {
        this.check();
        const row = await db.meta.get(preparationKey(book));
        let state: Preparation = { status: "queued", done: 0, total: 0 };
        try { if (row) state = JSON.parse(row.value); } catch { /* Resume with page one. */ }
        if (state.status === "ready" || state.status === "error") continue;
        let file = await db.files.get(book.id);
        if (file && book.preparedTextPath) {
          file = await downloadBook(book);
          const restored = await db.meta.get(preparationKey(book));
          if (restored && JSON.parse(restored.value).status === "ready") continue;
        }
        if (!file) continue;
        const save = () => savePageCache(book, [{ key: preparationKey(book), value: JSON.stringify(state) }]);
        const pdf = await pdfLibrary();
        this.check();
        const task = pdf.getDocument(pdfOptions(await file.source.arrayBuffer()));
        try {
          const document = await task.promise;
          state = { status: "working", done: state.done || 0, total: document.numPages };
          await save();
          await db.meta.put({ key: `pdf-page-count:${book.hash}`, value: String(document.numPages) });
          for (let n = state.done + 1; n <= document.numPages; n++) {
            this.check();
            if (!this.books.has(book.id)) throw pause();
            // Yield between pages and keep library taps/scrolling ahead of work.
            while (Date.now() - this.lastInput < 700) {
              await new Promise(resolve => setTimeout(resolve, 100)); this.check();
            }
            await new Promise(resolve => setTimeout(resolve, 40)); this.check();
            const page = await document.getPage(n);
            await preparePageText(book, page, this.ocr, undefined, () => this.check());
            page.cleanup();
            state.done = n;
            await save();
          }
          await publishPreparedText(book, document.numPages);
          state.status = "ready";
          await save();
        } catch (error) {
          const paused = (error as Error)?.name === "AbortError";
          state = { ...state, status: paused ? "paused" : "error", ...(paused ? {} : { error: error instanceof Error ? error.message : String(error) }) };
          await save();
          if (paused) { unfinished = true; break; }
        } finally { await task.destroy().catch(() => {}); }
      }
    } catch (error) {
      if ((error as Error)?.name !== "AbortError") console.warn("Book text preparation paused", error);
      unfinished = true;
    } finally {
      this.busy = false;
      if (this.stopped) this.ocr.destroy();
      else if (unfinished) this.schedule();
      else { this.ocr.destroy(); this.ocr = new PageOcr(); }
    }
  }
  destroy() {
    this.stopped = true; clearTimeout(this.timer);
    window.removeEventListener("pointerdown", this.activity);
    window.removeEventListener("keydown", this.activity);
    window.removeEventListener("wheel", this.activity);
    window.removeEventListener("leafmark-prepare-book", this.retry);
    document.removeEventListener("visibilitychange", this.visibility);
    if (!this.busy) this.ocr.destroy();
  }
}
