import type { Worker } from "tesseract.js";

/** One bounded page at a time, with same-origin engine/model assets. */
export class PageOcr {
  private worker?: Promise<Worker>;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private progress?: (percent: number) => void;
  recognize(canvas: HTMLCanvasElement, progress: (percent: number) => void) {
    const job = this.queue
      .catch(() => {})
      .then(async () => {
        if (this.disposed) throw new Error("Reader closed");
        this.progress = progress;
        this.worker ||= import("tesseract.js").then(({ createWorker }) => {
          const base = new URL(
            `${import.meta.env.BASE_URL}ocr/`,
            location.origin,
          ).href;
          return createWorker("eng", 1, {
            workerPath: `${base}worker.min.js`,
            corePath: base,
            langPath: base.replace(/\/$/, ""),
            workerBlobURL: false,
            logger: ({ status, progress }) => {
              if (status === "recognizing text")
                this.progress?.(Math.round(progress * 100));
            },
          });
        });
        const worker = await this.worker.catch((error) => {
          this.worker = undefined;
          throw error;
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
    this.queue = job;
    return job;
  }
  destroy() {
    this.disposed = true;
    void this.worker?.then((w) => w.terminate()).catch(() => {});
  }
}
