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

export class EpubReader implements ReaderAdapter {
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
  constructor(
    private host: HTMLElement,
    private book: Book,
    private events: ReaderEvents,
  ) {}
  async open(source: Blob) {
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
      allowScriptedContent: false,
    });
    this.rendition.hooks.content.register((contents: Contents) =>
      this.bind(contents),
    );
    this.rendition.on("selected", (cfi: string, contents: Contents) =>
      this.selected(cfi, contents),
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
    });
    this.rendition.on("rendered", () => this.draw());
    if (this.prefs) this.configure(this.prefs);
    await this.rendition.display();
    // Pagination-independent text locations; do not block opening a large book.
    void this.epub.locations
      .generate(1200)
      .then(() => {
        this.positionsReady = true;
        if (!this.disposed) void this.rendition.reportLocation();
      })
      .catch(() => {});
  }
  private bind(contents: Contents) {
    const doc = contents.document;
    void contents.addStylesheetCss(
      `@font-face{font-family:Literata;src:url("${new URL(literataFont, location.href).href}")}@font-face{font-family:"Source Sans 3";src:url("${new URL(sansFont, location.href).href}")}`,
      "leafmark-fonts",
    );
    const selection = () => {
      const s = doc.getSelection();
      if (s && !s.isCollapsed && s.rangeCount) {
        const range = s.getRangeAt(0);
        this.selected(contents.cfiFromRange(range), contents);
      }
    };
    doc.addEventListener("selectionchange", selection);
    doc.addEventListener("pointerup", selection);
    const pointerDown = () => this.events.onReaderPointerDown?.();
    doc.addEventListener("pointerdown", pointerDown);
    const key = (event: KeyboardEvent) => {
      this.events.onShortcut?.(event);
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        /INPUT|TEXTAREA/.test(event.target.tagName)
      )
        return;
      if (!doc.getSelection()?.isCollapsed) return;
      if (event.key === "ArrowRight") void this.next();
      if (event.key === "ArrowLeft") void this.previous();
    };
    doc.addEventListener("keydown", key);
    this.cleanups.push(() => {
      doc.removeEventListener("selectionchange", selection);
      doc.removeEventListener("pointerup", selection);
      doc.removeEventListener("pointerdown", pointerDown);
      doc.removeEventListener("keydown", key);
    });
  }
  private selected(cfi: string, contents: Contents) {
    try {
      const range = contents.range(cfi);
      if (!range || !range.toString().trim()) return;
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
        text: range.toString(),
      });
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
    await this.rendition.next();
  }
  async previous() {
    if (this.hasSelection()) return;
    await this.rendition.prev();
  }
  private hasSelection() {
    return (
      (this.rendition?.getContents() as unknown as Contents[]) || []
    ).some((c) => !c.document.getSelection()?.isCollapsed);
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
    if (!prior || prior.flow !== p.flow)
      this.rendition.flow(p.flow === "scrolled" ? "scrolled-doc" : "paginated");
    if (!prior || prior.spread !== p.spread)
      this.rendition.spread(p.spread ? "auto" : "none");
    const palette =
      p.theme === "dark"
        ? ["#202830", "#e1e5e8"]
        : p.theme === "sepia"
          ? ["#f4ecd9", "#443b2c"]
          : ["#fff", "#29333e"];
    this.rendition.themes.default({
      body: {
        "font-family": `${p.font}, ${p.font === "Literata" ? "Georgia,serif" : "sans-serif"} !important`,
        "font-size": `${p.fontSize}px !important`,
        "line-height": `${p.lineHeight} !important`,
        color: `${palette[1]} !important`,
        background: `${palette[0]} !important`,
        padding: "20px 24px !important",
      },
      p: { "line-height": `${p.lineHeight} !important` },
      a: { color: "#5689b9" },
      img: { "max-width": "100%" },
      "::selection": { background: "#a6c9e5" },
    });
  }
  annotate(marks: Annotation[]) {
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
            "mix-blend-mode": "multiply",
          },
        );
        this.rendered.add(cfi);
      } catch {}
    }
  }
  clearSelection() {
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
    this.disposed = true;
    this.cleanups.forEach((fn) => fn());
    this.rendition?.destroy();
    this.epub?.destroy();
    this.host.replaceChildren();
  }
}
