import { db } from "../db";
import { savePageCache } from "../pdfText";
import { bindTouchSelection, type TouchSelection } from "./touchSelection";
import { bindNativeSelection } from "./nativeSelection";
import { PageTurn } from "./pageTurn";
import { blankLeaf, surfaceCache, waitForSurfaces, type TurnDirection, type TurnPreview, type TurnSpread } from "./turnSurfaces";
import { bindPageSwipes } from "./swipes";
import { bindReadingTaps } from "./gestures";
import ePub, {
  EpubCFI,
  type Book as EpubBook,
  type Rendition,
  type Contents,
} from "epubjs";
import DOMPurify from "dompurify";
import { rectsForRange, rangeOverlap } from "./geometry";
import literataFont from "@fontsource/literata/files/literata-latin-400-normal.woff2?url";
import sansFont from "@fontsource/source-sans-3/files/source-sans-3-latin-400-normal.woff2?url";
import { findQuote, offsetsForRange, rangeForOffsets } from "../anchors";
import {
  colors,
  type Annotation,
  type Book,
  type Locator,
  type Preferences,
} from "../model";
import type { ReaderAdapter, ReaderEvents, SearchHit, Section } from "./types";
import { surroundingText } from "../sourceIndex";
import { pagePalettes } from "../readingAppearance";

