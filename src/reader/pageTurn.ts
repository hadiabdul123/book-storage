/** A short compositor-only transition, shared by buttons, keys and swipes. */
export class PageTurn {
  private busy = false;
  private disposed = false;
  private animation?: Animation;
  constructor(private host: HTMLElement) {}
  async run(direction: "next" | "previous", navigate: () => Promise<boolean | void>) {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.host.dataset.pageTurning = direction;
    try {
      const moved = await navigate();
      if (moved === false || this.disposed ||
          matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const offset = direction === "next" ? 24 : -24;
      this.animation = this.host.animate([
        { transform: `translateX(${offset}px)`, opacity: 0.82 },
        { transform: "translateX(0)", opacity: 1 },
      ], { duration: 180, easing: "cubic-bezier(.2,.7,.3,1)" });
      await this.animation.finished.catch(() => {});
    } finally {
      this.animation = undefined;
      delete this.host.dataset.pageTurning;
      this.busy = false;
    }
  }
  destroy() {
    this.disposed = true;
    this.animation?.cancel();
    delete this.host.dataset.pageTurning;
  }
}
