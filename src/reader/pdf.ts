import { applyPrintFace } from "./pdfPrint";
import type { PrintFace } from "../ReaderComfort";
import { bindPdfZoom } from "./pdfZoom";
import { ViewIntent, abortable } from "./viewIntent";
import { PageTurn } from "./pageTurn";
import { pageViewport, blankMargins } from "./pdfGeometry";
import { bindInkSurface, InkHistory, recoverInkDrafts } from "../ink";
import { defaultInkStyle, type InkStroke, type InkStyle } from "../inkTypes";
import { belongsToPdf, boxFont, boxInk, boxPadding, boxPaper, boxTransform, layoutBoxText, validPdfTextBox, type PdfTextBox } from "../pdfTextBoxes";
import { blankLeaf, canvasImage, disposeSurfaces, surfaceCache, type TurnDirection, type TurnPreview, type TurnSpread } from "./turnSurfaces";
import { db } from "../db";
import { pageText, savedOcr, preparePageText, hasPageText, readableParagraphs, type OcrWord } from "../pdfText";
import { PageOcr } from "./ocr";
import { surroundingText } from "../sourceIndex";
import { bindPdfTouch } from "./pdfTouch";
import { bindNativeSelection } from "./nativeSelection";
import { pdfTextPoint } from "./pdfTextPoint";
import { pdfLibrary, pdfOptions, pdfOpenError } from "../pdf";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  PageViewport,
  RenderTask,
} from "pdfjs-dist";
import { findQuote, normalizeRect, quoteAt } from "../anchors";
import { narrationSentences } from "./narrationText";
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