export class EpubReader implements ReaderAdapter {
  async context(selection: import("./types").Selection) {
    if (selection.locator.type !== "epub") return selection.text;
    const section = this.epub.spine.get(selection.locator.href);
    await section.load(this.epub.load.bind(this.epub));
    return surroundingText(section.document.body.textContent || "", selection.text,
      `${selection.locator.quote?.prefix || ""}${selection.text}${selection.locator.quote?.suffix || ""}`);
  }
  private turn: PageTurn;
  private touchSelections = new Map<Document, TouchSelection>();
  private epub!: EpubBook;
  private rendition!: Rendition;
  private prefs!: Preferences;
  private appliedPrefs?: Preferences;
  private marks: Annotation[] = [];
  private rendered = new Set<string>();
  private cleanups: (() => void)[] = [];
  private disposed = false;
  private positionsReady = false;
  private spineCount = 1;
  private resizeObserver?: ResizeObserver;
  private source?: Blob;
  private previewReader?: EpubReader;
  private previewHost?: HTMLElement;
  private previewReady?: Promise<void>;
  private previewQueue: Promise<unknown> = Promise.resolve();
  private lastCfi = "";
  private turnCopies = new Map<string, { spread: TurnSpread; dispose: () => void }>();
  private copyRevision = 0;
  private clearTurnCopies() { this.copyRevision++; for (const copy of this.turnCopies.values()) copy.dispose(); this.turnCopies.clear(); }
  constructor(
    private host: HTMLElement,
    private book: Book,
    private events: ReaderEvents,
    private previewOnly = false,
  ) {
    this.turn = new PageTurn(host, {
      enabled: () => !this.previewOnly && !!this.rendition && this.prefs?.flow === "paginated" && this.prefs?.pageTurnEffect !== "none",
      canDrag: () => !!this.events.canDragTurn?.() && !this.hasSelection(),
      canWarm: () => this.events.canPrepare?.() !== false,
      bounds: () => this.host.getBoundingClientRect(),
      location: () => this.lastCfi,
      prepare: (direction, outgoing) => this.prepareTurn(direction, outgoing),
    });
  }
  async open(source: Blob) {
    this.source = source;
    this.epub = ePub(await source.arrayBuffer());
    await this.epub.opened;
    await this.epub.ready;
    if (this.disposed) return;
    let count = 0;
    this.epub.spine.each(() => count++);
    this.spineCount = Math.max(1, count);
    this.epub.spine.hooks.content.register(
      (doc: Document, section: { url: string }) => {
        // Sanitize the canonical section DOM before CFIs, search, or rendering use it.
        DOMPurify.sanitize(doc.documentElement, {
          IN_PLACE: true,
          WHOLE_DOCUMENT: true,
          ADD_TAGS: ["link"],
          ADD_ATTR: ["xmlns"],
          FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
          FORBID_ATTR: ["srcset"],
        });
        doc
          .querySelectorAll("script,iframe,object,embed,form,meta[http-equiv]")
          .forEach((e) => e.remove());
        doc.querySelectorAll("*").forEach((el) =>
          Array.from(el.attributes).forEach((a) => {
            if (
              a.name.startsWith("on") ||
              ((a.name === "src" || a.name === "href") &&
                /^(https?:|\/\/|javascript:)/i.test(a.value) &&
                el.tagName !== "A")
            )
              el.removeAttribute(a.name);
          }),
        );
        // WebKit blocks parent-owned input listeners in script-disabled frames.
        // Permit the reader's listeners while forbidding all book scripts with CSP.
        const policy = doc.createElement("meta");
        policy.setAttribute("http-equiv", "Content-Security-Policy");
        policy.setAttribute("content", "script-src 'none'; object-src 'none'; form-action 'none'");
        doc.head.prepend(policy);
        const base = doc.createElement("base");
        const target = new URL(section.url, location.origin);
        if (target.origin === location.origin) {
          base.setAttribute("href", target.href);
          doc.head.prepend(base);
        }
      },
    );
    this.rendition = this.epub.renderTo(this.host, {
      width: "100%",
      height: "100%",
      flow: "scrolled-doc",
      manager: "default",
      spread: "none",
      ...{ gap: 2 },
      allowScriptedContent: true,
    });
    this.rendition.hooks.content.register((contents: Contents) =>
      this.bind(contents),
    );
    this.rendition.on("relocated", (location: any) => {
      if (!location.start) return;
      const locator: Locator = {
        v: 1,
        type: "epub",
        hash: this.book.hash,
        cfi: location.start.cfi,
        href: location.start.href,
      };
      this.events.onLocation(
        locator,
        this.positionsReady
          ? this.epub.locations.percentageFromCfi(location.start.cfi)
          : (location.start.index || 0) / this.spineCount,
      );
      this.updateSpread();
      if (this.lastCfi !== location.start.cfi) { this.lastCfi = location.start.cfi; this.turn.invalidate(); }
    });
    this.rendition.on("rendered", () => { this.draw(); this.updateSpread(); });
    if (this.prefs) this.configure(this.prefs);
    await this.rendition.display();
    let width = this.host.clientWidth, height = this.host.clientHeight;
    this.resizeObserver = new ResizeObserver(() => {
      const nextWidth = this.host.clientWidth, nextHeight = this.host.clientHeight;
      if (nextWidth > 0 && nextHeight > 0 && (nextWidth !== width || nextHeight !== height)) {
        width = nextWidth;
        height = nextHeight;
        this.turn.invalidate();
        this.rendition.resize(width, height);
      }
    });
    this.resizeObserver.observe(this.host);
    // Pagination-independent text locations; do not block opening a large book.
    if (!this.previewOnly) void (async () => {
      const key = `epub-locations-v1:${this.book.id}:${this.book.hash}`;
      const saved = await db.meta.get(key);
      if (this.disposed) return;
      let loaded = false;
      if (saved) try { this.epub.locations.load(saved.value); loaded = true; } catch { /* Rebuild corrupt pagination data. */ }
      if (!loaded) {
        await this.epub.locations.generate(1200);
        if (!this.disposed) await savePageCache(this.book, [{ key, value: this.epub.locations.save() }]);
      }
      this.positionsReady = true;
      if (!this.disposed) void this.rendition.reportLocation();
    })().catch(() => {});
  }
  private bind(contents: Contents) {
    const doc = contents.document;
    void contents.addStylesheetCss(
      `@font-face{font-family:Literata;src:url("${new URL(literataFont, location.href).href}")}@font-face{font-family:"Source Sans 3";src:url("${new URL(sansFont, location.href).href}")}`,
      "leafmark-fonts",
    );
    if (this.previewOnly) return;
    this.turn.bind(doc, point => {
      const frame = doc.defaultView?.frameElement as HTMLElement;
      const box = frame.getBoundingClientRect();
      return { x: box.left + point.x * box.width / frame.clientWidth, y: box.top + point.y * box.height / frame.clientHeight };
    });
    const touch = bindTouchSelection(doc.body, {
      selected: range => {
        for (const [other, selection] of this.touchSelections) if (other !== doc) selection.clear();
        this.readSelection(range, contents, true);
      },
      cleared: () => this.events.onSelection(null),
      adjusting: this.events.onSelectionInteraction,
      allowed: () => !this.host.dataset.pageTurning,
    });
    this.touchSelections.set(doc, touch);
    const layout = () => this.host.dispatchEvent(new Event("reader-layout"));
    doc.addEventListener("reader-layout", layout); doc.addEventListener("scroll", layout, { capture: true, passive: true });
    doc.fonts.addEventListener("loadingdone", layout);
    const resize = new ResizeObserver(layout); resize.observe(doc.body);
    const unbindNativeSelection = bindNativeSelection(doc.body, {
      selected: range => range ? this.readSelection(range, contents) : this.events.onSelection(null),
      dragging: this.events.onMouseSelection,
    });
    const dismissBlank = () => {
      if (doc.getSelection()?.isCollapsed && !touch.hasSelection()) this.events.onSelection(null);
    };
    doc.addEventListener("pointerup", dismissBlank);
    const unbindSwipes = bindPageSwipes(
      doc,
      () => !this.host.dataset.pageTurning && (this.events.canSwipe?.() || false),
      (direction) => this.events.onReaderSwipe?.(direction),
    );
    const unbindTaps = bindReadingTaps(doc, () => this.events.onReaderTap?.());
    const key = (event: KeyboardEvent) => {
      this.events.onShortcut?.(event);
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        /INPUT|TEXTAREA/.test(event.target.tagName)
      )
        return;
      if (this.hasSelection()) return;
      if (event.key === "ArrowRight") void this.next();
      if (event.key === "ArrowLeft") void this.previous();
    };
    doc.addEventListener("keydown", key);
    this.cleanups.push(() => {
      unbindNativeSelection();
      doc.removeEventListener("pointerup", dismissBlank);
      resize.disconnect(); doc.removeEventListener("reader-layout", layout); doc.removeEventListener("scroll", layout, true); doc.fonts.removeEventListener("loadingdone", layout);
      touch.destroy(); this.touchSelections.delete(doc);
      unbindTaps();
      unbindSwipes();
      doc.removeEventListener("keydown", key);
    });
  }
  private readSelection(range: Range, contents: Contents, touch = false) {
    try {
      const text = range.toString();
      if (!text.trim()) return;
      const cfi = contents.cfiFromRange(range);
      const quote = offsetsForRange(contents.document.body, range).quote;
      const section = this.epub.spine.get(cfi);
      this.events.onSelection({
        locator: {
          v: 1,
          type: "epub",
          hash: this.book.hash,
          cfi,
          href: section.href,
          quote,
        },
        text,
      }, touch ? "touch" : "native");
    } catch {
      /* Ignore transient native selections while the handles are being dragged. */
    }
  }
  async goTo(locator: Locator | string) {
    if (typeof locator === "string") {
      await this.rendition.display(locator);
      return;
    }
    if (locator.type !== "epub" || locator.hash !== this.book.hash)
      throw new Error("This passage belongs to a different document.");
    if (!locator.quote) {
      await this.rendition.display(locator.cfi);
      return;
    }
    try {
      const range = await this.epub.getRange(locator.cfi);
      if (range.toString() === locator.quote.exact) {
        await this.rendition.display(locator.cfi);
        return;
      }
    } catch {
      /* Use the quote only if its context identifies a unique passage. */
    }
    const section = this.epub.spine.get(locator.href);
    await section.load(this.epub.load.bind(this.epub));
    const found = findQuote(
      section.document.body.textContent || "",
      locator.quote,
    );
    if (!found)
      throw new Error(
        "This saved passage could not be located unambiguously. Your note is still saved.",
      );
    const range = rangeForOffsets(
      section.document.body,
      found.start,
      found.end,
    );
    if (!range) throw new Error("Passage unavailable.");
    await this.rendition.display(section.cfiFromRange(range));
  }
  async next() {
    if (this.hasSelection()) return;
    await this.turn.run("next", async () => { await this.rendition.next(); });
  }
  async previous() {
    if (this.hasSelection()) return;
    await this.turn.run("previous", async () => { await this.rendition.prev(); });
  }
  hasSelection() {
    return [...this.touchSelections.entries()].some(([doc, t]) => this.host.contains(doc.defaultView?.frameElement || null) && t.hasSelection()) || (
      (this.rendition?.getContents() as unknown as Contents[]) || []
    ).some((c) => !c.document.getSelection()?.isCollapsed);
  }
  private updateSpread() {
    const layout = (this.rendition as unknown as { manager?: { layout?: { divisor: number } } })?.manager?.layout;
    this.host.dataset.bookSpread = String(this.prefs?.flow === "paginated" && layout?.divisor === 2);
  }
  private async captureTurn(): Promise<{ spread: TurnSpread; dispose: () => void }> {
    const box = this.host.getBoundingClientRect(), columns = this.host.dataset.bookSpread === "true" ? 2 : 1;
    const width = box.width / columns, height = box.height;
    const cache = surfaceCache(this.host, box.width, height), leaves: HTMLElement[] = [];
    for (let n = 0; n < columns; n++) {
      const leaf = blankLeaf(width, height);
      for (const original of this.host.querySelectorAll<HTMLIFrameElement>(".epub-view iframe")) {
        const rect = original.getBoundingClientRect();
        if (rect.right <= box.left || rect.left >= box.right || !original.contentDocument) continue;
        const mirror = document.createElement("iframe");
        mirror.tabIndex = -1; mirror.setAttribute("aria-hidden", "true");
        mirror.setAttribute("sandbox", "allow-same-origin");
        const html = original.contentDocument.documentElement.cloneNode(true) as HTMLElement;
        const styles = html.querySelectorAll("style");
        // EPUB.js inserts theme/font rules through CSSOM. outerHTML alone
        // serializes empty style tags, changing the type and pagination.
        original.contentDocument.querySelectorAll("style").forEach((style, index) => {
          try { if (style.sheet) styles[index].textContent = [...style.sheet.cssRules].map(rule => rule.cssText).join("\n"); }
          catch { /* Linked book styles retain their sanitized blob URLs. */ }
        });
        mirror.srcdoc = html.outerHTML;
        Object.assign(mirror.style, { position: "absolute", border: "0", width: `${original.clientWidth}px`, height: `${original.clientHeight}px`, left: `${rect.left - box.left - n * width}px`, top: `${rect.top - box.top}px`, pointerEvents: "none" });
        leaf.append(mirror);
      }
      for (const original of this.host.querySelectorAll<SVGElement>(".epub-view > svg")) {
        const rect = original.getBoundingClientRect(), clone = original.cloneNode(true) as SVGElement;
        Object.assign(clone.style, { position: "absolute", left: `${rect.left - box.left - n * width}px`, top: `${rect.top - box.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, pointerEvents: "none" });
        leaf.append(clone);
      }
      leaves.push(leaf); cache.append(leaf);
    }
    await waitForSurfaces(cache);
    return { spread: { leaves, width, height, columns }, dispose: () => cache.remove() };
  }
  private prepareTurn(direction: TurnDirection, shared?: TurnSpread): Promise<TurnPreview | null> {
    // One hidden rendition handles both neighbours without navigating the book
    // whose location is saved. Keep it alive for the mirror's blob resources.
    const revision = this.copyRevision;
    const job = this.previewQueue.catch(() => {}).then(async () => {
      const current = this.rendition.currentLocation() as unknown as { start?: { cfi: string }; atStart?: boolean; atEnd?: boolean };
      if (!current?.start || this.disposed || (direction === "next" ? current.atEnd : current.atStart)) return null;
      const cfi = current.start.cfi, prefs = { ...this.prefs };
      const size = `${this.host.clientWidth}:${this.host.clientHeight}:`;
      const copy = async (key: string, reader: EpubReader) => {
        const cached = this.turnCopies.get(size + key);
        if (cached) { this.turnCopies.delete(size + key); this.turnCopies.set(size + key, cached); return cached; }
        const result = await reader.captureTurn();
        if (revision !== this.copyRevision || this.disposed) { result.dispose(); throw new Error("Page layout changed"); }
        this.turnCopies.set(size + key, result);
        while (this.turnCopies.size > 3) { const oldest = this.turnCopies.keys().next().value!; this.turnCopies.get(oldest)!.dispose(); this.turnCopies.delete(oldest); }
        return result;
      };
      if (!this.previewReader) {
        const host = surfaceCache(this.host, this.host.clientWidth, this.host.clientHeight);
        host.className = "turn-preparer";
        this.previewHost = host;
        this.previewReader = new EpubReader(host, this.book, { onLocation() {}, onSelection() {}, onAnnotation() {}, onError() {} }, true);
        this.previewReader.configure(prefs);
        this.previewReady = this.previewReader.open(this.source!);
      }
      await this.previewReady;
      if (this.disposed) return null;
      const helper = this.previewReader;
      Object.assign(this.previewHost!.style, { width: `${this.host.clientWidth}px`, height: `${this.host.clientHeight}px` });
      helper.configure(prefs); helper.annotate(this.marks);
      helper.rendition.resize(this.host.clientWidth, this.host.clientHeight);
      await helper.rendition.display(cfi);
      await helper.rendition.reportLocation();
      if (direction === "next") await helper.rendition.next(); else await helper.rendition.prev();
      await helper.rendition.reportLocation();
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      for (const content of helper.rendition.getContents() as unknown as Contents[]) await content.document.fonts.ready;
      const target = helper.rendition.currentLocation() as unknown as { start?: { cfi: string } };
      if (!target?.start || target.start.cfi === cfi || this.disposed) return null;
      const outgoing = shared ? { spread: shared, dispose() {} } : await copy(cfi, this);
      const incoming = await copy(target.start.cfi, helper);
      return { outgoing: outgoing.spread, incoming: incoming.spread, commit: async () => { await this.rendition.display(target.start!.cfi); }, dispose() {} };
    });
    this.previewQueue = job;
    return job;
  }
  async search(query: string): Promise<SearchHit[]> {
    const results: SearchHit[] = [];
    if (!query.trim()) return results;
    const sections: any[] = [];
    this.epub.spine.each((s: any) => sections.push(s));
    for (const section of sections) {
      if (this.disposed) break;
      await section.load(this.epub.load.bind(this.epub));
      const root = section.document.body,
        text = root.textContent || "",
        lower = text.toLowerCase();
      let at = lower.indexOf(query.toLowerCase());
      while (at >= 0) {
        const range = rangeForOffsets(root, at, at + query.length);
        if (range)
          results.push({
            label: text.slice(Math.max(0, at - 50), at + query.length + 80),
            locator: {
              v: 1,
              type: "epub",
              hash: this.book.hash,
              cfi: section.cfiFromRange(range),
              href: section.href,
            },
          });
        at = lower.indexOf(query.toLowerCase(), at + query.length);
      }
    }
    return results;
  }
  async sections(): Promise<Section[]> {
    const nav = await this.epub.loaded.navigation;
    const map = (items: any[]): Section[] =>
      items.map((i) => ({
        id: i.href,
        label: i.label.trim(),
        children: map(i.subitems || []),
      }));
    return map(nav.toc);
  }
  configure(p: Preferences) {
    this.prefs = p;
    if (!this.rendition) return;
    const prior = this.appliedPrefs;
    if (prior && JSON.stringify(prior) === JSON.stringify(p)) return;
    this.appliedPrefs = { ...p };
    this.clearTurnCopies();
    this.turn.invalidate();
    if (!prior || prior.flow !== p.flow)
      this.rendition.flow(p.flow === "scrolled" ? "scrolled-doc" : "paginated");
    if (!prior || prior.spread !== p.spread)
      this.rendition.spread(p.spread ? "auto" : "none");
    const palette = pagePalettes[p.theme];
    this.rendition.themes.default({
      html: {
        "touch-action": p.flow === "paginated" ? "pan-y pinch-zoom" : "auto",
        background: `${palette.background} !important`,
        color: `${palette.text} !important`,
      },
      body: {
        "touch-action": p.flow === "paginated" ? "pan-y pinch-zoom" : "auto",
        "font-family": `${p.font}, ${p.font === "Literata" ? "Georgia,serif" : "sans-serif"} !important`,
        "font-size": `${p.fontSize}px !important`,
        "line-height": `${p.lineHeight} !important`,
        color: `${palette.text} !important`,
        background: `${palette.background} !important`,
        padding: "16px clamp(12px, 3vw, 32px) !important",
      },
      "body *:not(img):not(svg):not(path):not(image)": {
        color: "inherit !important",
        "background-color": "transparent !important",
      },
      p: { "line-height": `${p.lineHeight} !important` },
      a: { color: "#5689b9" },
      img: { "max-width": "100%" },
      "::selection": { background: "#a6c9e5" },
    });
    if (prior && prior.theme !== p.theme) this.draw();
  }
  annotate(marks: Annotation[]) {
    if (JSON.stringify(marks) === JSON.stringify(this.marks)) return;
    this.turn.invalidate();
    this.clearTurnCopies();
    this.marks = marks;
    this.draw();
  }
  private draw() {
    if (!this.rendition) return;
    for (const cfi of this.rendered) {
      try {
        this.rendition.annotations.remove(cfi, "highlight");
      } catch {}
    }
    this.rendered.clear();
    const groups = new Map<string, Annotation[]>();
    for (const mark of this.marks)
      if (mark.locator.type === "epub") {
        const group = groups.get(mark.locator.cfi) || [];
        group.push(mark);
        groups.set(mark.locator.cfi, group);
      }
    for (const [cfi, group] of groups) {
      const mark = group[0];
      try {
        this.rendition.annotations.highlight(
          cfi,
          { ids: group.map((a) => a.id) },
          () => this.events.onAnnotation(mark.id),
          "leafmark-highlight",
          {
            fill: colors[mark.color],
            "fill-opacity": "0.32",
            "mix-blend-mode": this.prefs?.theme === "dark" ? "screen" : "multiply",
          },
        );
        this.rendered.add(cfi);
      } catch {}
    }
  }
  clearSelection() {
    for (const touch of this.touchSelections.values()) touch.clear();
    for (const c of (this.rendition?.getContents() as unknown as Contents[]) ||
      [])
      c.document.getSelection()?.removeAllRanges();
  }
  private range(locator: Locator): Range | null {
    if (locator.type !== "epub" || locator.hash !== this.book.hash) return null;
    let spine: number;
    try {
      spine = new EpubCFI(locator.cfi).spinePos;
    } catch {
      return null;
    }
    for (const contents of (this.rendition?.getContents() as unknown as Contents[]) ||
      []) {
      if (contents.sectionIndex !== spine) continue;
      try {
        const range = contents.range(locator.cfi);
        if (range) return range;
      } catch {}
    }
    return null;
  }
  bounds(locator: Locator) {
    const range = this.range(locator);
    if (!range) return [];
    const frame = range.startContainer.ownerDocument?.defaultView
      ?.frameElement as HTMLElement | null;
    if (!frame) return [];
    const box = frame.getBoundingClientRect();
    const scaleX = box.width / (frame.clientWidth || box.width || 1),
      scaleY = box.height / (frame.clientHeight || box.height || 1);
    return rectsForRange(range).map((r) => ({
      left: box.left + r.left * scaleX,
      right: box.left + r.right * scaleX,
      top: box.top + r.top * scaleY,
      bottom: box.top + r.bottom * scaleY,
    }));
  }
  intersects(a: Locator, b: Locator) {
    if (a.hash !== b.hash) return false;
    const first = this.range(a),
      second = this.range(b);
    return !!first && !!second && rangeOverlap(first, second);
  }
  destroy() {
    this.resizeObserver?.disconnect();
    this.turn.destroy(); this.clearTurnCopies();
    this.disposed = true;
    this.previewReader?.destroy();
    this.previewHost?.remove();
    this.cleanups.forEach((fn) => fn());
    this.rendition?.destroy();
    this.epub?.destroy();
    this.host.replaceChildren();
    delete this.host.dataset.bookSpread;
  }
}
