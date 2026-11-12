import {
  findQuote,
  offsetsForRange,
  rangeForOffsets,
  textNodes,
} from "../anchors";
import { sanitize } from "../import";
import { rectsForRange } from "./geometry";
import {
  colors,
  type Annotation,
  type Book,
  type Locator,
  type Preferences,
} from "../model";
import type { ReaderAdapter, ReaderEvents, SearchHit, Section } from "./types";

export class DocxReader implements ReaderAdapter {
  private article = document.createElement("article");
  private marks: Annotation[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private observer?: ResizeObserver;
  constructor(
    private host: HTMLElement,
    private book: Book,
    private events: ReaderEvents,
  ) {}
  async open(_source: Blob, derived?: Blob) {
    if (!derived)
      throw new Error(
        "The converted document is missing. Download this book again.",
      );
    this.host.classList.add("docx-reader");
    this.article.className = "docx-content";
    this.article.innerHTML = sanitize(await derived.text());
    this.article.querySelectorAll("[src]").forEach((el) => {
      const src = el.getAttribute("src") || "";
      if (!src.startsWith("data:")) el.removeAttribute("src");
    });
    this.article.querySelectorAll("a").forEach((a) => {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    });
    this.host.append(this.article);
    document.addEventListener("selectionchange", this.selection);
    this.host.addEventListener("scroll", this.scroll, { passive: true });
    this.host.addEventListener("click", this.click);
    this.observer = new ResizeObserver(() => this.draw());
    this.observer.observe(this.article);
    this.scroll();
  }
  private selection = () => {
    const selection = document.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (
      !this.article.contains(range.startContainer) ||
      !this.article.contains(range.endContainer)
    )
      return;
    try {
      const { start, end, quote } = offsetsForRange(this.article, range);
      this.events.onSelection({
        text: range.toString(),
        locator: {
          v: 1,
          type: "docx",
          hash: this.book.hash,
          start,
          end,
          quote,
        },
      });
    } catch {}
  };
  private scroll = () => {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const nodes = textNodes(this.article);
      let offset = 0,
        start = 0;
      const top = this.host.getBoundingClientRect().top;
      for (const node of nodes) {
        const range = document.createRange();
        range.selectNodeContents(node);
        if (range.getBoundingClientRect().bottom > top + 8) {
          let low = 0,
            high = node.length;
          while (low < high) {
            const middle = Math.floor((low + high) / 2);
            range.setStart(node, middle);
            range.setEnd(node, Math.min(node.length, middle + 1));
            if (range.getBoundingClientRect().bottom <= top + 8)
              low = middle + 1;
            else high = middle;
          }
          start = offset + low;
          break;
        }
        offset += node.length;
      }
      this.events.onLocation(
        { v: 1, type: "docx", hash: this.book.hash, start, end: start },
        this.host.scrollTop /
          Math.max(1, this.host.scrollHeight - this.host.clientHeight),
      );
    }, 200);
  };
  async goTo(locator: Locator | string) {
    if (typeof locator === "string") {
      const heading = this.article.querySelector<HTMLElement>(
        `[data-heading="${Number(locator)}"]`,
      );
      heading?.scrollIntoView({ block: "start" });
      return;
    }
    if (locator.type !== "docx" || locator.hash !== this.book.hash)
      throw new Error("This passage belongs to a different document.");
    let { start, end } = locator;
    let range = rangeForOffsets(this.article, start, end);
    if (locator.quote && range?.toString() !== locator.quote.exact) {
      const found = findQuote(this.article.textContent || "", locator.quote);
      if (!found)
        throw new Error("The saved passage cannot be located unambiguously.");
      start = found.start;
      end = found.end;
      range = rangeForOffsets(this.article, start, end);
    }
    if (!range) throw new Error("The saved passage is unavailable.");
    const rect = range.getBoundingClientRect();
    this.host.scrollTop +=
      rect.top - this.host.getBoundingClientRect().top - 40;
  }
  async next() {
    this.host.scrollBy({
      top: this.host.clientHeight * 0.85,
      behavior: "smooth",
    });
  }
  async previous() {
    this.host.scrollBy({
      top: -this.host.clientHeight * 0.85,
      behavior: "smooth",
    });
  }
  async search(query: string): Promise<SearchHit[]> {
    const text = this.article.textContent || "",
      hits: SearchHit[] = [];
    if (!query.trim()) return hits;
    let at = text.toLowerCase().indexOf(query.toLowerCase());
    while (at >= 0) {
      hits.push({
        label: text.slice(Math.max(0, at - 40), at + query.length + 80),
        locator: {
          v: 1,
          type: "docx",
          hash: this.book.hash,
          start: at,
          end: at + query.length,
        },
      });
      at = text.toLowerCase().indexOf(query.toLowerCase(), at + query.length);
    }
    return hits;
  }
  async sections(): Promise<Section[]> {
    return Array.from(this.article.querySelectorAll("h1,h2,h3")).map((h, i) => {
      (h as HTMLElement).dataset.heading = String(i);
      return { id: String(i), label: h.textContent || "" };
    });
  }
  configure(p: Preferences) {
    Object.assign(this.article.style, {
      fontFamily: p.font,
      fontSize: `${p.fontSize}px`,
      lineHeight: String(p.lineHeight),
      maxWidth: `${p.width}px`,
    });
    this.host.dataset.theme = p.theme;
    this.draw();
  }
  annotate(marks: Annotation[]) {
    this.marks = marks;
    this.draw();
  }
  private draw() {
    this.host.querySelector(".docx-highlights")?.remove();
    const layer = document.createElement("div");
    layer.className = "docx-highlights";
    layer.dataset.leafmarkOverlay = "true";
    const hostRect = this.host.getBoundingClientRect();
    for (const mark of this.marks) {
      if (mark.locator.type !== "docx") continue;
      const range = rangeForOffsets(
        this.article,
        mark.locator.start,
        mark.locator.end,
      );
      if (!range) continue;
      for (const rect of Array.from(range.getClientRects())) {
        const span = document.createElement("span");
        span.dataset.annotation = mark.id;
        Object.assign(span.style, {
          left: `${rect.left - hostRect.left + this.host.scrollLeft}px`,
          top: `${rect.top - hostRect.top + this.host.scrollTop}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          background: colors[mark.color],
        });
        layer.append(span);
      }
    }
    this.host.append(layer);
  }
  private click = (e: MouseEvent) => {
    if (!document.getSelection()?.isCollapsed) return;
    const hit = Array.from(
      this.host.querySelectorAll<HTMLElement>("[data-annotation]"),
    ).find((el) => {
      const r = el.getBoundingClientRect();
      return (
        e.clientX >= r.left &&
        e.clientX <= r.right &&
        e.clientY >= r.top &&
        e.clientY <= r.bottom
      );
    });
    if (hit) this.events.onAnnotation(hit.dataset.annotation!);
  };
  bounds(locator: Locator) {
    if (locator.type !== "docx" || locator.hash !== this.book.hash) return [];
    const range = rangeForOffsets(this.article, locator.start, locator.end);
    return range ? rectsForRange(range) : [];
  }
  intersects(a: Locator, b: Locator) {
    return (
      a.type === "docx" &&
      b.type === "docx" &&
      a.hash === b.hash &&
      a.start < b.end &&
      b.start < a.end
    );
  }
  clearSelection() {
    document.getSelection()?.removeAllRanges();
  }
  destroy() {
    clearTimeout(this.timer);
    this.observer?.disconnect();
    document.removeEventListener("selectionchange", this.selection);
    this.host.removeEventListener("scroll", this.scroll);
    this.host.removeEventListener("click", this.click);
    this.host.replaceChildren();
    this.host.classList.remove("docx-reader");
  }
}
