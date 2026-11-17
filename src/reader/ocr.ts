import { createWorker, type Worker } from "tesseract.js";

/** One bounded page at a time, with same-origin engine/model assets. */
export class PageOcr {
  private worker?: Promise<Worker>;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private progress?: (percent: number) => void;
  private cancellations = new Set<(error: DOMException) => void>();
  recognize(canvas: HTMLCanvasElement, progress: (percent: number) => void) {
    if (this.disposed) return Promise.reject(new DOMException("Reader closed", "AbortError"));
    let cancel!: (error: DOMException) => void;
    const closed = new Promise<never>((_resolve, reject) => { cancel = reject; });
    this.cancellations.add(cancel);
    const job = this.queue
      .catch(() => {})
      .then(async () => {
        if (this.disposed) throw new Error("Reader closed");
        this.progress = progress;
        if (!this.worker) {
          const base = new URL(
            `${import.meta.env.BASE_URL}ocr/`,
            location.origin,
          ).href;
          this.worker = createWorker("eng", 1, {
            workerPath: `${base}worker.min.js`,
            corePath: base,
            langPath: base.replace(/\/$/, ""),
            workerBlobURL: false,
            // The job promise reports failures; avoid a second global throw.
            errorHandler: () => {},
            logger: ({ status, progress }) => {
              if (status === "recognizing text")
                this.progress?.(Math.round(progress * 100));
            },
          });
        }
        const worker = await this.worker.catch((error) => {
          this.worker = undefined;
          throw new Error("Text recognition tools could not load. Connect to the internet, then retry text recognition.", { cause: error });
        });
        if (this.disposed) throw new Error("Reader closed");
        const { data } = await worker.recognize(
          canvas,
          {},
          { blocks: true, text: true },
        );
        return (data.blocks || [])
          .flatMap((b) =>
            b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)),
          )
          .filter((w) => w.text.trim() && w.confidence >= 20)
          .map((w) => ({ text: w.text, box: w.bbox }));
      });
    // Tesseract termination need not settle its outstanding recognize promise.
    // Always release callers (and shared page jobs) when this owner closes.
    const result = Promise.race([job, closed]).finally(() => this.cancellations.delete(cancel));
    this.queue = result;
    return result;
  }
  destroy() {
    this.disposed = true;
    for (const cancel of this.cancellations) cancel(new DOMException("Reader closed", "AbortError"));
    this.cancellations.clear();
    void this.worker?.then((w) => w.terminate()).catch(() => {});
  }
}
