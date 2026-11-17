export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("View superseded", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
/** One running view and one replaceable pending intent. All callers settle when
 * the latest view is ready; obsolete work never publishes a completion. */
export class ViewIntent<T extends object> {
  private pending = false;
  private running = false;
  private paused = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private waiters: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  constructor(public target: T, private render: (view: T, signal: AbortSignal) => Promise<void>, private invalidate: () => void, private delay = 150) {}
  request(patch: Partial<T>) {
    if (this.disposed) return Promise.resolve();
    this.target = { ...this.target, ...patch }; this.pending = true;
    this.controller?.abort(); this.invalidate();
    const result = new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
    this.schedule(); return result;
  }
  pause(active: boolean) { this.paused = active; clearTimeout(this.timer); if (!active) this.schedule(); }
  private schedule() { clearTimeout(this.timer); if (!this.disposed && !this.paused && this.pending) this.timer = setTimeout(() => { this.timer = undefined; void this.drain(); }, this.delay); }
  private async drain() {
    if (this.running || this.paused || this.disposed || !this.pending) return;
    this.running = true; this.pending = false;
    const controller = new AbortController(); this.controller = controller;
    let failure: unknown;
    try { await this.render({ ...this.target }, controller.signal); }
    catch (e) { if (!controller.signal.aborted) failure = e; }
    finally { this.running = false; }
    if (this.disposed) return;
    if (this.pending) { this.schedule(); return; }
    const waiters = this.waiters.splice(0);
    for (const w of waiters) failure ? w.reject(failure) : w.resolve();
  }
  destroy() { this.disposed = true; clearTimeout(this.timer); this.controller?.abort(); this.invalidate(); for (const w of this.waiters.splice(0)) w.resolve(); }
}
