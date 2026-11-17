import { animationClock } from "./animationClock";
import flipScript from "page-flip/dist/js/page-flip.browser.js?url";
import { waitForSurfaces, type TurnDirection, type TurnPoint, type TurnPreview, type TurnSpread } from "./turnSurfaces";
import "../pageTurn.css";

interface FlipEngine {
  loadFromHTML(pages: HTMLElement[]): void;
  updateFromHtml(pages: HTMLElement[]): void;
  flipNext(corner: string): void;
  flipPrev(corner: string): void;
  turnToPage(page: number): void;
  startUserTouch(point: TurnPoint): void;
  userMove(point: TurnPoint, touch: boolean): void;
  userStop(point: TurnPoint, swipe: boolean): void;
  on(name: string, listener: (event: { data: any }) => void): void;
  getPageCollection(): { getPages(): { newTemporaryCopy(): unknown }[] };
  getRender(): { startAnimation(frames: (() => void)[], duration: number, done: () => void): void };
  getFlipController(): {
    do(point: TurnPoint): void;
    setState(state: string): void;
    getCalculation(): { getPosition(): TurnPoint; getCorner(): string } | null;
    animateFlippingTo(start: TurnPoint, end: TurnPoint, turned: boolean): void;
  };
}
type Realm = { frame: HTMLIFrameElement; engine: FlipEngine; clock: ReturnType<typeof animationClock>; key: string; flip?: (page: number) => void; state?: (state: string) => void };
type Stage = { engine: FlipEngine; point: (p: TurnPoint) => TurnPoint; release: () => void; finishDrag: (start: TurnPoint, end: TurnPoint, velocity?: number) => void; done: Promise<boolean>; cancel: () => void };
export type TurnSource = {
  enabled: () => boolean;
  canDrag: () => boolean;
  canWarm?: () => boolean;
  canTap?: () => boolean;
  tapBounds?: () => DOMRect;
  navigate?: (direction: TurnDirection) => Promise<void>;
  bounds: () => DOMRect;
  location: () => string;
  prepare: (direction: TurnDirection, outgoing?: TurnSpread) => Promise<TurnPreview | null>;
};

/** Reuse the renderer at a fixed geometry, pausing its private clock at rest.
 * The live selectable page navigates only after a completed fold. */