type PageState = {
  imageRects?: Rect[];
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
  textTask?: { render: () => Promise<unknown>; cancel: () => unknown };
  renderAbort?: AbortController;
  generation: number;
};
function viewportRect(viewport: PageViewport, rect: Rect): Rect {
  const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[3]);
  return normalizeRect([x1, y1, x2, y2]);
}
export class PdfReader implements ReaderAdapter {
  async captureRegion(locator: Locator) {
    if (locator.type !== "pdf" || locator.hash !== this.book.hash) throw new Error("Select a region in this PDF.");
    const state = this.pages[locator.page - 1];
    const rect = locator.regions?.find(item => item.page === locator.page)?.rects[0];
    if (!state || !rect) throw new Error("Select a region on one page.");
    const rotation = state.viewport.rotation;
    const bounds = viewportRect(state.page.getViewport({ scale: 1, rotation }), rect);
    const scale = Math.min(2, 1600 / Math.max(1, bounds[2] - bounds[0], bounds[3] - bounds[1]));
    const viewport = state.page.getViewport({ scale, rotation });
    const [left, top, right, bottom] = viewportRect(viewport, rect);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(right - left));
    canvas.height = Math.max(1, Math.ceil(bottom - top));
    try {
      await state.page.render({ canvas, viewport, transform: [1, 0, 0, 1, -left, -top] }).promise;
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result =>
        result ? resolve(result) : reject(new Error("Could not capture this region.")), "image/png"));
      return new File([blob], "Page " + state.n + ".png", { type: "image/png" });
    } finally { canvas.width = canvas.height = 0; }
  }
  async context(selection: import("./types").Selection) {
    if (selection.locator.type !== "pdf") return selection.text;
    const state = this.pages.find(p => p.n === (selection.locator.type === "pdf" ? selection.locator.page : 0));
    if (!state) return selection.text;
    const content = await pageText(this.book, state.page);
    const text = state.ocrWords?.map(w => w.text).join(" ") || content.items.map(i => "str" in i ? i.str : "").join(" ");
    return surroundingText(text, selection.text, `${selection.text}\nNearby page text: ${text.slice(0, 1600)}`);
  }
  private pdf!: PDFDocumentProxy;
  private turn: PageTurn;
  private effect: Preferences["pageTurnEffect"] = "curl";
  private preferenceKey = "";
  private printFace: PrintFace = "original";
  async setPrintAppearance(face:PrintFace) {
    this.turn.invalidate();
    this.clearSurfaces();
    if (this.printFace === face) return;
    this.printFace = face;
    if (this.view) await this.setView(this.view.target.zoom,this.view.target.rotation,true);
  }
  get textViewStartPage() {
    // The progress label is debounced during scroll. Read the visible sheet
    // directly when opening Text view, including the selected side of a spread.
    return this.layingOut ? this.current : this.location().page;
  }
  async returnFromTextView(page: number) {
    this.resizeToHost();
    let pending: Promise<void>;
    do {
      pending = this.viewQueue;
      await pending;
      if (this.disposed) return;
      if (pending === this.viewQueue) await this.goTo(String(page));
    } while (!this.disposed && pending !== this.viewQueue);
  }
  async readablePage(n:number, recognize:boolean) {
    const state=this.pages[n-1];
    if (!state) throw Error("This page is unavailable.");
    const content=await pageText(this.book,state.page);
    if (hasPageText(content)) return readableParagraphs(content);
    if (recognize) await this.recognizePage(state,true);
    const words = state.ocrWords ?? await savedOcr(this.book,n);
    return words ? readableParagraphs(words) : null;
  }
  private surfaceRevision = 0;
  private surfaces = new Map<number, { spread: TurnSpread; cache: HTMLElement }>();
  private clearSurfaces() { this.surfaceRevision++; for (const item of this.surfaces.values()) disposeSurfaces(item.cache); this.surfaces.clear(); }
  private ocr = new PageOcr();
  private touch?: ReturnType<typeof bindPdfTouch>;
  private unbindNativeSelection?: () => void;
  private loadingTask?: PDFDocumentLoadingTask;
  private lib!: Awaited<ReturnType<typeof pdfLibrary>>;
  private pages: PageState[] = [];
  private margins = new Map<number, Rect | null>();
  private cropTimer?: ReturnType<typeof setTimeout>;
  private cropPending = false;
  private ink: InkStroke[] = [];
  private drawing = false;
  private textBoxMode = false;
  private textBoxes: PdfTextBox[] = [];
  private textBoxesByPage = new Map<number, PdfTextBox[]>();
  private editingBox?: string;
  private inkStyle = defaultInkStyle;
  private inkHistory = new InkHistory();
  private inkLayers = new Map<number, { svg: SVGSVGElement; binding: ReturnType<typeof bindInkSurface> }>();
  private observer?: IntersectionObserver;
  private resizeObserver?: ResizeObserver;
  private hostWidth = 0;
  private hostHeight = 0;
  private resizeToHost = () => {
    if (this.editingBox) return;
    if (Math.abs(this.host.clientWidth - this.hostWidth) <= 5 &&
        (this.layout.fit !== "page" || Math.abs(this.host.clientHeight - this.hostHeight) <= 5)) return;
    this.hostWidth = this.host.clientWidth;
    this.hostHeight = this.host.clientHeight;
    void this.setView(this.zoomController?.target() ?? this.zoom, this.view?.target.rotation ?? this.rotation, true)
      .catch(error => this.events.onError(error.message));
  };
  private autoOcrTimer?: ReturnType<typeof setTimeout>;
  private autoOcrBusy = false;
  private autoOcrBlocked = false;
  private autoOcrAttempted = new Set<number>();
  private cachedOcrPages = new Set<number>();
  private marks: Annotation[] = [];
  private disposed = false;
  private zoom = 1;
  private zoomController?: ReturnType<typeof bindPdfZoom>;
  private zoomPreview?: { element: HTMLElement; paper: HTMLElement; state: PageState; point: number[]; origin: { x: number; y: number } };
  private requestedLayout: PdfLayout = { ...defaultPdfLayout };
  private forceView = false;
  private view?: ViewIntent<{ zoom: number; rotation: number; layout: PdfLayout }>;
  private rotation = 0;
  private current = 1;
  private region = false;
  private layout: PdfLayout = { ...defaultPdfLayout };
  private columns = 1;
  private layingOut = false;
  private fingers = 0;
  private mouseSelecting = false;
  private zoomInteracting = false;
  private pauseView() {
    this.view?.pause(this.fingers > 0 || this.mouseSelecting || this.zoomInteracting);
  }
  private touchPause = (event: TouchEvent) => {
    this.fingers = this.drawing || event.type === "touchcancel" ? 0 : event.touches.length;
    this.pauseView();
  };
  private drag?: { page: PageState; x: number; y: number; box: HTMLDivElement };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private viewQueue: Promise<void> = Promise.resolve();
  constructor(
    private host: HTMLElement,
    private book: Book,
    private events: ReaderEvents,
  ) {
    this.view = new ViewIntent({ zoom: 1, rotation: 0, layout: this.layout }, async (intent, signal) => {
      const force = this.forceView; this.forceView = false;
      const geometry = force || intent.zoom !== this.zoom || intent.rotation !== this.rotation ||
        intent.layout.columns !== this.layout.columns || intent.layout.fit !== this.layout.fit || intent.layout.trimMargins !== this.layout.trimMargins;
      const anchor = this.pages.length ? this.location() : undefined;
      const navigation = intent.layout.navigation !== this.layout.navigation;
      this.layout = { ...intent.layout };
      if (geometry) await this.relayout(intent.zoom, intent.rotation, signal, anchor);
      else if (navigation && anchor && !signal.aborted) { this.host.dataset.navigation = this.layout.navigation; await this.goTo(anchor); }
    }, () => {
      if (this.layingOut) this.forceView = true;
      for (const page of this.pages) { page.generation++; page.task?.cancel(); page.textTask?.cancel(); page.renderAbort?.abort(); }
    });
    this.turn = new PageTurn(host, {
      enabled: () => this.layout.navigation === "paginated" && this.effect !== "none" && this.zoom <= 1 && !this.drawing && !this.textBoxMode && !this.region && !this.layingOut && !this.host.classList.contains("pdf-zooming"),
      canDrag: () => !!this.events.canDragTurn?.() && !host.classList.contains("pdf-zooming"),
      canWarm: () => this.events.canPrepare?.() !== false,
      canTap: () => this.layout.navigation === "paginated" && !this.drawing && !this.textBoxMode && !this.region && !this.layingOut && !host.classList.contains("pdf-zooming") && !!this.events.canEdgeTurn?.(),
      tapBounds: () => { const paper = this.paperBounds(), visible = host.getBoundingClientRect(); const left = Math.max(paper.left, visible.left), top = Math.max(paper.top, visible.top); return new DOMRect(left, top, Math.max(0, Math.min(paper.right, visible.right) - left), Math.max(0, Math.min(paper.bottom, visible.bottom) - top)); },
      navigate: direction => this[direction](),
      bounds: () => this.paperBounds(),
      location: () => String(this.current),
      prepare: (direction, outgoing) => this.prepareTurn(direction, outgoing),
    });
    this.turn.bind(host);
  }
  restoreInitialView(zoom: number, rotation: number, locator?: Locator) {
    this.zoom = Math.max(1, Math.min(3, zoom)); this.rotation = rotation;
    if (this.view) this.view.target = { zoom: this.zoom, rotation, layout: this.layout };
    if (locator?.type === "pdf" && locator.hash === this.book.hash) this.current = locator.page;
  }
  async open(source: Blob) {
    void recoverInkDrafts();
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
    this.events.onPageCount?.(this.pdf.numPages);
    // Read only cache keys up front: a completed large book must not enqueue
    // hundreds of cache-hit "recognition" jobs or load every word into memory.
    const prefixes = [`ocr-v2:${this.book.id}:${this.book.hash}:`, `ocr-v1:${this.book.id}:`];
    const savedKeys = await Promise.all(prefixes.map(prefix =>
      db.meta.where("key").startsWith(prefix).primaryKeys()));
    savedKeys.forEach((keys, i) => keys.forEach(key => {
      const n = Number(key.slice(prefixes[i].length));
      if (Number.isInteger(n) && n >= 1 && n <= this.pdf.numPages) this.cachedOcrPages.add(n);
    }));
    if (this.disposed) return;
    this.host.classList.add("pdf-reader");
    const marginPrefix = `pdf-margins:v1:${this.book.hash}:`;
    for (const row of await db.meta.where("key").startsWith(marginPrefix).toArray()) {
      try { const crop = JSON.parse(row.value); if (crop === null || Array.isArray(crop) && crop.length === 4 && crop.every(Number.isFinite)) this.margins.set(Number(row.key.slice(marginPrefix.length)), crop); } catch { /* Recompute malformed cache entries. */ }
    }
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
      ocrButton.textContent = "Prepare this page's text";
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
    }
    this.current = Math.max(1, Math.min(this.pages.length, this.current));
    this.arrange();
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const state =
              this.pages[
                Number((entry.target as HTMLElement).dataset.page) - 1
              ];
            this.queueRender(state);
          }
        }
      },
      { root: this.host, rootMargin: "300px" },
    );
    this.pages.forEach((p) => this.observer!.observe(p.element));
    this.touch = bindPdfTouch(this.host, async (element) => {
      const state = this.pages[Number(element.dataset.page) - 1];
      if (state?.hasText === false) await this.recognizePage(state);
    }, range => this.readSelection(range, true), () => this.events.onSelection(null), this.events.onSelectionInteraction);
    this.unbindNativeSelection = bindNativeSelection(this.host, {
      selected: range => range ? this.readSelection(range) : this.events.onSelection(null),
      dragging: active => {
        this.mouseSelecting = active;
        this.pauseView();
        this.events.onMouseSelection?.(active);
      },
      allowed: element => !this.drawing && !this.textBoxMode && !this.region && !!element.closest(".textLayer"),
      textPoint: (x, y) => pdfTextPoint(this.host, x, y),
    });
    // Retain the gesture's original text/canvas nodes until touch release.
    // Replacing its target mid-swipe loses Chrome's remaining touch events.
    for (const name of ["touchstart", "touchend", "touchcancel"] as const) this.host.addEventListener(name, this.touchPause, { capture: true, passive: true });
    this.host.addEventListener("scroll", this.onScroll, { passive: true });
    document.addEventListener("visibilitychange", this.scheduleRecognition);
    this.host.addEventListener("contextmenu", this.imageMenu);
    this.host.addEventListener("pointerdown", this.pointerDown);
    this.host.addEventListener("pointermove", this.pointerMove);
    this.host.addEventListener("pointerup", this.pointerUp);
    this.host.addEventListener("pointercancel", this.pointerCancel);
    this.host.addEventListener("click", this.click);
    this.host.addEventListener("keydown", this.keyDown);
    document.addEventListener("keydown", this.escapeRegion);
    await this.render(this.pages[this.current - 1]);
    this.onScroll();
    this.hostWidth = this.host.clientWidth;
    this.hostHeight = this.host.clientHeight;
    this.resizeObserver = new ResizeObserver(this.resizeToHost);
    this.resizeObserver.observe(this.host);
    this.zoomController = bindPdfZoom(this.host, {
      enabled: () => !this.editingBox,
      interaction: active => { this.zoomInteracting = active; this.pauseView(); },
      target: zoom => { void this.setView(zoom, this.view?.target.rotation ?? this.rotation).catch(e => this.events.onError(e.message)); },
      value: () => this.zoom,
      preview: (ratio, point, origin) => {
        if (!this.zoomPreview) {
          this.turn.invalidate(); this.clearSurfaces(); this.clearSelection(); this.events.onSelection(null);
          const box = this.host.getBoundingClientRect();
          const element = document.createElement("div"), paper = document.createElement("div");
          element.className = "pdf-zoom-preview"; element.setAttribute("aria-hidden", "true"); element.inert = true;
          Object.assign(element.style, { position: "fixed", left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, overflow: "hidden", pointerEvents: "none", zIndex: "10", background: getComputedStyle(this.host).backgroundColor });
          Object.assign(paper.style, { position: "absolute", inset: "0", willChange: "transform", transformOrigin: `${origin.x - box.left}px ${origin.y - box.top}px` });
          const visible = this.pages.filter(state => { const r = state.element.getBoundingClientRect(); return state.loaded && !state.element.hidden && r.bottom >= box.top && r.top <= box.bottom && r.right >= box.left && r.left <= box.right; });
          for (const state of visible) {
            if (!state.loaded || state.element.hidden) continue;
            const r = state.element.getBoundingClientRect();
            if (r.bottom < box.top || r.top > box.bottom || r.right < box.left || r.left > box.right) continue;
            const clone = state.element.cloneNode(true) as HTMLElement;
            clone.className = "pdf-zoom-page"; clone.removeAttribute("data-page"); clone.removeAttribute("aria-label");
            clone.style.background = getComputedStyle(state.element).background;
            clone.style.boxShadow = getComputedStyle(state.element).boxShadow;
            clone.querySelectorAll(".textLayer,.pdf-text-box-edit,button:not(.pdf-text-box)").forEach(el => el.remove());
            const original = state.element.querySelector("canvas"), copy = clone.querySelector("canvas");
            if (original && copy) {
              const scale = Math.min(1, Math.sqrt(1_500_000 / Math.max(1, visible.length) / (original.width * original.height)));
              copy.width = Math.max(1, Math.floor(original.width * scale)); copy.height = Math.max(1, Math.floor(original.height * scale));
              copy.getContext("2d")?.drawImage(original, 0, 0, copy.width, copy.height); copy.style.filter = getComputedStyle(original).filter;
            }
            Object.assign(clone.style, { position: "absolute", margin: "0", left: `${r.left - box.left}px`, top: `${r.top - box.top}px`, width: `${r.width}px`, height: `${r.height}px` });
            paper.append(clone);
          }
          const state = this.pages.find(p => { const r = p.element.getBoundingClientRect(); return !p.element.hidden && origin.x >= r.left && origin.x <= r.right && origin.y >= r.top && origin.y <= r.bottom; }) || this.pages[this.current - 1];
          const r = state.element.getBoundingClientRect();
          const anchor = state.viewport.convertToPdfPoint(origin.x - r.left, origin.y - r.top);
          element.append(paper); (this.host.closest(".reader-shell") || this.host).append(element);
          this.zoomPreview = { element, paper, state, point: anchor, origin };
        }
        this.zoomPreview.paper.style.transform = `translate(${point.x - origin.x}px,${point.y - origin.y}px) scale(${ratio})`;
        this.host.classList.add("pdf-zooming");
      },
      clear: () => {
        this.zoomPreview?.element.remove(); this.zoomPreview = undefined;
        this.host.classList.remove("pdf-zooming"); this.onScroll();
      },
      settled: zoom => this.events.onZoom?.(zoom),
      commit: async (zoom, point) => {
        const preview = this.zoomPreview;
        await this.setView(zoom, this.view?.target.rotation ?? this.rotation);
        let pending: Promise<void>;
        do { pending = this.viewQueue; await pending; } while (pending !== this.viewQueue);
        if (this.disposed || !preview) return;
        const next = preview.state.element.getBoundingClientRect();
        const [x, y] = preview.state.viewport.convertToViewportPoint(preview.point[0], preview.point[1]);
        this.host.scrollLeft += next.left + x - point.x;
        this.host.scrollTop += next.top + y - point.y;
        this.events.onZoom?.(this.zoom);
      },
      error: error => this.events.onError(error instanceof Error ? error.message : String(error)),
    });
  }
  private size(state: PageState, dimensions: { width: number; height: number; phone: boolean }) {
    const { phone } = dimensions;
    const original = state.page.getViewport({ scale: 1 });
    const crop = this.columns === 2 && this.layout.trimMargins !== false ? this.margins.get(state.n) || undefined : undefined;
    const base = pageViewport(original, crop, 1, this.rotation);
    const available = Math.max(
      160,
      (dimensions.width - (phone ? 8 : 32) - (this.columns - 1) * 2) / this.columns,
    );
    const widthScale = available / base.width;
    const scale =
      (this.layout.fit === "page"
        ? Math.min(
            widthScale,
            Math.max(160, dimensions.height - (phone ? 8 : 80)) / base.height,
          )
        : widthScale) * this.zoom;
    state.viewport = pageViewport(original, crop, scale, this.rotation);
    state.element.dataset.pdfCrop = crop ? crop.join(",") : "original";
    state.element.dataset.pdfRotation = String(this.rotation);
    state.element.style.width = `${state.viewport.width}px`;
    // Keep fractional page widths on their flex frames as well. Intrinsic
    // rounding in WebKit otherwise adds a sliver to the book's centre gutter.
    state.frame.style.width = `${state.viewport.width}px`;
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
  private renderQueue = new Set<PageState>();
  private renderTimer?: ReturnType<typeof setTimeout>;
  private preloading = false;
  private queueRender(state: PageState, delay = 120) {
    if (!state || this.disposed) return;
    if (state.loaded) this.renderQueue.delete(state); else this.renderQueue.add(state);
    if (!this.renderQueue.size) return;
    if (this.preloading || this.renderTimer) return;
    this.renderTimer = setTimeout(() => { this.renderTimer = undefined; void this.preload(); }, delay);
  }
  private async preload() {
    if (this.disposed || this.preloading) return;
    if (this.layingOut || this.host.getAttribute("aria-busy") === "true" || this.host.classList.contains("pdf-zooming") || this.events.canPrepare?.() === false) {
      const first = this.renderQueue.values().next().value;
      if (first) this.queueRender(first, 500);
      return;
    }
    const state = [...this.renderQueue].sort((a, b) => Math.abs(a.n - this.current) - Math.abs(b.n - this.current))[0];
    if (!state) return;
    this.renderQueue.delete(state);
    this.preloading = true;
    try { if (!state.element.hidden) await this.render(state); }
    catch (error) { if (!this.disposed) this.events.onError((error as Error).message); }
    finally { this.preloading = false; const next = this.renderQueue.values().next().value; if (next) this.queueRender(next); }
  }
  private async render(state: PageState) {
    while (state.rendering && !this.disposed)
      await new Promise((resolve) => setTimeout(resolve, 10));
    if (state.loaded || this.disposed) return;
    state.rendering = true;
    const controller = new AbortController(); state.renderAbort = controller;
    const generation = state.generation;
    let layer: HTMLDivElement | undefined;
    try {
      const canvas = document.createElement("canvas"),
        ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt((matchMedia("(pointer:coarse)").matches ? 6_000_000 / this.columns : 6_000_000) / (state.viewport.width * state.viewport.height)));
      canvas.width = Math.floor(state.viewport.width * ratio);
      canvas.height = Math.floor(state.viewport.height * ratio);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.setAttribute("aria-hidden", "true");

      state.task = state.page.render({
        canvas,
        recordImages: !state.imageRects,
        viewport: state.viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      const renderedViewport = state.viewport;
      await state.task.promise;
      // PDF.js records three normalized image corners in the first rendered orientation.
      // Keep their bounds in PDF units so zooming or rotating does not move the hit target.
      const coordinates: ArrayLike<number> | null = state.page.imageCoordinates;
      if (!state.imageRects && coordinates) {
        state.imageRects = [];
        for (let i = 0; i + 5 < coordinates.length; i += 6) {
          const [ax, ay, bx, by, cx, cy] = Array.from({length:6}, (_, k) => coordinates[i+k]);
          const corners = [[ax, ay], [bx, by], [cx, cy], [bx+cx-ax, by+cy-ay]]
            .map(([x,y]) => renderedViewport.convertToPdfPoint(x*renderedViewport.width, y*renderedViewport.height));
          const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
          state.imageRects.push([Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)]);
        }
      }
      if (this.disposed || generation !== state.generation) return;
      layer = document.createElement("div");
      layer.className = "textLayer";
      layer.style.visibility = "hidden";
      state.element.append(layer);
      const text = await abortable(pageText(this.book, state.page), controller.signal);
      if (this.disposed || generation !== state.generation) return;
      if (this.printFace !== "original") {
        // Cached text can belong to another PDF.js document instance. The active
        // instance owns the font objects used to validate printed body text.
        try {
          const native = await state.page.getTextContent();
          await applyPrintFace(canvas, state.page, state.viewport, native, this.printFace, this.lib.OPS, controller.signal);
        } catch { /* A print preview is optional. Keep the rendered PDF available. */ }
        if (controller.signal.aborted || this.disposed || generation !== state.generation) return;
      }
      state.textTask = new this.lib.TextLayer({
        textContentSource: text,
        container: layer,
        viewport: state.viewport,
      });
      await state.textTask!.render();
      if (this.disposed || generation !== state.generation) { layer.remove(); return; }
      state.element.querySelectorAll("canvas,.textLayer").forEach(old => { if (old !== layer) old.remove(); });
      layer.style.visibility = "";
      state.element.prepend(canvas);
      if (this.columns === 2 && !this.margins.has(state.n)) this.detectMargins(state, canvas);
      state.hasText = hasPageText(text);
      if (!state.hasText) {
        await this.loadOcrCache(state);
        if (this.disposed || generation !== state.generation) return;
        this.renderOcr(state);
      }
      state.loaded = true;
      this.drawPage(state);
      this.drawInk(state);
      this.drawTextBoxes(state);
      this.scheduleRecognition();
    } catch (error: any) {
      if (error?.name !== "RenderingCancelledException" && error?.name !== "AbortException" && error?.name !== "AbortError") throw error;
    } finally {
      if (layer?.style.visibility === "hidden") layer.remove();
      state.rendering = false;
      state.textTask = undefined;
      state.renderAbort = undefined;
    }
  }
  private async loadOcrCache(state: PageState) {
    if (state.ocrChecked || state.ocrWords !== undefined) return;
    state.ocrWords = await savedOcr(this.book, state.n);
    state.ocrChecked = true;
    if (state.ocrWords !== undefined) this.cachedOcrPages.add(state.n);
    else this.cachedOcrPages.delete(state.n);
  }
  private detectMargins(state: PageState, source: HTMLCanvasElement) {
    const sample = document.createElement("canvas"); sample.width = 320; sample.height = Math.max(1, Math.round(320 * source.height / source.width));
    const context = sample.getContext("2d", { willReadFrequently: true }); if (!context) return;
    context.drawImage(source, 0, 0, sample.width, sample.height);
    const bounds = blankMargins(context.getImageData(0, 0, sample.width, sample.height).data, sample.width, sample.height);
    let crop: Rect | null = null;
    if (bounds) {
      const a = state.viewport.convertToPdfPoint(bounds[0] / sample.width * state.viewport.width, bounds[1] / sample.height * state.viewport.height);
      const b = state.viewport.convertToPdfPoint(bounds[2] / sample.width * state.viewport.width, bounds[3] / sample.height * state.viewport.height);
      crop = normalizeRect([a[0], a[1], b[0], b[1]]);
    }
    this.margins.set(state.n, crop);
    void db.meta.put({ key: `pdf-margins:v1:${this.book.hash}:${state.n}`, value: JSON.stringify(crop) }).catch(() => {});
    if (crop && this.layout.trimMargins !== false) { this.cropPending = true; this.scheduleCrop(); }
  }
  private scheduleCrop = () => {
    clearTimeout(this.cropTimer);
    if (!this.cropPending || this.disposed) return;
    this.cropTimer = setTimeout(() => {
      if (this.disposed) return;
      if (this.events.canPrepare?.() === false || this.mouseSelecting || this.hasSelection() || this.host.dataset.pageTurning || this.host.classList.contains("pdf-zooming")) { this.scheduleCrop(); return; }
      this.cropPending = false;
      void this.setView(this.zoomController?.target() ?? this.zoom, this.view?.target.rotation ?? this.rotation, true).catch(e => this.events.onError(e.message));
    }, 500);
  };
  // Prioritize the visible page, then prepare the rest quietly, one at a time.
  // Completed (including blank) pages survive reopen; hidden tabs stop working.
  private scheduleRecognition = () => {
    clearTimeout(this.autoOcrTimer);
    if (this.disposed || this.autoOcrBusy || this.autoOcrBlocked) return;
    this.autoOcrTimer = setTimeout(() => {
      if (this.disposed || document.hidden || this.events.canPrepare?.() === false || this.layingOut || this.host.classList.contains("pdf-zooming") || this.host.dataset.pageTurning) { this.scheduleRecognition(); return; }
      if (this.pages.some(p => p.recognizing)) return;
      const viewport = this.host.getBoundingClientRect();
      const pending = this.pages.filter(p => !p.hasText &&
        p.ocrWords === undefined && !this.cachedOcrPages.has(p.n) && !this.autoOcrAttempted.has(p.n));
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
  private deferredOcr = new Set<PageState>();
  private deferredOcrTimer?: ReturnType<typeof setTimeout>;
  private renderOcr(state: PageState) {
    if (this.host.classList.contains("pdf-zooming") || this.host.dataset.pageTurning) {
      this.deferredOcr.add(state);
      if (!this.deferredOcrTimer) this.deferredOcrTimer = setTimeout(() => {
        this.deferredOcrTimer = undefined;
        const pending = [...this.deferredOcr]; this.deferredOcr.clear();
        if (!this.disposed) pending.filter(p => p.loaded).forEach(p => this.renderOcr(p));
      }, 150);
      return;
    }
    const words = state.ocrWords;
    state.ocrButton.hidden = !!state.hasText || words !== undefined ||
      !(state.ocrButton.classList.contains("recognizing") || state.ocrButton.classList.contains("ocr-failed"));
    if (!state.ocrButton.isConnected) state.element.append(state.ocrButton);
    const layer = state.element.querySelector<HTMLElement>(".textLayer");
    if (!layer || state.hasText || !words?.length) return;
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
      try {
        await this.loadOcrCache(state);
        if (state.hasText === undefined && state.ocrWords === undefined) {
          const text = await pageText(this.book, state.page);
          state.hasText = text.items.some(item => "str" in item && item.str.trim());
        }
        if (state.hasText || state.ocrWords !== undefined) {
          state.ocrButton.hidden = true;
          this.renderOcr(state);
          return;
        }
        if (this.disposed) return;
        state.ocrButton.hidden = false;
        state.ocrButton.disabled = true;
        state.ocrButton.classList.remove("ocr-failed");
        state.ocrButton.classList.add("recognizing");
        state.ocrButton.textContent = `Preparing page ${state.n} text...`;
        const words = await preparePageText(this.book, state.page, this.ocr, percent => {
          if (!this.disposed) state.ocrButton.textContent = `Page ${state.n} text: ${percent}%`;
        });
        if (words !== undefined) { state.ocrWords = words; this.cachedOcrPages.add(state.n); }
        else state.hasText = true;
        this.autoOcrBlocked = false;
        if (!this.disposed) this.renderOcr(state);
      } catch (error) {
        if (!this.disposed) {
          state.ocrButton.hidden = false;
          state.ocrButton.classList.add("ocr-failed");
          state.ocrButton.textContent = "Retry text recognition";
          const message = error instanceof Error ? error.message : String(error);
          state.ocrButton.title = message;
          // A blank page or failed background recognition must not interrupt reading.
          if (!automatic) this.events.onError(`Text recognition: ${message}`);
        }
        throw error;
      } finally {
        state.ocrButton.disabled = false;
        state.ocrButton.classList.remove("recognizing");
        state.recognizing = undefined;
        this.scheduleRecognition();
      }
    })();
    return state.recognizing;
  }
  private readSelection(range: Range, touch = false) {
    const selected = this.selectionFromRange(range);
    if (selected) this.events.onSelection(selected, touch ? "touch" : "native");
  }
  selectionFromRange(range: Range): import("./types").Selection | undefined {
    if (this.region || this.drawing) return;
    if (
      !this.host.contains(range.startContainer) ||
      !this.host.contains(range.endContainer)
    )
      return;
    const fragment = range.cloneContents();
    fragment.querySelectorAll("br").forEach(br => br.replaceWith(document.createTextNode("\n")));
    const text = fragment.textContent || range.toString();
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
    return {
      text,
      locator: {
        v: 1,
        type: "pdf",
        hash: this.book.hash,
        page: regions[0].page,
        y: 0,
        regions,
        quote: { exact: text, prefix: "", suffix: "" },
      },
    };
  }
  private visiblePage() {
    const bounds = this.host.getBoundingClientRect();
    const last = this.pages[this.pages.length - 1];
    // A short final page cannot reach the top of a tall viewport. At the end
    // of continuous scrolling it is still the reading page, not its predecessor.
    if (last && !last.element.hidden && this.layout.navigation === "continuous" && this.host.scrollTop > 0 &&
        this.host.scrollTop + this.host.clientHeight >= this.host.scrollHeight - 2 &&
        last.element.getBoundingClientRect().top < bounds.bottom) return last;
    return this.pages.find(p => !p.element.hidden && p.element.getBoundingClientRect().bottom > bounds.top + 30) || last;
  }
  private onScroll = () => {
    if (this.layingOut || this.host.classList.contains("pdf-zooming")) return;
    this.scheduleRecognition();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.disposed || this.layingOut || this.host.getAttribute("aria-busy") === "true" || this.host.classList.contains("pdf-zooming")) return;
      const top = this.host.getBoundingClientRect().top;
      let state = this.visiblePage();
      if (!state) return;
      const selected = this.pages[this.current - 1];
      if (
        this.columns === 2 &&
        selected &&
        !selected.element.hidden &&
        selected.frame.parentElement === state.frame.parentElement
      )
        state = selected;
      if (this.current !== state.n) { this.current = state.n; this.turn.invalidate(); }
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
      // A logical touch range needs its text nodes just as native selection does.
      if (!this.hasSelection())
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
    if (this.textBoxMode) return;
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
      this.textBoxMode ||
      (event.target as HTMLElement).closest(
        "input, textarea, [contenteditable=true], button",
      )
    )
      return;
    if (
      ["ArrowRight", "PageDown", "ArrowLeft", "PageUp"].includes(event.key) &&
      this.requestedLayout.navigation === "paginated"
    ) {
      event.preventDefault();
      void (["ArrowRight", "PageDown"].includes(event.key)
        ? this.next()
        : this.previous());
    }
  };
  private arrange() {
    this.columns = this.layout.columns;
    this.events.onLayoutFallback?.(
      this.layout.columns === 2 && this.columns === 1,
    );
    const dimensions = { width: this.host.clientWidth, height: this.host.clientHeight, phone: window.matchMedia("(max-width: 700px)").matches };
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < this.pages.length; i += this.columns) {
      const row = document.createElement("div");
      row.className = "pdf-spread";
      const hidden = this.layout.navigation === "paginated" &&
        Math.floor((this.current - 1) / this.columns) * this.columns !== i;
      row.hidden = hidden;
      for (const p of this.pages.slice(i, i + this.columns)) {
        this.size(p, dimensions);
        p.element.hidden = hidden;
        row.append(p.frame);
      }
      if (this.columns === 2 && i + 1 === this.pages.length) {
        const blank = document.createElement("div");
        blank.className = "pdf-page-frame pdf-blank-page";
        blank.setAttribute("aria-hidden", "true");
        Object.assign(blank.style, { width: this.pages[i].element.style.width, height: this.pages[i].element.style.height });
        row.append(blank);
      }
      fragment.append(row);
    }
    const paper = document.createElement("div");
    paper.className = "pdf-document";
    paper.append(fragment);
    this.host.replaceChildren(paper);
    this.host.dataset.columns = String(this.columns);
    this.host.dataset.navigation = this.layout.navigation;
    if (this.textBoxMode) this.events.onTextBoxLayout?.();
  }
  private location(): Extract<Locator, {type:"pdf"}> {
    const top = this.host.getBoundingClientRect().top;
    let state = this.visiblePage() || this.pages[0];
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
  private imageAt(page: PageState, x: number, y: number) {
    let hit: Rect | undefined, smallest = Infinity;
    for (const candidate of page.imageRects ?? []) {
      const [left,bottom,right,top] = candidate, area = (right-left)*(top-bottom);
      if (x >= left && x <= right && y >= bottom && y <= top && area < smallest) {
        hit = candidate; smallest = area;
      }
    }
    return hit;
  }
  private selectImage(page: PageState, rect: Rect) {
    this.clearSelection();
    const [left,top,right,bottom] = viewportRect(page.viewport,rect);
    const outline = document.createElement("div");
    outline.className = "pdf-image-selection";
    Object.assign(outline.style,{left:left/page.viewport.width*100+"%", top:top/page.viewport.height*100+"%",
      width:(right-left)/page.viewport.width*100+"%",height:(bottom-top)/page.viewport.height*100+"%"});
    page.element.append(outline);
    this.events.onSelection({ kind:"image", text:`Region on page ${page.n}`,
      locator: { v:1, type:"pdf", hash:this.book.hash, page:page.n, y:0, regions:[{page:page.n,rects:[rect]}] }
    });
  }
  private imageMenu = (event: MouseEvent) => {
    // A long press may still be preparing OCR on a full-page scan.
    if (event.defaultPrevented || this.region || this.drawing || this.textBoxMode || this.hasSelection()) return;
    const element = (event.target as Element).closest<HTMLElement>(".pdf-page");
    const page = element && this.pages[Number(element.dataset.page)-1];
    if (!page || !element) return;
    const r = element.getBoundingClientRect();
    const [x,y] = page.viewport.convertToPdfPoint((event.clientX-r.left)*page.viewport.width/r.width,
      (event.clientY-r.top)*page.viewport.height/r.height);
    const rect = this.imageAt(page,x,y);
    if (rect) { event.preventDefault(); this.selectImage(page,rect); }
  };
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
    const pdfPoint = (x:number,y:number) => page.viewport.convertToPdfPoint(
      x * page.viewport.width / p.width, y * page.viewport.height / p.height);
    let rect: Rect | undefined;
    if (r.width > 5 && r.height > 5) {
      const a = pdfPoint(r.left-p.left,r.top-p.top), b = pdfPoint(r.right-p.left,r.bottom-p.top);
      rect = normalizeRect([a[0],a[1],b[0],b[1]]);
    } else {
      const [x,y] = pdfPoint(this.drag.x,this.drag.y);
      rect = this.imageAt(page,x,y);
    }
    if (rect) {
      this.selectImage(page,rect);
    } else {
      this.events.onHint?.("Drag a box around the illustration to select it.");
      box.remove(); this.drag = undefined; this.releasePointer();
      return;
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
  requestZoom(zoom: number) { this.zoomController?.request(zoom); }
  setView(zoom: number, rotation: number, force = false) {
    // Finish using the old projection before changing viewport coordinates.
    this.inkLayers.forEach(layer => layer.binding.flush());
    this.forceView ||= force;
    this.host.setAttribute("aria-busy", "true");
    const pending = this.view!.request({ zoom, rotation, layout: { ...this.requestedLayout } });
    this.viewQueue = pending;
    void pending.finally(() => { if (!this.disposed && this.viewQueue === pending) this.host.setAttribute("aria-busy", "false"); }).catch(() => {});
    return pending;
  }
  private async relayout(zoom: number, rotation: number, signal?: AbortSignal, savedAnchor?: Locator) {
    this.turn.invalidate(); this.clearSurfaces();
    if (this.disposed || !this.pages.length) return;
    const anchor = savedAnchor || this.location(), clip = this.host.getBoundingClientRect();
    const visible = new Set(this.pages.filter(p => { const r = p.element.getBoundingClientRect(); return !p.element.hidden && r.bottom >= clip.top && r.top <= clip.bottom; }));
    this.layingOut = true;
    try {
      this.zoom = zoom;
      this.rotation = rotation;
      for (const p of this.pages) {
        p.generation++;
        p.task?.cancel();
        p.textTask?.cancel(); p.renderAbort?.abort();
        while (p.rendering && !this.disposed)
          await new Promise((r) => setTimeout(r, 5));
        p.loaded = false;
        // Only visible old bitmaps are needed during the handoff.
        if (!visible.has(p)) {
          this.inkLayers.get(p.n)?.binding.destroy();
          this.inkLayers.delete(p.n);
          for (const child of Array.from(p.element.children)) if (!child.classList.contains("pdf-text-box-edit")) child.remove();
        }
      }
      if (this.disposed || signal?.aborted) return;
      this.arrange();
      let restore = anchor;
      let scrollTop = this.host.scrollTop, scrollLeft = this.host.scrollLeft;
      // A panel resize may still be sharpening when a reader scrolls again.
      // Follow that newer position instead of restoring the pre-fit anchor.
      while (!this.disposed) {
        const page = restore.type === "pdf" ? restore.page : this.current;
        const first = Math.floor((page - 1) / this.columns) * this.columns;
        await Promise.all(this.pages.slice(first, first + this.columns).map(p => this.render(p)));
        if (signal?.aborted) return;
        if (Math.abs(this.host.scrollTop - scrollTop) > 1 || Math.abs(this.host.scrollLeft - scrollLeft) > 1) {
          restore = this.location(); scrollTop = this.host.scrollTop; scrollLeft = this.host.scrollLeft;
          continue;
        }
        await this.goTo(restore);
        break;
      }
    } finally {
      this.layingOut = false;
    }
    if (this.disposed || signal?.aborted) return;
    this.turn.invalidate();
    this.onScroll();
    for (const p of this.pages.filter(p => Math.abs(p.n - this.current) < 2)) this.queueRender(p);
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
    // Restoring the top of the first spread must retain its initial padding.
    // Scrolling that padding away can reach the bottom of a short, two-spread
    // document on a tall tablet and make visiblePage report the final page.
    const firstSpread = row === this.pages[0]?.frame.parentElement;
    if (firstSpread && y <= 0 || this.layout.navigation === "paginated" && this.zoom <= 1 && state.viewport.height <= this.host.clientHeight - 8) this.host.scrollTop = 0;
    else this.host.scrollTop +=
      state.element.getBoundingClientRect().top -
      this.host.getBoundingClientRect().top +
      y * state.viewport.height -
      (typeof locator === "string" ||
      (!locator.point && !locator.regions?.length)
        ? 28
        : 0);
    this.current = state.n;
    this.onScroll();
    this.turn.invalidate();
  }
  async next() {
    await this.turnPage("next");
  }
  async previous() {
    await this.turnPage("previous");
  }
  private async turnPage(direction: "next" | "previous") {
    // A fit/resize already queued by closing a panel must settle before the
    // turn captures its preview revision. Otherwise that fit invalidates and
    // silently drops a button/key request made while it was still rendering.
    let pending: Promise<void>;
    do { pending = this.viewQueue; await pending; } while (pending !== this.viewQueue);
    if (this.disposed) return;
    if (this.hasSelection() || this.region) return;
    await this.turn.run(direction, async () => {
      await this.viewQueue;
      if (this.disposed) return false;
      const row = Math.floor((this.current - 1) / this.columns) * this.columns;
      const target = row + (direction === "next" ? this.columns : -this.columns) + 1;
      if (target < 1 || target > this.pages.length) return false;
      await this.goTo(String(target));
    });
  }
  private paperBounds() {
    const first = Math.floor((this.current - 1) / this.columns) * this.columns;
    const box = this.pages[first]?.element.getBoundingClientRect();
    if (!box) return this.host.getBoundingClientRect();
    const mate = this.pages[first]?.frame.parentElement?.lastElementChild?.getBoundingClientRect();
    const bottom = Math.max(box.bottom, ...this.pages.slice(first, first + this.columns).map(page => page.element.getBoundingClientRect().bottom));
    return new DOMRect(box.left, box.top, this.columns === 2 && mate ? mate.right - box.left : box.width, bottom - box.top);
  }
  private async prepareTurn(direction: TurnDirection, shared?: TurnSpread): Promise<TurnPreview | null> {
    await this.viewQueue;
    if (!this.pages.length || this.disposed) return null;
    const current = Math.floor((this.current - 1) / this.columns) * this.columns;
    const target = current + (direction === "next" ? this.columns : -this.columns);
    if (target < 0 || target >= this.pages.length) return null;
    const box = this.paperBounds(), width = box.width / this.columns, height = box.height;
    if (!width || !height) return null;
    const revision = this.surfaceRevision;
    const capture = async (start: number) => {
      const cached = this.surfaces.get(start);
      if (cached && cached.spread.width === width && cached.spread.height === height && cached.spread.columns === this.columns) return cached.spread;
      if (cached) { disposeSurfaces(cached.cache); this.surfaces.delete(start); }
      const cache = surfaceCache(this.host, box.width, height), leaves: HTMLElement[] = [];
      try {
        for (let i = 0; i < this.columns; i++) {
          const leaf = blankLeaf(width, height), page = this.pages[start + i];
          cache.append(leaf); leaves.push(leaf);
          if (page) {
            await this.render(page);
            const canvas = page.element.querySelector("canvas");
            if (!canvas) throw new Error("Page unavailable");
            const w = page.viewport.width, h = page.viewport.height;
            const scale = Math.min(1, width / w, height / h);
            const image = await canvasImage(canvas, w, h);
            leaf.append(image); // Own the URL even if the job is invalidated.
            if (revision !== this.surfaceRevision || this.disposed || Math.floor((this.current - 1) / this.columns) * this.columns !== current) throw new Error("Page layout changed");
            image.style.filter = getComputedStyle(canvas).filter;
            const content = document.createElement("div");
            Object.assign(content.style, { position: "absolute", width: `${w}px`, height: `${h}px`, left: `${(width - w * scale) / 2}px`, top: "0", transform: `scale(${scale})`, transformOrigin: "0 0" });
            content.className = "pdf-turn-content";
            content.append(image);
            for (const highlight of page.element.querySelectorAll<HTMLElement>(".pdf-highlight,.pdf-ink-layer,.pdf-text-box-layer")) {
              const clone = highlight.cloneNode(true) as HTMLElement, css = getComputedStyle(highlight);
              Object.assign(clone.style, { position: "absolute", backgroundColor: css.backgroundColor, opacity: css.opacity, mixBlendMode: css.mixBlendMode });
              content.append(clone);
            }
            leaf.append(content);
          }
        }
        const spread = { leaves, width, height, columns: this.columns as 1 | 2 };
        if (revision !== this.surfaceRevision || this.disposed || Math.floor((this.current - 1) / this.columns) * this.columns !== current) throw new Error("Page layout changed");
        const existing = this.surfaces.get(start);
        if (existing && existing.spread.width === width && existing.spread.height === height && existing.spread.columns === this.columns) { disposeSurfaces(cache); return existing.spread; }
        if (existing) disposeSurfaces(existing.cache);
        this.surfaces.set(start, { spread, cache });
        const limit = matchMedia("(pointer:coarse)").matches ? 2 : 3;
        while (this.surfaces.size > limit) {
          const oldest = [...this.surfaces.keys()].find(key => key !== current && key !== start);
          if (oldest === undefined) break;
          disposeSurfaces(this.surfaces.get(oldest)!.cache); this.surfaces.delete(oldest);
        }
        // Three spreads are sufficient for forward/backward reading. Keep the
        // active outgoing neighbour until its fold has finished.
        for (const [key, item] of this.surfaces) if (Math.abs(key - current) > this.columns) { disposeSurfaces(item.cache); this.surfaces.delete(key); }
        return spread;
      } catch (error) { disposeSurfaces(cache); throw error; }
    };
    const outgoing = shared || await capture(current), incoming = await capture(target);
    return { outgoing, incoming, commit: () => this.goTo(String(target + 1)), dispose() {} };
  }

  async search(query: string): Promise<SearchHit[]> {
    const hits: SearchHit[] = [];
    if (!query.trim()) return hits;
    for (const state of this.pages) {
      if (this.disposed) break;
      const content = await pageText(this.book, state.page);
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
    if (!outline?.length) return [];
    const walk = async (items: typeof outline): Promise<Section[]> =>
      Promise.all(
        items.map(async item => {
          let start: Locator | undefined;
          try {
            const dest = typeof item.dest === "string" ? await this.pdf.getDestination(item.dest) : item.dest;
            const target = dest?.[0];
            const page = target == null ? 0 : (typeof target === "number" ? target : await this.pdf.getPageIndex(target)) + 1;
            if (page >= 1 && page <= this.pages.length) start = { v: 1, type: "pdf", hash: this.book.hash, page, y: 0 };
          } catch { /* An invalid destination can still have navigable children. */ }
          return {
            id: start?.type === "pdf" ? String(start.page) : "",
            label: item.title,
            children: await walk(item.items || []),
            start,
          };
        }),
      );
    return walk(outline);
  }
  async prepareNarration(locator: Locator) {
    const state = locator.type === "pdf" && locator.hash === this.book.hash ? this.pages[locator.page - 1] : undefined;
    if (state) await this.recognizePage(state, true);
  }
  async *narration(start: Locator | undefined, signal: AbortSignal) {
    const initial = start?.type === "pdf" && start.hash === this.book.hash ? start : undefined;
    for (let index = Math.max(0, (initial?.page ?? 1) - 1); index < this.pages.length; index++) {
      signal.throwIfAborted();
      const state = this.pages[index];
      const content = await pageText(this.book, state.page);
      signal.throwIfAborted();
      const runs: { start: number; end: number; rect: Rect }[] = [];
      let text = "";
      function add(value: string, rect: Rect, endLine: boolean) {
        if (!value.trim()) { if (endLine) text += "\n"; return; }
        runs.push({ start: text.length, end: text.length + value.length, rect });
        text += value + (endLine ? "\n" : " ");
      }
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const [a, b, , , x, y] = item.transform;
        const scale = Math.hypot(a, b) || 1;
        const dx = a / scale, dy = b / scale, h = item.height || scale;
        const rx = x + dx * item.width, ry = y + dy * item.width;
        const corners = [[x, y], [rx, ry], [x - dy * h, y + dx * h], [rx - dy * h, ry + dx * h]];
        add(item.str, [Math.min(...corners.map(point => point[0])), Math.min(...corners.map(point => point[1])),
          Math.max(...corners.map(point => point[0])), Math.max(...corners.map(point => point[1]))], item.hasEOL);
      }
      if (!runs.length) for (const word of state.ocrWords ?? await savedOcr(this.book, state.n) ?? []) add(word.text, word.rect, false);
      signal.throwIfAborted();
      const locator = { v: 1 as const, type: "pdf" as const, hash: this.book.hash, page: state.n, y: 0 };
      if (!runs.length) { yield { text: "", locator, missing: true }; continue; }
      let offset = 0;
      if (initial?.page === state.n) {
        const match = initial.quote && findQuote(text, initial.quote);
        if (match) offset = match.start;
        else {
          const rect = initial.regions?.find(region => region.page === state.n)?.rects[0];
          const y = rect ? viewportRect(state.viewport, rect)[1]
            : initial.point ? state.viewport.convertToViewportPoint(...initial.point)[1] : initial.y * state.viewport.height;
          const first = runs.find(run => viewportRect(state.viewport, run.rect)[3] >= y - 6);
          offset = first?.start ?? text.length;
        }
      }
      for (const sentence of narrationSentences(text, offset)) {
        signal.throwIfAborted();
        const rects = runs.filter(run => run.start < sentence.end && run.end > sentence.start).map(run => {
          const [left, bottom, right, top] = run.rect;
          if (right - left < top - bottom) return run.rect;
          const size = run.end - run.start;
          return [left + (right - left) * Math.max(0, sentence.start - run.start) / size, bottom,
            left + (right - left) * Math.min(size, sentence.end - run.start) / size, top] as Rect;
        });
        yield { text: sentence.text, locator: { ...locator, regions: [{ page: state.n, rects }],
          quote: quoteAt(text, sentence.start, sentence.end) } };
      }
    }
  }
  configure(p: Preferences) {
    const key = JSON.stringify([p, this.host.closest<HTMLElement>(".reader-shell")?.dataset.originalPdfColors]);
    if (key === this.preferenceKey) return;
    this.preferenceKey = key;
    this.clearSurfaces();
    this.effect = p.pageTurnEffect ?? "curl";
    this.turn.invalidate();
    this.host.dataset.theme = p.theme;
    const next = p.pdfLayout || defaultPdfLayout;
    if (JSON.stringify(next) !== JSON.stringify(this.requestedLayout)) {
      this.requestedLayout = { ...next };
      if (!this.pages.length) { this.layout = { ...next }; if (this.view) this.view.target.layout = this.layout; }
      else void this.setView(this.zoomController?.target() ?? this.zoom, this.view?.target.rotation ?? this.rotation).catch(e => this.events.onError(e.message));
    }
  }

  annotate(marks: Annotation[]) {
    if (JSON.stringify(marks) === JSON.stringify(this.marks)) return;
    this.turn.invalidate();
    this.clearSurfaces();
    this.marks = marks;
    this.pages.forEach((p) => {
      if (p.loaded) this.drawPage(p);
      else
        p.noteButton.textContent = `Page ${p.n} · ${marks.some((a) => a.type === "page-note" && a.locator.type === "pdf" && a.locator.page === p.n) ? "Open note" : "Add note"}`;
    });
  }
  configureInk(strokes: InkStroke[], drawing: boolean, style: InkStyle) {
    if (this.drawing && !drawing) this.inkLayers.forEach(layer => layer.binding.flush());
    const changed = JSON.stringify(strokes) !== JSON.stringify(this.ink);
    if (drawing !== this.drawing) { this.clearSelection(); this.turn.invalidate(); }
    this.drawing = drawing; this.inkStyle = style; this.ink = strokes;
    this.host.classList.toggle("drawing-mode", drawing);
    if (changed) { this.clearSurfaces(); this.turn.invalidate(); }
    this.pages.filter(p => p.loaded).forEach(p => this.drawInk(p));
  }
  configureTextBoxes(boxes: PdfTextBox[], active: boolean, editing?: string) {
    const changed = boxes !== this.textBoxes;
    if (!changed && active === this.textBoxMode && editing === this.editingBox) return;
    this.textBoxMode = active;
    this.host.classList.toggle("pdf-text-box-mode", active);
    const stoppedEditing = this.editingBox && !editing;
    this.editingBox = editing;
    if (changed) {
      this.textBoxes = boxes;
      this.textBoxesByPage.clear();
      for (const box of boxes) {
        if (!validPdfTextBox(box) || !belongsToPdf(box, this.book)) continue;
        const group = this.textBoxesByPage.get(box.page) || [];
        group.push(box);
        this.textBoxesByPage.set(box.page, group);
      }
    }
    this.clearSurfaces();
    this.turn.invalidate();
    for (const state of this.pages) if (state.loaded) this.drawTextBoxes(state);
    if (stoppedEditing) this.resizeToHost();
  }
  textBoxSurface(page = this.current) {
    const state = this.pages[page - 1];
    if (!state || state.element.hidden) return;
    const { element, viewport } = state;
    if (state.page.view.length !== 4) return;
    return { element, viewport, bounds: state.page.view as Rect,
      ready: state.loaded && !this.layingOut && this.host.getAttribute("aria-busy") !== "true" && !this.host.classList.contains("pdf-zooming") };
  }
  async prepareTextBoxSurface(page: number) {
    const state = this.pages[page - 1];
    if (!state) return;
    let pending: Promise<void>;
    do {
      pending = this.viewQueue;
      await pending;
      if (this.disposed || state.element.hidden) return;
      if (pending === this.viewQueue) await this.render(state);
    } while (!this.disposed && pending !== this.viewQueue);
    const surface = this.textBoxSurface(page);
    return surface?.ready ? surface : undefined;
  }
  private drawTextBoxes(state: PageState) {
    const boxes = this.textBoxesByPage.get(state.n);
    let layer = state.element.querySelector<HTMLElement>(".pdf-text-box-layer");
    if (!boxes?.length) { layer?.remove(); return; }
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "pdf-text-box-layer";
      state.element.append(layer);
    }
    const surface = document.createDocumentFragment();
    for (const box of boxes) {
      if (box.id === this.editingBox) continue;
      const element = document.createElement("button");
      element.type = "button";
      element.className = "pdf-text-box";
      element.dataset.textBoxId = box.id;
      element.setAttribute("aria-label", "Edit text box: " + box.text.slice(0, 80));
      const { lines } = layoutBoxText(box);
      Object.assign(element.style, {
        width: box.width + "px", height: box.height + "px", transform: boxTransform(box, state.viewport),
        background: boxPaper(box), color: boxInk(box), padding: boxPadding + "px",
        font: boxFont(box, true), textDecoration: box.underline ? "underline" : "none",
      });
      element.textContent = lines.join("\n");
      surface.append(element);
    }
    layer.replaceChildren(surface);
  }
  async undoInk(redo = false) { await this.inkHistory.move(redo); }
  async retryInk() { await this.inkHistory.retry(); this.pages.filter(p => p.loaded).forEach(p => this.drawInk(p)); }
  allInk() { return this.inkHistory.visible(this.ink); }
  hasUnsavedInk() { return this.inkHistory.pending.size > 0; }
  private drawInk(state: PageState) {
    let layer = this.inkLayers.get(state.n);
    if (!layer && !this.drawing && !this.allInk().some(s => s.target.type === "pdf" && s.target.page === state.n)) return;
    if (layer && !state.element.contains(layer.svg)) { layer.binding.destroy(); this.inkLayers.delete(state.n); layer = undefined; }
    if (!layer) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("pdf-ink-layer"); svg.setAttribute("aria-label", `Drawings on page ${state.n}`);
      state.element.append(svg);
      const binding = bindInkSurface(svg, {
        target: { type: "pdf", bookId: this.book.id, hash: this.book.hash, page: state.n },
        history: this.inkHistory, strokes: () => this.allInk(), style: () => this.inkStyle, enabled: () => this.drawing && !this.layingOut && this.host.getAttribute("aria-busy") !== "true" && !this.host.classList.contains("pdf-zooming"),
        project: (x, y) => state.viewport.convertToViewportPoint(x, y), unproject: (x, y) => state.viewport.convertToPdfPoint(x, y),
        commit: (stroke, deleted) => this.inkHistory.perform(stroke, deleted), error: message => this.events.onError(message),
      });
      layer = { svg, binding }; this.inkLayers.set(state.n, layer);
    }
    layer.svg.setAttribute("viewBox", `0 0 ${state.viewport.width} ${state.viewport.height}`);
    layer.svg.setAttribute("preserveAspectRatio", "none");
    layer.svg.setAttribute("aria-hidden", String(!this.drawing && !this.allInk().some(s => s.target.type === "pdf" && s.target.page === state.n)));
    if (!this.drawing) layer.binding.cancel();
    layer.binding.paint();
  }
  hasSelection() {
    const selection = document.getSelection();
    return !!this.touch?.hasSelection() || !!(selection && !selection.isCollapsed && this.host.contains(selection.anchorNode) && selection.toString().trim());
  }
  clearSelection() {
    this.host.querySelector(".pdf-image-selection")?.remove();
    this.touch?.clear();
    const selection = document.getSelection();
    if (selection && this.host.contains(selection.anchorNode)) selection.removeAllRanges();
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
    clearTimeout(this.cropTimer);
    this.inkLayers.forEach(layer => layer.binding.flush());
    this.inkLayers.forEach(layer => layer.binding.destroy()); this.inkLayers.clear();
    this.turn.destroy(); this.clearSurfaces();
    this.disposed = true;
    this.view?.destroy();
    for (const name of ["touchstart", "touchend", "touchcancel"] as const) this.host.removeEventListener(name, this.touchPause, true);
    clearTimeout(this.renderTimer); this.renderQueue.clear();
    this.host.removeAttribute("aria-busy");
    this.zoomController?.destroy();
    clearTimeout(this.autoOcrTimer); clearTimeout(this.deferredOcrTimer); this.deferredOcr.clear();
    document.removeEventListener("visibilitychange", this.scheduleRecognition);
    this.touch?.destroy();
    this.ocr.destroy();
    clearTimeout(this.timer);
    this.observer?.disconnect();
    this.resizeObserver?.disconnect();
    this.unbindNativeSelection?.();
    this.host.removeEventListener("scroll", this.onScroll);
    this.host.removeEventListener("contextmenu", this.imageMenu);
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
    this.host.classList.remove("pdf-reader", "region-mode", "drawing-mode");
  }
}
