import { pdfLibrary, pdfOptions, pdfOpenError } from "../pdf";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  PageViewport,
  RenderTask,
} from "pdfjs-dist";
import { normalizeRect } from "../anchors";
import {
  type Book,
  type Annotation,
  type Locator,
  type Preferences,
  type Rect,
  colors,
} from "../model";
import type { ReaderAdapter, ReaderEvents, SearchHit, Section } from "./types";

type PageState = {
  n: number;
  element: HTMLDivElement;
  viewport: PageViewport;
  page: PDFPageProxy;
  loaded: boolean;
  rendering: boolean;
  task?: RenderTask;
  generation: number;
};
function viewportRect(viewport: PageViewport, rect: Rect): Rect {
  const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[3]);
  return normalizeRect([x1, y1, x2, y2]);
}
export class PdfReader implements ReaderAdapter {
  private pdf!: PDFDocumentProxy;
  private loadingTask?: PDFDocumentLoadingTask;
  private lib!: Awaited<ReturnType<typeof pdfLibrary>>;
  private pages: PageState[] = [];
  private observer?: IntersectionObserver;
  private resizeObserver?: ResizeObserver;
  private hostWidth = 0;
  private marks: Annotation[] = [];
  private disposed = false;
  private zoom = 1;
  private rotation = 0;
  private current = 1;
  private region = false;
  private singlePage = false;
  private drag?: { page: PageState; x: number; y: number; box: HTMLDivElement };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private viewQueue: Promise<void> = Promise.resolve();
  constructor(
    private host: HTMLElement,
    private book: Book,
    private events: ReaderEvents,
  ) {}
  async open(source: Blob) {
    this.lib = await pdfLibrary();
    this.loadingTask = this.lib.getDocument(pdfOptions(await source.arrayBuffer()));
    this.pdf = await this.loadingTask.promise.catch((error: unknown) => {
      console.error("PDF reader loading failed", error);
      throw pdfOpenError(error);
    });
    if (this.disposed) {
      await this.loadingTask.destroy();
      return;
    }
    this.host.classList.add("pdf-reader");
    for (let n = 1; n <= this.pdf.numPages; n++) {
      const page = await this.pdf.getPage(n);
      if (this.disposed) return;
      const element = document.createElement("div");
      element.className = "pdf-page";
      element.dataset.page = String(n);
      element.setAttribute("aria-label", `Page ${n}`);
      const state: PageState = {
        n,
        element,
        page,
        viewport: page.getViewport({ scale: 1 }),
        loaded: false,
        rendering: false,
        generation: 0,
      };
      this.pages.push(state);
      this.size(state);
      this.host.append(element);
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const state =
              this.pages[
                Number((entry.target as HTMLElement).dataset.page) - 1
              ];
            void this.render(state).catch((e) =>
              this.events.onError(String(e.message)),
            );
          }
        }
      },
      { root: this.host, rootMargin: "1200px" },
    );
    this.pages.forEach((p) => this.observer!.observe(p.element));
    this.host.addEventListener("scroll", this.onScroll, { passive: true });
    document.addEventListener("selectionchange", this.selection);
    this.host.addEventListener("pointerdown", this.pointerDown);
    this.host.addEventListener("pointermove", this.pointerMove);
    this.host.addEventListener("pointerup", this.pointerUp);
    this.host.addEventListener("pointercancel", this.pointerCancel);
    this.host.addEventListener("click", this.click);
    await this.render(this.pages[0]);
    this.onScroll();
    this.hostWidth = this.host.clientWidth;
    this.resizeObserver = new ResizeObserver(() => {
      if (Math.abs(this.host.clientWidth - this.hostWidth) > 5) {
        this.hostWidth = this.host.clientWidth;
        void this.setView(this.zoom, this.rotation).catch((e) =>
          this.events.onError(e.message),
        );
      }
    });
    this.resizeObserver.observe(this.host);
  }
  private size(state: PageState) {
    const base = state.page.getViewport({ scale: 1, rotation: this.rotation });
    const available = Math.max(200, this.host.clientWidth - 32);
    const scale = Math.min(available / base.width, 1.6) * this.zoom;
    state.viewport = state.page.getViewport({ scale, rotation: this.rotation });
    state.element.style.width = `${state.viewport.width}px`;
    state.element.style.height = `${state.viewport.height}px`;
    state.element.style.setProperty("--scale-factor", String(scale));
    state.element.style.setProperty(
      "--user-unit",
      String(state.page.userUnit || 1),
    );
    state.element.style.setProperty(
      "--total-scale-factor",
      String(scale * (state.page.userUnit || 1)),
    );
    state.element.style.setProperty("--scale-round-x", "1px");
    state.element.style.setProperty("--scale-round-y", "1px");
  }
  private async render(state: PageState) {
    if (state.loaded || state.rendering || this.disposed) return;
    state.rendering = true;
    const generation = state.generation;
    try {
      const canvas = document.createElement("canvas"),
        ratio = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.floor(state.viewport.width * ratio);
      canvas.height = Math.floor(state.viewport.height * ratio);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.setAttribute("aria-hidden", "true");
      state.element.append(canvas);
      state.task = state.page.render({
        canvas,
        viewport: state.viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      await state.task.promise;
      if (this.disposed || generation !== state.generation) return;
      const layer = document.createElement("div");
      layer.className = "textLayer";
      state.element.append(layer);
      const text = await state.page.getTextContent();
      if (this.disposed || generation !== state.generation) return;
      await new this.lib.TextLayer({
        textContentSource: text,
        container: layer,
        viewport: state.viewport,
      }).render();
      state.loaded = true;
      this.drawPage(state);
    } catch (error: any) {
      if (error?.name !== "RenderingCancelledException") throw error;
    } finally {
      state.rendering = false;
    }
  }
  private selection = () => {
    if (this.region) return;
    const selection = document.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (
      !this.host.contains(range.startContainer) ||
      !this.host.contains(range.endContainer)
    )
      return;
    const regions: { page: number; rects: Rect[] }[] = [];
    for (const state of this.pages) {
      if (!state.loaded || !range.intersectsNode(state.element)) continue;
      const bounds = state.element.getBoundingClientRect(),
        rects: Rect[] = [];
      for (const rect of Array.from(range.getClientRects())) {
        const left = Math.max(rect.left, bounds.left),
          right = Math.min(rect.right, bounds.right),
          top = Math.max(rect.top, bounds.top),
          bottom = Math.min(rect.bottom, bounds.bottom);
        if (
          right - left < 0.5 ||
          bottom - top < 0.5 ||
          rect.height > state.viewport.height / 3
        )
          continue;
        const a = state.viewport.convertToPdfPoint(
            left - bounds.left,
            top - bounds.top,
          ),
          b = state.viewport.convertToPdfPoint(
            right - bounds.left,
            bottom - bounds.top,
          );
        const normalized = normalizeRect([a[0], a[1], b[0], b[1]]);
        if (
          !rects.some((r) =>
            r.every((v, i) => Math.abs(v - normalized[i]) < 0.1),
          )
        )
          rects.push(normalized);
      }
      if (rects.length) regions.push({ page: state.n, rects });
    }
    if (!regions.length) return;
    this.events.onSelection({
      text: selection.toString(),
      locator: {
        v: 1,
        type: "pdf",
        hash: this.book.hash,
        page: regions[0].page,
        y: 0,
        regions,
        quote: { exact: selection.toString(), prefix: "", suffix: "" },
      },
    });
  };
  private onScroll = () => {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.disposed) return;
      const top = this.host.getBoundingClientRect().top;
      const state =
        this.pages.find(
          (p) =>
            !p.element.hidden &&
            p.element.getBoundingClientRect().bottom > top + 30,
        ) || this.pages[this.pages.length - 1];
      if (!state) return;
      this.current = state.n;
      const y = Math.max(
        0,
        Math.min(
          1,
          (top - state.element.getBoundingClientRect().top) /
            state.viewport.height,
        ),
      );
      const point = state.viewport.convertToPdfPoint(
        0,
        y * state.viewport.height,
      ) as [number, number];
      this.events.onLocation(
        { v: 1, type: "pdf", hash: this.book.hash, page: state.n, y, point },
        (state.n - 1 + y) / this.pages.length,
      );
      // Release distant canvases unless a native selection could depend on them.
      if (document.getSelection()?.isCollapsed)
        for (const p of this.pages)
          if (p.loaded && Math.abs(p.n - state.n) > 5) {
            p.element.replaceChildren();
            p.loaded = false;
          }
    }, 200);
  };
  private drawPage(state: PageState) {
    state.element.querySelector(".pdf-highlights")?.remove();
    const layer = document.createElement("div");
    layer.className = "pdf-highlights";
    layer.dataset.leafmarkOverlay = "true";
    for (const mark of this.marks)
      if (mark.locator.type === "pdf")
        for (const region of mark.locator.regions || [])
          if (region.page === state.n)
            for (const rect of region.rects) {
              const [x1, y1, x2, y2] = viewportRect(state.viewport, rect);
              const el = document.createElement("span");
              el.className = "pdf-highlight";
              el.dataset.annotation = mark.id;
              Object.assign(el.style, {
                left: `${x1}px`,
                top: `${y1}px`,
                width: `${x2 - x1}px`,
                height: `${y2 - y1}px`,
                background: colors[mark.color],
              });
              layer.append(el);
            }
    state.element.append(layer);
  }
  private click = (event: MouseEvent) => {
    if (this.region || !document.getSelection()?.isCollapsed) return;
    const hit = Array.from(
      this.host.querySelectorAll<HTMLElement>("[data-annotation]"),
    ).find((el) => {
      const r = el.getBoundingClientRect();
      return (
        event.clientX >= r.left &&
        event.clientX <= r.right &&
        event.clientY >= r.top &&
        event.clientY <= r.bottom
      );
    });
    if (hit) this.events.onAnnotation(hit.dataset.annotation!);
  };
  setRegionMode(enabled: boolean) {
    this.region = enabled;
    this.host.classList.toggle("region-mode", enabled);
    this.clearSelection();
  }
  async setPageLayout(single: boolean) {
    this.singlePage = single;
    await this.goTo(String(this.current));
  }
  private pointerDown = (e: PointerEvent) => {
    if (!this.region) return;
    const element = (e.target as HTMLElement).closest<HTMLElement>(".pdf-page");
    if (!element) return;
    const page = this.pages[Number(element.dataset.page) - 1],
      bounds = element.getBoundingClientRect(),
      box = document.createElement("div");
    box.className = "region-box";
    element.append(box);
    this.drag = {
      page,
      x: e.clientX - bounds.left,
      y: e.clientY - bounds.top,
      box,
    };
    this.host.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  private pointerMove = (e: PointerEvent) => {
    if (!this.drag) return;
    const { page, x, y, box } = this.drag,
      r = page.element.getBoundingClientRect();
    const endX = Math.min(r.width, Math.max(0, e.clientX - r.left)),
      endY = Math.min(r.height, Math.max(0, e.clientY - r.top));
    Object.assign(box.style, {
      left: `${Math.min(x, endX)}px`,
      top: `${Math.min(y, endY)}px`,
      width: `${Math.abs(endX - x)}px`,
      height: `${Math.abs(endY - y)}px`,
    });
  };
  private pointerUp = () => {
    if (!this.drag) return;
    const { page, box } = this.drag,
      r = box.getBoundingClientRect(),
      p = page.element.getBoundingClientRect();
    if (r.width > 5 && r.height > 5) {
      const a = page.viewport.convertToPdfPoint(r.left - p.left, r.top - p.top),
        b = page.viewport.convertToPdfPoint(r.right - p.left, r.bottom - p.top);
      this.events.onSelection({
        text: `Region on page ${page.n}`,
        locator: {
          v: 1,
          type: "pdf",
          hash: this.book.hash,
          page: page.n,
          y: 0,
          regions: [
            { page: page.n, rects: [normalizeRect([a[0], a[1], b[0], b[1]])] },
          ],
        },
      });
    }
    box.remove();
    this.drag = undefined;
  };
  private pointerCancel = () => {
    this.drag?.box.remove();
    this.drag = undefined;
  };
  setView(zoom: number, rotation: number) {
    this.viewQueue = this.viewQueue
      .catch(() => {})
      .then(() => this.relayout(zoom, rotation));
    return this.viewQueue;
  }
  private async relayout(zoom: number, rotation: number) {
    if (this.disposed) return;
    this.zoom = zoom;
    this.rotation = rotation;
    for (const p of this.pages) {
      p.generation++;
      p.task?.cancel();
      p.loaded = false;
      p.element.replaceChildren();
      this.size(p);
    }
    await this.goTo(String(this.current));
    for (const p of this.pages.filter(
      (p) => Math.abs(p.n - this.current) < 2,
    )) {
      while (p.rendering) await new Promise((r) => setTimeout(r, 10));
      await this.render(p);
    }
  }
  async goTo(locator: Locator | string) {
    let page: number,
      y = 0;
    if (typeof locator === "string") page = Number(locator);
    else {
      if (locator.type !== "pdf" || locator.hash !== this.book.hash)
        throw new Error("This passage belongs to a different document.");
      page = locator.page;
      y = locator.y;
      if (locator.point) {
        const state = this.pages[page - 1];
        if (state)
          y =
            state.viewport.convertToViewportPoint(...locator.point)[1] /
            state.viewport.height;
      }
      if (locator.regions?.length) {
        const state = this.pages[page - 1],
          rect = locator.regions.find((r) => r.page === page)?.rects[0];
        if (rect)
          y = Math.max(
            0,
            viewportRect(state.viewport, rect)[1] /
              state.viewport.height -
              0.1,
          );
      }
    }
    const state =
      this.pages[Math.max(0, Math.min(this.pages.length - 1, page - 1))];
    if (!state) return;
    for (const p of this.pages)
      p.element.hidden = this.singlePage && p !== state;
    this.host.scrollTop =
      state.element.offsetTop - this.host.offsetTop + y * state.viewport.height;
    await this.render(state);
    this.current = state.n;
    this.onScroll();
  }
  async next() {
    if (document.getSelection()?.isCollapsed)
      await this.goTo(String(Math.min(this.pages.length, this.current + 1)));
  }
  async previous() {
    if (document.getSelection()?.isCollapsed)
      await this.goTo(String(Math.max(1, this.current - 1)));
  }
  async search(query: string): Promise<SearchHit[]> {
    const hits: SearchHit[] = [];
    if (!query.trim()) return hits;
    for (const state of this.pages) {
      if (this.disposed) break;
      const content = await state.page.getTextContent();
      const text = content.items.map((i: any) => i.str || "").join(" "),
        lower = text.toLowerCase();
      let at = lower.indexOf(query.toLowerCase());
      while (at >= 0) {
        hits.push({
          label: `Page ${state.n} · ${text.slice(Math.max(0, at - 45), at + query.length + 65)}`,
          locator: {
            v: 1,
            type: "pdf",
            hash: this.book.hash,
            page: state.n,
            y: 0,
          },
        });
        at = lower.indexOf(query.toLowerCase(), at + query.length);
      }
    }
    return hits;
  }
  async sections(): Promise<Section[]> {
    const outline = await this.pdf.getOutline();
    if (!outline)
      return this.pages.map((p) => ({ id: String(p.n), label: `Page ${p.n}` }));
    const walk = async (items: any[]): Promise<Section[]> =>
      Promise.all(
        items.map(async (item) => {
          let dest = item.dest;
          if (typeof dest === "string")
            dest = await this.pdf.getDestination(dest);
          const n = dest?.[0]
            ? (typeof dest[0] === "number"
                ? dest[0]
                : await this.pdf.getPageIndex(dest[0])) + 1
            : 1;
          return {
            id: String(n),
            label: item.title,
            children: await walk(item.items || []),
          };
        }),
      );
    return walk(outline);
  }
  configure(p: Preferences) {
    this.host.dataset.theme = p.theme;
  }
  annotate(marks: Annotation[]) {
    this.marks = marks;
    this.pages.filter((p) => p.loaded).forEach((p) => this.drawPage(p));
  }
  clearSelection() {
    document.getSelection()?.removeAllRanges();
  }
  destroy() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.observer?.disconnect();
    this.resizeObserver?.disconnect();
    document.removeEventListener("selectionchange", this.selection);
    this.host.removeEventListener("scroll", this.onScroll);
    this.host.removeEventListener("pointerdown", this.pointerDown);
    this.host.removeEventListener("pointermove", this.pointerMove);
    this.host.removeEventListener("pointerup", this.pointerUp);
    this.host.removeEventListener("pointercancel", this.pointerCancel);
    this.host.removeEventListener("click", this.click);
    void this.loadingTask?.destroy();
    this.host.replaceChildren();
    this.host.classList.remove("pdf-reader", "region-mode");
  }
}
