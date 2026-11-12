import { PageTurn } from "./pageTurn";
import { db } from "../db";
import { PageOcr } from "./ocr";
import { bindPdfTouch } from "./pdfTouch";
import { pdfLibrary, pdfOptions, pdfOpenError } from "../pdf";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  PageViewport,
  RenderTask,
} from "pdfjs-dist";
import { normalizeRect } from "../anchors";
import { overlap } from "./geometry";
import {
  type Book,
  type Annotation,
  type Locator,
  type Preferences,
  type Rect,
  type PdfLayout,
  defaultPdfLayout,
  colors,
} from "../model";
import type { ReaderAdapter, ReaderEvents, SearchHit, Section } from "./types";

type OcrWord = { text: string; rect: Rect };
type PageState = {
  ocrButton: HTMLButtonElement;
  ocrWords?: OcrWord[];
  ocrChecked?: boolean;
  hasText?: boolean;
  recognizing?: Promise<void>;
  n: number;
  element: HTMLDivElement;
  frame: HTMLDivElement;
  noteButton: HTMLButtonElement;
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
  private turn: PageTurn;
  private ocr = new PageOcr();
  private touch?: ReturnType<typeof bindPdfTouch>;
  private loadingTask?: PDFDocumentLoadingTask;
  private lib!: Awaited<ReturnType<typeof pdfLibrary>>;
  private pages: PageState[] = [];
  private observer?: IntersectionObserver;
  private resizeObserver?: ResizeObserver;
  private hostWidth = 0;
  private hostHeight = 0;
  private autoOcrTimer?: ReturnType<typeof setTimeout>;
  private autoOcrBusy = false;
  private autoOcrBlocked = false;
  private autoOcrAttempted = new Set<number>();
  private marks: Annotation[] = [];
  private disposed = false;
  private zoom = 1;
  private rotation = 0;
  private current = 1;
  private region = false;
  private layout: PdfLayout = { ...defaultPdfLayout };
  private columns = 1;
  private layingOut = false;
  private drag?: { page: PageState; x: number; y: number; box: HTMLDivElement };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private viewQueue: Promise<void> = Promise.resolve();
  constructor(
    private host: HTMLElement,
    private book: Book,
    private events: ReaderEvents,
  ) {
    this.turn = new PageTurn(host);
  }
  async open(source: Blob) {
    this.lib = await pdfLibrary();
    this.loadingTask = this.lib.getDocument(
      pdfOptions(await source.arrayBuffer()),
    );
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
      const frame = document.createElement("div");
      frame.className = "pdf-page-frame";
      const noteButton = document.createElement("button");
      noteButton.className = "page-note-indicator";
      noteButton.textContent = `Page ${n} · Add note`;
      noteButton.setAttribute("aria-label", `Notes for page ${n}`);
      noteButton.addEventListener("click", () => {
        this.current = n;
        this.onScroll();
        this.events.onPageNote?.(n);
      });
      const ocrButton = document.createElement("button");
      ocrButton.className = "pdf-ocr-button";
      ocrButton.textContent = "Text recognition starts automatically";
      ocrButton.setAttribute("aria-label", `Recognize text on page ${n}`);
      ocrButton.hidden = true;
      ocrButton.addEventListener(
        "click",
        () => void this.recognizePage(this.pages[n - 1]).catch(() => {}),
      );
      element.append(ocrButton);
      frame.append(noteButton, element);
      const state: PageState = {
        n,
        element,
        frame,
        noteButton,
        ocrButton,
        page,
        viewport: page.getViewport({ scale: 1 }),
        loaded: false,
        rendering: false,
        generation: 0,
      };
      this.pages.push(state);
      this.size(state);
    }
    this.arrange();
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
    this.touch = bindPdfTouch(this.host, async (element) => {
      const state = this.pages[Number(element.dataset.page) - 1];
      if (state?.hasText === false) await this.recognizePage(state);
    });
    this.host.addEventListener("scroll", this.onScroll, { passive: true });
    document.addEventListener("visibilitychange", this.scheduleRecognition);
    document.addEventListener("selectionchange", this.selection);
    this.host.addEventListener("pointerdown", this.pointerDown);
    this.host.addEventListener("pointermove", this.pointerMove);
    this.host.addEventListener("pointerup", this.pointerUp);
    this.host.addEventListener("pointercancel", this.pointerCancel);
    this.host.addEventListener("click", this.click);
    this.host.addEventListener("keydown", this.keyDown);
    document.addEventListener("keydown", this.escapeRegion);
    await this.render(this.pages[0]);
    this.onScroll();
    this.hostWidth = this.host.clientWidth;
    this.hostHeight = this.host.clientHeight;
    this.resizeObserver = new ResizeObserver(() => {
      if (
        Math.abs(this.host.clientWidth - this.hostWidth) > 5 ||
        (this.layout.fit === "page" &&
          Math.abs(this.host.clientHeight - this.hostHeight) > 5)
      ) {
        this.hostWidth = this.host.clientWidth;
        this.hostHeight = this.host.clientHeight;
        void this.setView(this.zoom, this.rotation).catch((e) =>
          this.events.onError(e.message),
        );
      }
    });
    this.resizeObserver.observe(this.host);
  }
  private size(state: PageState) {
    const phone = window.matchMedia("(max-width: 700px)").matches;
    const base = state.page.getViewport({ scale: 1, rotation: this.rotation });
    const available = Math.max(
      160,
      (this.host.clientWidth - (phone ? 8 : 32) - (this.columns - 1) * 20) / this.columns,
    );
    const widthScale = Math.min(available / base.width, 1.6);
    const scale =
      (this.layout.fit === "page"
        ? Math.min(
            widthScale,
            Math.max(160, this.host.clientHeight - (phone ? 8 : 80)) / base.height,
          )
        : widthScale) * this.zoom;
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
    while (state.rendering && !this.disposed)
      await new Promise((resolve) => setTimeout(resolve, 10));
    if (state.loaded || this.disposed) return;
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
      state.hasText = text.items.some(
        (item) => "str" in item && item.str.trim(),
      );
      if (!state.hasText) {
        await this.loadOcrCache(state);
        if (this.disposed || generation !== state.generation) return;
        this.renderOcr(state);
      }
      state.loaded = true;
      this.drawPage(state);
      this.scheduleRecognition();
    } catch (error: any) {
      if (error?.name !== "RenderingCancelledException") throw error;
    } finally {
      state.rendering = false;
    }
  }
  private ocrKey(state: PageState) {
    return `ocr-v2:${this.book.id}:${this.book.hash}:${state.n}`;
  }
  private async loadOcrCache(state: PageState) {
    if (state.ocrChecked || state.ocrWords !== undefined) return;
    const cached = await db.meta.get(this.ocrKey(state)) ||
      await db.meta.get(`ocr-v1:${this.book.id}:${state.n}`);
    if (cached) {
      try {
        const words = JSON.parse(cached.value);
        if (Array.isArray(words) && words.every(w => typeof w.text === "string" &&
            Array.isArray(w.rect) && w.rect.length === 4 && w.rect.every(Number.isFinite)))
          state.ocrWords = words;
      } catch { /* Ignore incomplete old cache entries and recognize again. */ }
    }
    state.ocrChecked = true;
  }
  // Prioritize the visible page, then prepare the rest quietly, one at a time.
  // Completed (including blank) pages survive reopen; hidden tabs stop working.
  private scheduleRecognition = () => {
    clearTimeout(this.autoOcrTimer);
    if (this.disposed || this.autoOcrBusy || this.autoOcrBlocked) return;
    this.autoOcrTimer = setTimeout(() => {
      if (this.disposed || document.hidden || this.layingOut) return;
      if (this.pages.some(p => p.recognizing)) return;
      const viewport = this.host.getBoundingClientRect();
      const pending = this.pages.filter(p => !p.hasText &&
        p.ocrWords === undefined && !this.autoOcrAttempted.has(p.n));
      const visible = pending.filter(p => {
        if (!p.loaded || p.element.hidden) return false;
        const box = p.element.getBoundingClientRect();
        return box.width > 0 && box.bottom > viewport.top && box.top < viewport.bottom;
      });
      const state = visible.sort((a, b) => Math.abs(a.n - this.current) - Math.abs(b.n - this.current))[0] || pending[0];
      if (!state) return;
      this.autoOcrAttempted.add(state.n);
      this.autoOcrBusy = true;
      void this.recognizePage(state, true).catch(() => {
        // A missing worker/model must not trigger one failed download per page.
        this.autoOcrBlocked = true;
      }).finally(() => {
        this.autoOcrBusy = false;
        this.scheduleRecognition();
      });
    }, 350);
  };
  private renderOcr(state: PageState) {
    const layer = state.element.querySelector<HTMLElement>(".textLayer");
    if (!layer || state.hasText) return;
    const words = state.ocrWords;
    state.ocrButton.hidden = words !== undefined;
    if (!state.ocrButton.isConnected) state.element.append(state.ocrButton);
    if (!words?.length) return;
    layer.classList.add("ocr-text-layer");
    layer.replaceChildren();
    const measure = document.createElement("canvas").getContext("2d")!;
    for (const word of words) {
      const [left, top, right, bottom] = viewportRect(
        state.viewport,
        word.rect,
      );
      const rotation = ((this.rotation % 360) + 360) % 360;
      const vertical = rotation === 90 || rotation === 270;
      const span = document.createElement("span"),
        height = vertical ? right - left : bottom - top;
      const length = vertical ? bottom - top : right - left;
      const originX = rotation === 90 || rotation === 180 ? right : left;
      const originY = rotation === 180 || rotation === 270 ? bottom : top;
      const fontSize = Math.max(1, height);
      span.textContent = word.text + " ";
      measure.font = `${fontSize}px sans-serif`;
      const width = measure.measureText(word.text).width || 1;
      Object.assign(span.style, {
        left: `${originX}px`,
        top: `${originY}px`,
        fontSize: `${fontSize}px`,
        fontFamily: "sans-serif",
        height: `${height}px`,
        transform: `rotate(${rotation}deg) scaleX(${length / width})`,
      });
      layer.append(span);
    }
  }
  private recognizePage(state: PageState, automatic = false): Promise<void> {
    if (state.hasText || state.ocrWords !== undefined) return Promise.resolve();
    if (state.recognizing) return state.recognizing;
    state.recognizing = (async () => {
      state.ocrButton.hidden = false;
      state.ocrButton.disabled = true;
      state.ocrButton.classList.remove("ocr-failed");
      state.ocrButton.classList.add("recognizing");
      state.ocrButton.textContent = "Preparing text recognition...";
      const canvas = document.createElement("canvas");
      try {
        await this.loadOcrCache(state);
        if (state.hasText === undefined) {
          const text = await state.page.getTextContent();
          state.hasText = text.items.some(item => "str" in item && item.str.trim());
        }
        if (state.hasText || state.ocrWords !== undefined) {
          state.ocrButton.hidden = true;
          this.renderOcr(state);
          return;
        }
        if (this.disposed) return;
        const base = state.page.getViewport({ scale: 1, rotation: 0 });
        const viewport = state.page.getViewport({
          scale: Math.min(2.5, 1800 / base.width, 2400 / base.height),
          rotation: 0,
        });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await state.page.render({ canvas, viewport }).promise;
        if (this.disposed) return;
        const recognized = await this.ocr.recognize(canvas, (percent) => {
          state.ocrButton.textContent = `Recognizing text: ${percent}%`;
        });
        if (this.disposed) return;
        const words = recognized.map(({ text, box }) => {
          const a = viewport.convertToPdfPoint(box.x0, box.y0),
            b = viewport.convertToPdfPoint(box.x1, box.y1);
          return { text, rect: normalizeRect([a[0], a[1], b[0], b[1]]) };
        });
        await db.meta.put({
          key: this.ocrKey(state),
          value: JSON.stringify(words),
        });
        state.ocrWords = words;
        this.autoOcrBlocked = false;
        if (!this.disposed) this.renderOcr(state);
      } catch (error) {
        if (!this.disposed) {
          state.ocrButton.classList.add("ocr-failed");
          state.ocrButton.textContent = "Retry text recognition";
          const message = error instanceof Error ? error.message : String(error);
          state.ocrButton.title = message;
          // A blank page or failed background recognition must not interrupt reading.
          if (!automatic) this.events.onError(`Text recognition: ${message}`);
        }
        throw error;
      } finally {
        canvas.width = canvas.height = 0;
        state.ocrButton.disabled = false;
        state.ocrButton.classList.remove("recognizing");
        state.recognizing = undefined;
        this.scheduleRecognition();
      }
    })();
    return state.recognizing;
  }
  private selectionFrame?: number;
  private selection = () => {
    if (this.selectionFrame !== undefined) return;
    this.selectionFrame = requestAnimationFrame(() => {
      this.selectionFrame = undefined;
      this.readSelection();
    });
  };
  private readSelection = () => {
    if (this.region) return;
    const selection = document.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (
      !this.host.contains(range.startContainer) ||
      !this.host.contains(range.endContainer)
    )
      return;
    const rangeRects = Array.from(range.getClientRects());
    const regions: { page: number; rects: Rect[] }[] = [];
    for (const state of this.pages) {
      if (!state.loaded || !range.intersectsNode(state.element)) continue;
      const bounds = state.element.getBoundingClientRect(),
        rects: Rect[] = [];
      for (const rect of rangeRects) {
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
    if (this.layingOut) return;
    this.scheduleRecognition();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.disposed) return;
      const top = this.host.getBoundingClientRect().top;
      let state =
        this.pages.find(
          (p) =>
            !p.element.hidden &&
            p.element.getBoundingClientRect().bottom > top + 30,
        ) || this.pages[this.pages.length - 1];
      if (!state) return;
      const selected = this.pages[this.current - 1];
      if (
        this.columns === 2 &&
        selected &&
        !selected.element.hidden &&
        selected.frame.parentElement === state.frame.parentElement
      )
        state = selected;
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
    const hasNote = this.marks.some(
      (a) =>
        a.type === "page-note" &&
        a.locator.type === "pdf" &&
        a.locator.page === state.n,
    );
    state.noteButton.textContent = `Page ${state.n} · ${hasNote ? "Open note" : "Add note"}`;
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
    const page = (event.target as HTMLElement).closest<HTMLElement>(
      ".pdf-page",
    );
    if (page) {
      this.current = Number(page.dataset.page);
      this.onScroll();
    }
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
    if (!enabled) this.pointerCancel();
    this.events.onRegionMode?.(enabled);
  }
  private escapeRegion = (event: KeyboardEvent) => {
    if (event.key === "Escape" && this.region) this.setRegionMode(false);
  };
  private keyDown = (event: KeyboardEvent) => {
    if (
      (event.target as HTMLElement).closest(
        "input, textarea, [contenteditable=true], button",
      )
    )
      return;
    if (
      ["ArrowRight", "PageDown", "ArrowLeft", "PageUp"].includes(event.key) &&
      this.layout.navigation === "paginated"
    ) {
      event.preventDefault();
      void (["ArrowRight", "PageDown"].includes(event.key)
        ? this.next()
        : this.previous());
    }
  };
  private arrange() {
    this.columns =
      this.layout.columns === 2 && this.host.clientWidth >= 800 ? 2 : 1;
    this.events.onLayoutFallback?.(
      this.layout.columns === 2 && this.columns === 1,
    );
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < this.pages.length; i += this.columns) {
      const row = document.createElement("div");
      row.className = "pdf-spread";
      for (const p of this.pages.slice(i, i + this.columns)) {
        this.size(p);
        row.append(p.frame);
      }
      fragment.append(row);
    }
    this.host.replaceChildren(fragment);
    this.host.dataset.columns = String(this.columns);
    this.host.dataset.navigation = this.layout.navigation;
  }
  private location(): Locator {
    const top = this.host.getBoundingClientRect().top;
    let state =
      this.pages.find(
        (p) =>
          !p.element.hidden &&
          p.element.getBoundingClientRect().bottom > top + 30,
      ) || this.pages[0];
    const selected = this.pages[this.current - 1];
    if (selected?.frame.parentElement === state.frame.parentElement)
      state = selected;
    const y = Math.max(
      0,
      Math.min(
        1,
        (top - state.element.getBoundingClientRect().top) /
          state.viewport.height,
      ),
    );
    return {
      v: 1,
      type: "pdf",
      hash: this.book.hash,
      page: state.n,
      y,
      point: state.viewport.convertToPdfPoint(0, y * state.viewport.height) as [
        number,
        number,
      ],
    };
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
    this.pointerId = e.pointerId;
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
    this.releasePointer();
    this.region = false;
    this.host.classList.remove("region-mode");
    this.events.onRegionMode?.(false);
  };
  private pointerId?: number;
  private releasePointer() {
    if (
      this.pointerId !== undefined &&
      this.host.hasPointerCapture(this.pointerId)
    )
      this.host.releasePointerCapture(this.pointerId);
    this.pointerId = undefined;
  }
  private pointerCancel = () => {
    this.drag?.box.remove();
    this.drag = undefined;
    this.releasePointer();
    this.region = false;
    this.host.classList.remove("region-mode");
    this.events.onRegionMode?.(false);
  };
  setView(zoom: number, rotation: number) {
    this.viewQueue = this.viewQueue
      .catch(() => {})
      .then(() => this.relayout(zoom, rotation));
    return this.viewQueue;
  }
  private async relayout(zoom: number, rotation: number) {
    if (this.disposed || !this.pages.length) return;
    const anchor = this.location();
    this.layingOut = true;
    try {
      this.zoom = zoom;
      this.rotation = rotation;
      for (const p of this.pages) {
        p.generation++;
        p.task?.cancel();
        while (p.rendering && !this.disposed)
          await new Promise((r) => setTimeout(r, 5));
        p.loaded = false;
        p.element.replaceChildren();
      }
      if (this.disposed) return;
      this.arrange();
      await this.goTo(anchor);
    } finally {
      this.layingOut = false;
    }
    if (this.disposed) return;
    this.onScroll();
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
            viewportRect(state.viewport, rect)[1] / state.viewport.height - 0.1,
          );
      }
    }
    const state =
      this.pages[Math.max(0, Math.min(this.pages.length - 1, page - 1))];
    if (!state) return;
    // Keep the old page visible until the next canvas/text layer is ready.
    await this.render(state);
    if (this.disposed) return;
    const row = state.frame.parentElement;
    for (const p of this.pages) {
      const hidden =
        this.layout.navigation === "paginated" && p.frame.parentElement !== row;
      p.element.hidden = hidden;
      p.frame.parentElement!.hidden = hidden;
    }
    this.host.scrollTop +=
      state.element.getBoundingClientRect().top -
      this.host.getBoundingClientRect().top +
      y * state.viewport.height -
      (typeof locator === "string" ||
      (!locator.point && !locator.regions?.length)
        ? 28
        : 0);
    this.current = state.n;
    this.onScroll();
  }
  async next() {
    await this.turnPage("next");
  }
  async previous() {
    await this.turnPage("previous");
  }
  private async turnPage(direction: "next" | "previous") {
    if (!document.getSelection()?.isCollapsed || this.region) return;
    await this.turn.run(direction, async () => {
      await this.viewQueue;
      if (this.disposed) return false;
      const row = Math.floor((this.current - 1) / this.columns) * this.columns;
      const target = Math.max(1, Math.min(this.pages.length,
        row + (direction === "next" ? this.columns : -this.columns) + 1));
      if (target === this.current) return false;
      await this.goTo(String(target));
    });
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
    const next = p.pdfLayout || defaultPdfLayout;
    if (JSON.stringify(next) !== JSON.stringify(this.layout)) {
      const resize =
        next.fit !== this.layout.fit || next.columns !== this.layout.columns;
      const anchor = this.pages.length ? this.location() : undefined;
      this.layout = { ...next };
      if (anchor) {
        if (resize)
          void this.setView(this.zoom, this.rotation).catch((e) =>
            this.events.onError(e.message),
          );
        else {
          this.host.dataset.navigation = next.navigation;
          void this.goTo(anchor).catch((e) => this.events.onError(e.message));
        }
      }
    }
  }
  annotate(marks: Annotation[]) {
    this.marks = marks;
    this.pages.forEach((p) => {
      if (p.loaded) this.drawPage(p);
      else
        p.noteButton.textContent = `Page ${p.n} · ${marks.some((a) => a.type === "page-note" && a.locator.type === "pdf" && a.locator.page === p.n) ? "Open note" : "Add note"}`;
    });
  }
  clearSelection() {
    this.touch?.clear();
    document.getSelection()?.removeAllRanges();
  }
  bounds(locator: Locator) {
    if (locator.type !== "pdf" || locator.hash !== this.book.hash) return [];
    const regions = locator.regions?.length
      ? locator.regions
      : [{ page: locator.page, rects: [] }];
    return regions.flatMap((region) => {
      const state = this.pages[region.page - 1];
      if (!state || state.element.hidden || !state.element.isConnected)
        return [];
      const box = state.element.getBoundingClientRect();
      if (!box.height) return [];
      if (!region.rects.length)
        return [
          {
            left: box.left,
            right: box.right,
            top: box.top + locator.y * box.height,
            bottom: box.top + locator.y * box.height + 2,
          },
        ];
      return region.rects.map((rect) => {
        const [x1, y1, x2, y2] = viewportRect(state.viewport, rect);
        return {
          left: box.left + x1,
          top: box.top + y1,
          right: box.left + x2,
          bottom: box.top + y2,
        };
      });
    });
  }
  intersects(a: Locator, b: Locator) {
    if (a.type !== "pdf" || b.type !== "pdf" || a.hash !== b.hash) return false;
    return !!a.regions?.some((ar) =>
      b.regions?.some(
        (br) =>
          ar.page === br.page &&
          ar.rects.some((x) =>
            br.rects.some((y) =>
              overlap(
                { left: x[0], top: x[1], right: x[2], bottom: x[3] },
                { left: y[0], top: y[1], right: y[2], bottom: y[3] },
              ),
            ),
          ),
      ),
    );
  }
  destroy() {
    this.turn.destroy();
    this.disposed = true;
    clearTimeout(this.autoOcrTimer);
    document.removeEventListener("visibilitychange", this.scheduleRecognition);
    this.touch?.destroy();
    this.ocr.destroy();
    clearTimeout(this.timer);
    this.observer?.disconnect();
    this.resizeObserver?.disconnect();
    document.removeEventListener("selectionchange", this.selection);
    if (this.selectionFrame !== undefined)
      cancelAnimationFrame(this.selectionFrame);
    this.host.removeEventListener("scroll", this.onScroll);
    this.host.removeEventListener("pointerdown", this.pointerDown);
    this.host.removeEventListener("pointermove", this.pointerMove);
    this.host.removeEventListener("pointerup", this.pointerUp);
    this.host.removeEventListener("pointercancel", this.pointerCancel);
    this.host.removeEventListener("click", this.click);
    this.host.removeEventListener("keydown", this.keyDown);
    document.removeEventListener("keydown", this.escapeRegion);
    this.pointerCancel();
    void this.loadingTask?.destroy();
    this.host.replaceChildren();
    this.host.classList.remove("pdf-reader", "region-mode");
  }
}