export class PageTurn {
  private busy = false;
  private disposed = false;
  private committing = false;
  private revision = 0;
  private stage?: Stage;
  private realm?: Realm;
  private cache = new Map<TurnDirection, Promise<TurnPreview | null>>();
  private outgoing?: TurnSpread;
  private timer?: ReturnType<typeof setTimeout>;
  private cleanups: (() => void)[] = [];
  constructor(private host: HTMLElement, private source: TurnSource) {
    const resized = () => { this.invalidate(); this.disposeRealm(); };
    window.addEventListener("resize", resized);
    this.cleanups.push(() => window.removeEventListener("resize", resized));
  }
  private motion() { return !matchMedia("(prefers-reduced-motion: reduce)").matches; }
  invalidate() {
    if (this.committing) return;
    this.revision++;
    this.stage?.cancel();
    this.stage = undefined;
    clearTimeout(this.timer);
    for (const value of this.cache.values()) void value.then(p => p?.dispose());
    this.cache.clear();
    this.outgoing = undefined;
    this.host.dataset.edgeTurns = String(this.source.enabled());
    if (!this.disposed) this.timer = setTimeout(() => void this.warm(), 250);
  }
  private async warm() {
    if (this.busy || this.disposed || !this.source.enabled() || !this.motion()) return;
    if (this.source.canWarm?.() === false) { this.timer = setTimeout(() => void this.warm(), 800); return; }
    const next = await this.preview("next");
    if (next && !this.realm && !this.busy && !this.disposed) await this.createStage(next, "next", this.revision, true).catch(() => {});
    if (!this.busy && !this.disposed) await this.preview("previous");
  }
  private preview(direction: TurnDirection) {
    let value = this.cache.get(direction);
    if (!value) {
      const revision = this.revision;
      let expired = false, timer: ReturnType<typeof setTimeout> | undefined;
      const prepared = this.source.prepare(direction, this.outgoing).then(preview => {
        if (expired) { preview?.dispose(); return null; }
        return preview;
      });
      const deadline = new Promise<null>(resolve => { timer = setTimeout(() => { expired = true; resolve(null); }, 2500); });
      value = Promise.race([prepared, deadline]).then(preview => {
        if (this.disposed || revision !== this.revision) { preview?.dispose(); return null; }
        if (preview) this.outgoing = preview.outgoing;
        else this.cache.delete(direction);
        return preview;
      }).catch(error => { if (revision === this.revision) this.cache.delete(direction); console.warn("Paper turn prepare unavailable", error); return null; }).finally(() => clearTimeout(timer));
      this.cache.set(direction, value);
    }
    return value;
  }
  private async commit(preview: TurnPreview) {
    this.committing = true;
    try { await preview.commit(); } finally { this.committing = false; }
  }
  private finish() {
    this.stage?.cancel(); this.stage = undefined;
    this.busy = false;
    delete this.host.dataset.pageTurning;
    delete this.host.dataset.pageTurnState;
    this.invalidate();
  }
  async run(direction: TurnDirection, navigate: () => Promise<boolean | void>) {
    if (this.busy || this.disposed) return;
    this.busy = true;
    const revision = this.revision;
    const startLocation = this.source.location();
    const sameLocation = () => !this.disposed && this.source.location() === startLocation;
    let navigating = false;
    const fallback = () => { navigating = true; return navigate(); };
    this.host.dataset.pageTurning = direction;
    try {
      if (!this.source.enabled() || !this.motion()) { await fallback(); return; }
      const preview = await this.preview(direction);
      if (this.disposed) return;
      if (revision !== this.revision || !preview) {
        if (sameLocation()) await fallback();
        return;
      }
      const stage = await this.createStage(preview, direction, revision);
      if (!stage) { if (sameLocation()) await fallback(); return; }
      if (direction === "next") stage.engine.flipNext("bottom"); else stage.engine.flipPrev("bottom");
      stage.release();
      if (await stage.done) { if (sameLocation()) { navigating = true; await this.commit(preview); } }
      // A layout refresh may discard a preview after the user requested a
      // button/key turn. Complete that intent once if its starting location is
      // still current. An explicit jump elsewhere supersedes the old request.
      else if (sameLocation()) await fallback();
    } catch (error) {
      console.warn("Paper turn unavailable", error);
      if (navigating) throw error;
      if (sameLocation()) await fallback();
    } finally { this.finish(); }
  }
  private async createStage(preview: TurnPreview, direction: TurnDirection, revision: number, priming = false): Promise<Stage | undefined> {
    const { width, height, columns } = preview.outgoing;
    const box = this.source.bounds(), shell = this.host.closest(".reader-shell") as HTMLElement;
    const shellBox = shell.getBoundingClientRect();
    const key = `${width}:${height}:${columns}`;
    if (this.realm?.key !== key) this.disposeRealm();
    let realm = this.realm;
    const frame = realm?.frame || document.createElement("iframe");
    frame.className = "paper-turn-stage";
    frame.setAttribute("aria-hidden", "true"); frame.tabIndex = -1;
    // This realm runs only the bundled renderer. Book copies inside it keep
    // their own script-disabled sandbox and the sanitized chapter CSP.
    frame.title = "Page turn";
    Object.assign(frame.style, { left: `${box.left - shellBox.left}px`, top: `${box.top - shellBox.top}px`, width: `${width * columns}px`, height: `${height}px`, visibility: "hidden" });
    if (!realm) {
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Page turn timed out")), 2500);
      frame.onload = () => { clearTimeout(timer); resolve(); };
    });
    frame.srcdoc = '<!doctype html><html><head></head><body><div id="book"></div></body></html>';
    shell.append(frame);
    try {
      await loaded;
      if (this.disposed || revision !== this.revision) { frame.remove(); return; }
      const doc = frame.contentDocument!;
      const clock = animationClock(window.requestAnimationFrame.bind(window), window.cancelAnimationFrame.bind(window));
      frame.contentWindow!.requestAnimationFrame = clock.request;
      frame.contentWindow!.cancelAnimationFrame = clock.cancel;
      const style = doc.createElement("style");
      style.textContent = `html,body{margin:0;width:100%;height:100%;overflow:hidden}#book{width:100%;height:100%}.turn-leaf{position:relative;overflow:hidden;background:${getComputedStyle(shell).getPropertyValue("--page-bg") || "#f4ecd9"}}.turn-leaf iframe{border:0;pointer-events:none}.turn-leaf img{max-width:none}`;
      doc.head.append(style);
      await new Promise<void>((resolve, reject) => {
        const script = doc.createElement("script");
        const timer = setTimeout(() => reject(new Error("Page turn unavailable")), 2500);
        script.onload = () => { clearTimeout(timer); resolve(); };
        script.onerror = () => { clearTimeout(timer); reject(new Error("Page turn unavailable")); };
        script.src = new URL(flipScript, location.href).href; doc.head.append(script);
      });
      if (this.disposed || revision !== this.revision) { frame.remove(); return; }
      const Flip = (frame.contentWindow as unknown as { St: { PageFlip: new (element: HTMLElement, settings: object) => FlipEngine } }).St.PageFlip;
      const engine = new Flip(doc.getElementById("book")!, { width, height, size: "fixed", autoSize: false, usePortrait: columns === 1, showCover: false, startPage: direction === "next" ? 0 : columns, flippingTime: 400, drawShadow: true, maxShadowOpacity: .24, useMouseEvents: false, showPageCorners: false, disableFlipByClick: false });
      const initialized = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Page turn initialization timed out")), 2500);
        engine.on("init", () => { clearTimeout(timer); resolve(); });
      });
      engine.loadFromHTML((direction === "next" ? [...preview.outgoing.leaves, ...preview.incoming.leaves] : [...preview.incoming.leaves, ...preview.outgoing.leaves]).map(page => page.cloneNode(true) as HTMLElement));
      await initialized;
      realm = { frame, engine, clock, key };
      engine.on("flip", event => realm!.flip?.(event.data));
      engine.on("changeState", event => realm!.state?.(event.data));
      this.realm = realm;
    } catch (error) { frame.remove(); throw error; }
    } else {
      const pages = direction === "next" ? [...preview.outgoing.leaves, ...preview.incoming.leaves] : [...preview.incoming.leaves, ...preview.outgoing.leaves];
      try { realm.engine.updateFromHtml(pages.map(page => page.cloneNode(true) as HTMLElement)); }
      catch (error) { this.disposeRealm(); throw error; }
    }
    const { engine, clock } = realm!;
    try {
      const doc = frame.contentDocument!;
      const background = getComputedStyle(shell).getPropertyValue("--page-bg") || "#f4ecd9";
      doc.querySelectorAll<HTMLElement>(".turn-leaf").forEach(leaf => { leaf.style.background = background; });
      if (columns === 1 && direction === "next") engine.getPageCollection().getPages()[0].newTemporaryCopy();
      await waitForSurfaces(doc);
      // Hidden iframe animation clocks can pause completely (especially in
      // WebKit). The vendor's init event, rather than an iframe RAF, confirms
      // its initial orientation update before the preview becomes visible.
      engine.turnToPage(direction === "next" ? 0 : columns);
      let moved = false, released = false, settled = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let resolve!: (moved: boolean) => void;
      const done = new Promise<boolean>(r => { resolve = r; });
      const settle = (value: boolean) => { if (!settled) { settled = true; clearTimeout(watchdog); resolve(value); } };
      realm!.flip = page => { moved = page === (direction === "next" ? columns : 0); };
      realm!.state = state => { this.host.dataset.pageTurnState = state; if (released && state === "read") settle(moved); };
      const stage: Stage = { engine, point: p => ({ x: p.x - box.left, y: p.y - box.top }), done,
        release: () => { released = true; watchdog = setTimeout(() => settle(moved), 1600); },
        finishDrag: (start, end, velocity = 0) => {
          if (released) return;
          engine.userMove(stage.point(end), true);
          stage.release(); engine.userStop(stage.point(end), true);
          const controller = engine.getFlipController(), calculation = controller.getCalculation();
          if (!calculation) { settle(false); return; }
          const distance = direction === "next" ? start.x - end.x : end.x - start.x;
          const complete = distance > width * .45 || (distance > width * .3 && velocity > width * .8);
          // Pinned StPageFlip 2.0.7 exposes this JS method. Its default portrait
          // release commits every backward drag; choose a symmetric threshold
          // while continuing its animation from the exact held fold position.
          const from = calculation.getPosition(), to = { x: complete ? -width : width, y: calculation.getCorner() === "bottom" ? height : 0 };
          const duration = Math.max(180, Math.min(450, 180 + Math.abs(to.x - from.x) / width * 110 - Math.abs(velocity) / width * 25));
          const frames = Array.from({ length: 60 }, (_, i) => () => {
            const t = 1 - Math.pow(1 - (i + 1) / 60, 3);
            controller.do({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
          });
          controller.setState("flipping");
          // The vendor clears its animation after invoking its completion callback.
          // Queue the final commit to avoid that cleanup discarding the new animation.
          engine.getRender().startAnimation(frames, duration, () => queueMicrotask(() => {
            if (!settled) controller.animateFlippingTo({ x: to.x + (complete ? 1 : -1), y: to.y }, to, complete);
          }));
        },
        cancel: () => {
          const reusable = settled && this.host.dataset.pageTurnState === "read";
          settle(false); clock.pause(); realm!.flip = undefined; realm!.state = undefined;
          frame.className = "paper-turn-realm"; frame.style.visibility = "hidden";
          if (!reusable) this.disposeRealm();
        },
      };
      if (this.disposed || revision !== this.revision) { stage.cancel(); return; }
      if (priming) { settle(false); realm!.flip = undefined; realm!.state = undefined; clock.pause(); frame.className = "paper-turn-realm"; return stage; }
      this.stage = stage; frame.style.visibility = "visible"; clock.resume();
      return stage;
    } catch (error) { this.disposeRealm(); frame.remove(); throw error; }
  }
  private disposeRealm() { this.realm?.clock.destroy(); this.realm?.frame.remove(); this.realm = undefined; }
  bind(root: HTMLElement | Document, toViewport: (point: TurnPoint) => TurnPoint = p => p) {
    const doc = root.nodeType === 9 ? root as Document : root.ownerDocument!;
    type Press = { id: number; start: TurnPoint; latest: TurnPoint; direction: TurnDirection; claimed: boolean; released: boolean; cancelled: boolean; at: number; sample: TurnPoint; sampleAt: number; velocity: number };
    let press: Press | undefined, moveFrame = 0, suppressUntil = 0;
    const cancel = () => { cancelAnimationFrame(moveFrame); moveFrame = 0; if (press) { press.cancelled = true; if (press.claimed) this.invalidate(); } press = undefined; };
    const allowed = () => this.source.enabled() && this.source.canDrag() && !doc.getSelection()?.toString().trim();
    const down = (event: Event) => {
      const e = event as PointerEvent;
      if (e.button !== 0) return;
      if (!e.isPrimary) { cancel(); return; }
      if (this.busy || !(allowed() || this.source.canTap?.()) || (window.visualViewport?.scale || 1) > 1.01 || (e.target as Element).closest?.("button,a,input,textarea,select,[contenteditable]")) return;
      const point = toViewport({ x: e.clientX, y: e.clientY }), box = this.source.tapBounds?.() || this.source.bounds();
      if (point.y < box.top || point.y > box.bottom || point.x < box.left || point.x > box.right) return;
      const direction = point.x >= box.right - 44 ? "next" : point.x <= box.left + 44 ? "previous" : undefined;
      if (direction) {
        press = { id: e.pointerId, start: point, latest: point, direction, claimed: false, released: false, cancelled: false, at: performance.now(), sample: point, sampleAt: performance.now(), velocity: 0 };
        // The outer mouse grab must not create a native text range underneath
        // the fold. Touch long presses remain available until a drag is claimed.
        if (e.pointerType === "mouse") e.preventDefault();
      }
    };
    const start = async (p: Press) => {
      this.busy = true;
      const revision = this.revision;
      this.host.dataset.pageTurning = p.direction;
      try {
        const preview = await this.preview(p.direction);
        if (!preview || p.cancelled || revision !== this.revision || this.disposed) return;
        const stage = await this.createStage(preview, p.direction, revision);
        if (!stage || p.cancelled) { stage?.cancel(); return; }
        stage.engine.startUserTouch(stage.point(p.start));
        stage.engine.userMove(stage.point({ x: p.start.x + (p.direction === "next" ? -8 : 8), y: p.start.y }), true);
        stage.engine.userMove(stage.point(p.latest), true);
        if (p.released) stage.finishDrag(p.start, p.latest, p.velocity);
        if (await stage.done) await this.commit(preview);
      } catch (error) { console.warn("Paper turn drag unavailable", error); }
      finally { this.finish(); }
    };
    const move = (event: Event) => {
      const e = event as PointerEvent, p = press;
      if (!p || p.id !== e.pointerId) return;
      p.latest = toViewport({ x: e.clientX, y: e.clientY });
      const at = performance.now(), elapsed = at - p.sampleAt;
      if (elapsed > 0) { p.velocity = (p.direction === "next" ? p.sample.x - p.latest.x : p.latest.x - p.sample.x) / elapsed * 1000; p.sample = p.latest; p.sampleAt = at; }
      const dx = p.latest.x - p.start.x, dy = p.latest.y - p.start.y;
      if (!p.claimed) {
        if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { cancel(); return; }
        if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.2 || (p.direction === "next" ? dx > 0 : dx < 0)) return;
        if (!allowed()) { cancel(); return; }
        p.claimed = true; (e.target as Element).setPointerCapture?.(e.pointerId);
        if (this.motion()) void start(p);
      }
      e.preventDefault();
      if (!moveFrame) moveFrame = requestAnimationFrame(() => {
        moveFrame = 0;
        if (this.stage && press === p && !p.cancelled && !p.released) this.stage.engine.userMove(this.stage.point(p.latest), true);
      });
    };
    const up = (event: Event) => {
      const e = event as PointerEvent, p = press;
      if (!p || p.id !== e.pointerId) return;
      cancelAnimationFrame(moveFrame); moveFrame = 0;
      press = undefined; p.latest = toViewport({ x: e.clientX, y: e.clientY }); p.released = true;
      if (!p.claimed) {
        if (performance.now() - p.at < 300 && Math.hypot(p.latest.x - p.start.x, p.latest.y - p.start.y) < 8 && this.source.canTap?.() && this.source.navigate) {
          suppressUntil = performance.now() + 500;
          e.preventDefault(); e.stopPropagation();
          void this.source.navigate(p.direction).catch(error => console.warn("Edge turn unavailable", error));
        }
        return;
      }
      e.preventDefault();
      suppressUntil = performance.now() + 500;
      if (!this.motion()) {
        if (Math.abs(p.latest.x - p.start.x) > this.source.bounds().width / 3 && allowed()) {
          void this.run(p.direction, async () => { const preview = await this.preview(p.direction); if (preview) await this.commit(preview); });
        }
      } else if (this.stage) this.stage.finishDrag(p.start, p.latest, performance.now() - p.sampleAt > 100 ? 0 : p.velocity);
    };
    const bindings: [string, EventListener][] = [["pointerdown", down], ["pointermove", move], ["pointerup", up], ["pointercancel", cancel]];
    const click = (e: Event) => { if (performance.now() < suppressUntil) { e.preventDefault(); e.stopImmediatePropagation(); } };
    root.addEventListener("click", click, true);
    bindings.forEach(([name, fn]) => root.addEventListener(name, fn, { passive: false }));
    this.cleanups.push(() => { cancel(); root.removeEventListener("click", click, true); bindings.forEach(([name, fn]) => root.removeEventListener(name, fn)); });
  }
  destroy() {
    this.disposed = true; this.invalidate(); this.disposeRealm(); this.cleanups.forEach(fn => fn());
    delete this.host.dataset.edgeTurns; delete this.host.dataset.pageTurning; delete this.host.dataset.pageTurnState;
  }
}
