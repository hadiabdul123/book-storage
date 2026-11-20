import { ReadingPointerControls, useReadingPointer } from "./ReadingPointer";
import { bindPageSwipes } from "./reader/swipes";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { PenLine } from "lucide-react";
import { defaultInkStyle } from "./inkTypes";
const InkToolbar = lazy(() => import("./InkToolbar").then(m => ({ default: m.InkToolbar })));
import { useLiveQuery } from "dexie-react-hooks";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  List,
  Search,
  Highlighter,
  Settings2,
  X,
  Maximize2,
  RotateCw,
  Scan,
  Download,
  NotebookPen,
  BookA,
  ZoomIn,
  ZoomOut,
  MoreHorizontal,
  Sparkles,
  BookOpen,
  Headphones,
  Type,
} from "lucide-react";
import { PdfTextBoxTool } from "./PdfTextBoxTool";
import { belongsToPdf, fitPdfTextBox, layoutBoxText, validPdfTextBox, type BoxRotation, type PdfTextBox } from "./pdfTextBoxes";
import type { PdfReader } from "./reader/pdf";
import { comfortablePreferences } from "./readingAppearance";
import { useReaderViewport } from "./useReaderViewport";
import { useReaderFullscreen } from "./useReaderFullscreen";
import { db, get, list, save } from "./db";
import {
  defaults,
  type Annotation,
  type Locator,
  type Preferences,
  type Position,
  deviceId,
  now,
  uid,
  defaultPdfLayout,
  type PdfLayout,
} from "./model";
import { downloadBook } from "./sync";
import type { ReaderAdapter, SearchHit, Section } from "./reader/types";
import { AnnotationCard, EditAnnotation, messageOf } from "./components";
import { exportAnnotations } from "./export";
import { highlightStudyData } from "./highlightStudy";
import { PageNotebook, type NotebookHandle } from "./PageNotebook";
import { Meaning } from "./Meaning";
import { ResearchPanel } from "./ResearchPanel";
import type { SourceRef } from "./researchTypes";
import type { Selection as ReaderSelection } from "./reader/types";
import { validLocator } from "./validation";
import { pdfPageCountKey, savePageCache } from "./pdfText";
import { knownAuthor, readingProgress } from "./readingProgress";
import { ReaderContents } from "./ReaderContents";
import "./research.css";
import { pageNoteId, savePageNote } from "./pageNotes";
import { emptyDocument, paragraph } from "./richText";
import "./notebooks.css";
import "./readerChrome.css";
import { useReaderChrome } from "./useReaderChrome";
import {
  readDeviceReading,
  queueDeviceReading as writeDeviceReading,
  flushDeviceReading,
  devicePdfLayout,
  initializeDeviceReading,
  type DeviceReading,
} from "./deviceReading";
import {
  ReaderInteractions,
  type InteractionHandle,
} from "./ReaderInteractions";
const ReadAlong = lazy(() => import("./ReadAlong").then(module => ({ default: module.ReadAlong })));
const noTextBoxes: PdfTextBox[] = [];

export function Reader({ notify }: { notify: (message: string) => void }) {
  const { id = "" } = useParams(),
    [params] = useSearchParams();
  const book = useLiveQuery(() => get("book", id), [id]);
  const ink = useLiveQuery(async () => (await list("ink-stroke")).filter(s => s.target.type === "pdf" && s.target.bookId === id), [id]) || [];
  const [drawing, setDrawing] = useState(false);
  const textBoxes = useLiveQuery(async () => (await list("pdf-text-box")).filter(box => box.bookId === id), [id]) || noTextBoxes;
  const [textBoxMode, setTextBoxMode] = useState(false);
  const [textBoxDraft, setTextBoxDraft] = useState<PdfTextBox>();
  const [editingSavedBox, setEditingSavedBox] = useState(false);
  const [savingBox, setSavingBox] = useState(false);
  const pendingBoxPlacement = useRef<object | undefined>(undefined);
  const [placingBox, setPlacingBox] = useState(false);
  const [, setTextBoxLayout] = useState(0);
  const [inkStyle, setInkStyle] = useState(defaultInkStyle);
  const annotations =
    useLiveQuery(
      async () => (await list("annotation")).filter((a) => a.bookId === id),
      [id],
    ) || [];
  const bookmarks =
    useLiveQuery(
      async () => (await list("bookmark")).filter((a) => a.bookId === id),
      [id],
    ) || [];
  const savedPrefs = useLiveQuery(() => get("preferences", "reader"), [], null);
  useEffect(() => {
    if (savedPrefs === null || savedPrefs?.comfortDefaultsVersion) return;
    void db.transaction("rw", [db.rows, db.outbox, db.conflicts, db.meta], async () => {
      const latest = await get("preferences", "reader");
      if (!latest?.comfortDefaultsVersion) await save("preferences", comfortablePreferences(latest));
    }).catch(error => notify(messageOf(error)));
  }, [savedPrefs]);
  const pdfPrefs = useLiveQuery(() => get("preferences", `pdf:${id}`), [id]);
  const localView = useLiveQuery(() => readDeviceReading(id), [id]);
  const [settingsSaveError, setSettingsSaveError] = useState(false);
  const [optimisticView, setOptimisticView] = useState<DeviceReading>({});
  const effectiveView = { ...localView, ...optimisticView };
  useEffect(() => { setOptimisticView({}); return () => { void flushDeviceReading(id); }; }, [id]);
  useEffect(() => {
    if (!localView) return;
    setOptimisticView(prior => {
      const next = { ...prior }; let changed = false;
      for (const key of Object.keys(next) as (keyof DeviceReading)[]) if (JSON.stringify(next[key]) === JSON.stringify(localView[key])) { delete next[key]; changed = true; }
      return changed ? next : prior;
    });
  }, [localView]);
  const [pdfOriginalColors, setPdfOriginalColors] = useState(false);
  useEffect(() => setPdfOriginalColors(!!effectiveView.pdfOriginalColors), [id, effectiveView.pdfOriginalColors]);
  const toggleOriginalColors = (enabled: boolean) => {
    setPdfOriginalColors(enabled); setOptimisticView(prior => ({ ...prior, pdfOriginalColors: enabled }));
    void writeDeviceReading(id, { pdfOriginalColors: enabled }).catch(error => {
      setSettingsSaveError(true);
      notify(messageOf(error));
    });
  };
  const [swipeToTurn, setSwipeToTurn] = useState(false);
  const [hidePageControls, setHidePageControls] = useState(false);
  useEffect(() => setHidePageControls(!!effectiveView.hidePageControls), [id, effectiveView.hidePageControls]);
  const togglePageControls = (hidden: boolean) => {
    setHidePageControls(hidden); setOptimisticView(prior => ({ ...prior, hidePageControls: hidden }));
    void writeDeviceReading(id, { hidePageControls: hidden }).catch(error => {
      setSettingsSaveError(true);
      notify(messageOf(error));
    });
  };
  const { narrow: phone, touch } = useReaderViewport();
  const pdfLayout = devicePdfLayout(effectiveView, pdfPrefs?.pdfLayout, phone);
  const prefs = {
    ...comfortablePreferences(savedPrefs || undefined),
    ...effectiveView,
    width: effectiveView.width ?? savedPrefs?.width ?? defaults.width,
    flow:
      effectiveView.flow ??
      (phone ? "scrolled" : savedPrefs?.flow) ??
      defaults.flow,
    spread:
      effectiveView.spread ??
      (phone ? false : savedPrefs?.spread) ??
      defaults.spread,
    pdfLayout,
    pageTurnEffect: effectiveView.pageTurnEffect ?? "curl",
  };
  const paginated = book?.format === "pdf" ? pdfLayout.navigation === "paginated" : prefs.flow === "paginated";
  useEffect(() => setSwipeToTurn(effectiveView.swipeToTurn ?? paginated), [id, effectiveView.swipeToTurn, paginated]);
  const shell = useRef<HTMLElement>(null);
  const fullscreen = useReaderFullscreen(shell, notify);
  const [quietFullscreen, setQuietFullscreen] = useState(false);
  const remotePosition = useLiveQuery(() => get("position", id), [id]);
  const [offeredPosition, setOfferedPosition] = useState<Position>();
  const seenPosition = useRef("");
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      if (viewport?.scale === 1)
        shell.current?.style.setProperty(
          "--reader-height",
          `${viewport.height}px`,
        );
    };
    resize();
    viewport?.addEventListener("resize", resize);
    return () => viewport?.removeEventListener("resize", resize);
  }, [book?.id]);
  const notebook = useRef<NotebookHandle | null>(null);
  const [notebookPage, setNotebookPage] = useState(1),
    [pinned, setPinned] = useState(false),
    [notebookQuery, setNotebookQuery] = useState("");
  const [meaningTerm, setMeaningTerm] = useState(""),
    [meaningPage, setMeaningPage] = useState(1),
    [layoutFallback, setLayoutFallback] = useState(false);
  const [researchSelection, setResearchSelection] = useState<SourceRef>();
  const [listenStart, setListenStart] = useState<{ locator?: Locator; selected: boolean }>();
  const [listenHost, setListenHost] = useState<HTMLElement | null>(null);
  const interactions = useRef<InteractionHandle | null>(null);
  const [actionsHost, setActionsHost] = useState<HTMLElement | null>(null);
  const [secondaryActionsHost, setSecondaryActionsHost] = useState<HTMLElement | null>(null);
  const openNotebookRef = useRef<(page: number) => void>(() => {});
  async function flushNotebook() {
    if (textBoxDraft) { notify("Save or cancel the text box first."); return false; }
    return (await notebook.current?.flush()) ?? true;
  }
  function closeTextBoxes() {
    pendingBoxPlacement.current = undefined;
    setPlacingBox(false);
    setTextBoxDraft(undefined);
    setEditingSavedBox(false);
    setTextBoxMode(false);
  }
  async function placeTextBox(page?: number, point?: { x: number; y: number }, existingId?: string) {
    if (!book || book.format !== "pdf" || textBoxDraft || pendingBoxPlacement.current) return;
    const pdf = adapter.current as PdfReader | null;
    const initial = pdf?.textBoxSurface(page);
    if (!pdf || !initial) return;
    const pageNumber = Number(initial.element.dataset.page);
    const anchor = (surface: typeof initial, at?: { x: number; y: number }) => {
      const { element, viewport } = surface;
      const rect = element.getBoundingClientRect(), readerRect = host.current!.getBoundingClientRect();
      const x = at?.x ?? (Math.max(rect.left, readerRect.left) + Math.min(rect.right, readerRect.right)) / 2;
      const y = at?.y ?? (Math.max(rect.top, readerRect.top) + Math.min(rect.bottom, readerRect.bottom)) / 2;
      return viewport.convertToPdfPoint((x - rect.left) * viewport.width / rect.width,
        (y - rect.top) * viewport.height / rect.height);
    };
    const clicked = point && anchor(initial, point);
    let surface: typeof initial | undefined = initial;
    if (!initial.ready) {
      const request = {};
      pendingBoxPlacement.current = request;
      setPlacingBox(true);
      try {
        surface = await pdf.prepareTextBoxSurface(pageNumber);
        if (pendingBoxPlacement.current !== request || pdf !== adapter.current) return;
      } catch (cause) {
        if (pendingBoxPlacement.current === request) notify(messageOf(cause));
        return;
      } finally {
        if (pendingBoxPlacement.current === request) {
          pendingBoxPlacement.current = undefined;
          setPlacingBox(false);
        }
      }
    }
    if (!surface?.ready) { notify("The PDF page is not ready for a text box."); return; }
    const existing = existingId && textBoxes.find(box => box.id === existingId && belongsToPdf(box, book));
    if (existing) { setEditingSavedBox(true); setTextBoxDraft(existing); return; }
    if (existingId) { notify("This text box is no longer available."); return; }
    const { viewport } = surface;
    const [pdfX, pdfY] = clicked || anchor(surface);
    const stamp = now();
    setEditingSavedBox(false);
    setTextBoxDraft(fitPdfTextBox({
      id: uid(), bookId: book.id, hash: book.hash, page: pageNumber,
      x: pdfX, y: pdfY, width: 214, height: 82, rotation: viewport.rotation as BoxRotation,
      text: "", fontSize: 16, tint: false, createdAt: stamp, updatedAt: stamp,
    }, viewport.viewBox as import("./model").Rect));
  }
  async function storeTextBox(remove = false) {
    if (!textBoxDraft || savingBox) return;
    const box = { ...textBoxDraft, text: textBoxDraft.text.trimEnd(), updatedAt: now() };
    if (!remove) {
      if (!validPdfTextBox(box)) { notify("Enter some text to save this box."); return; }
      const layout = layoutBoxText(box);
      if (!layout.widthFits || layout.height > box.height) {
        notify("Resize the box or reduce the text size so all the text fits.");
        return;
      }
    }
    setSavingBox(true);
    try {
      await db.transaction("rw", db.rows, db.outbox, db.conflicts, db.meta, async () => {
        if (editingSavedBox && !(await get("pdf-text-box", box.id))) throw new Error("This text box was removed on another device.");
        await save("pdf-text-box", box, remove);
      });
      closeTextBoxes();
    } catch (cause) { notify(messageOf(cause)); }
    finally { setSavingBox(false); }
  }
  async function downloadMarkedPdf() {
    if (!book || book.format !== "pdf") return;
    try {
      const strokes = (adapter.current as PdfReader | null)?.allInk() || ink;
      notify("Preparing marked PDF…");
      const { exportMarkedPdf } = await import("./inkExport");
      await exportMarkedPdf(book, strokes, await list("pdf-text-box"));
      notify("Marked PDF downloaded.");
    } catch (cause) { notify(messageOf(cause)); }
  }
  async function toggleTextBoxes() {
    if (textBoxMode) {
      if (!textBoxDraft) closeTextBoxes();
      else notify("Save or cancel the text box first.");
      return;
    }
    if (!(await flushNotebook())) return;
    interactions.current?.dismiss();
    const pdf = adapter.current as PdfReader | null;
    pdf?.setRegionMode(false);
    pdf?.clearSelection();
    setPanel(""); setDrawing(false); setRegion(false);
    chrome.setMenu(false); setTextBoxMode(true);
  }
  async function openListen(selection?: ReaderSelection) {
    if (!adapter.current || loading || !(await flushNotebook())) return;
    setListenStart({ locator: selection?.locator ?? current ?? remotePosition?.locator, selected: !!selection });
    interactions.current?.dismiss();
    adapter.current.clearSelection();
    closeTextBoxes(); setDrawing(false); setRegion(false); setPanel("listen"); chrome.setMenu(false);
  }
  async function changePanel(name: string) {
    if (await flushNotebook()) {
      closeTextBoxes();
      setDrawing(false);
      setPanel(name);
      chrome.setMenu(false);
    }
  }
  async function openResearch(selection: ReaderSelection) {
    if (!book || !(await flushNotebook())) return;
    try {
      const context = await adapter.current?.context(selection) || selection.text;
      setResearchSelection({ id: "selection", kind: "book", title: book.title, bookId: book.id,
        locator: { ...selection.locator, quote: selection.locator.quote || { exact: selection.text, prefix: "", suffix: "" } }, excerpt: context.slice(0, 2400) });
      setPanel("research"); chrome.setMenu(false);
    } catch (e) { notify(messageOf(e)); }
  }
  async function openNotebook(page: number, hold = false) {
    if (!(await flushNotebook())) return;
    closeTextBoxes();
    setNotebookPage(page);
    setPinned(hold);
    setPanel("page-notes");
    chrome.setMenu(false);
  }
  openNotebookRef.current = (page) => void openNotebook(page, true);
  const host = useRef<HTMLDivElement>(null),
    adapter = useRef<ReaderAdapter | null>(null),
    position = useRef<Position | null>(null),
    annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [openFailed, setOpenFailed] = useState(false),
    [opened, setOpened] = useState(false),
    [loadAttempt, setLoadAttempt] = useState(0),
    [panel, setPanel] = useState(""),
    [sections, setSections] = useState<Section[]>(),
    [editing, setEditing] = useState<Annotation>(),
    [progress, setProgress] = useState(0),
    [current, setCurrent] = useState<Locator>(),
    [pdfPageCount, setPdfPageCount] = useState<number>(),
    [query, setQuery] = useState(""),
    [hits, setHits] = useState<SearchHit[]>([]),
    [searching, setSearching] = useState(false),
    [zoom, setZoom] = useState(1),
    [rotation, setRotation] = useState(0),
    [region, setRegion] = useState(false),
    [ready, setReady] = useState(0),
    [jumped, setJumped] = useState(false);
  const backgroundAllowed = useRef(false);
  const backgroundBlocked = useRef(true);
  backgroundBlocked.current = loading || !!panel || !!editing || region || drawing || textBoxMode;
  backgroundAllowed.current = !backgroundBlocked.current;
  const chrome = useReaderChrome(
    shell,
    host,
    ready,
    !!panel || !!editing || region || drawing || textBoxMode,
    fullscreen.active || quietFullscreen,
  );
  const wasFullscreen = useRef(false);
  useEffect(() => {
    if (wasFullscreen.current && !fullscreen.active) { setQuietFullscreen(false); chrome.reveal(); }
    wasFullscreen.current = fullscreen.active;
  }, [fullscreen.active]);
  const readingPointer = useReadingPointer(host, book?.format === "pdf" && opened && !loading, ready, notify);
  const swipeEnabled =
    swipeToTurn &&
    !loading &&
    !panel &&
    !editing &&
    !region &&
    !drawing &&
    !textBoxMode &&
    (book?.format === "pdf"
      ? pdfLayout.navigation === "paginated" && zoom <= 1
      : book?.format === "epub" && prefs.flow === "paginated");
  const swipe = useRef({ enabled: false, turning: false });
  swipe.current.enabled = swipeEnabled;
  const canSwipe = () =>
    swipe.current.enabled && touch && !adapter.current?.hasSelection() && !host.current?.dataset.pageTurning &&
    !shell.current?.querySelector(".passage-popup,.pdf-selection-handle") &&
    (host.current?.scrollWidth || 0) <= (host.current?.clientWidth || 0) + 4;
  const dragAllowed = useRef(false);
  dragAllowed.current = swipeEnabled;
  const canDragTurn = () => dragAllowed.current && !adapter.current?.hasSelection() && !shell.current?.querySelector(".passage-popup,.pdf-selection-handle") &&
    (host.current?.scrollWidth || 0) <= (host.current?.clientWidth || 0) + 4;
  const turnSwipe = (direction: "next" | "previous") => {
    // A new gesture may start during the preceding animation; decide on release.
    if (!canSwipe() || swipe.current.turning) return;
    swipe.current.turning = true;
    void adapter.current?.[direction]()
      .catch((e) => notify(messageOf(e)))
      .finally(() => {
        swipe.current.turning = false;
      });
  };
  useEffect(() => {
    if (host.current) return bindPageSwipes(host.current, canSwipe, turnSwipe);
  }, [ready]);
  const chromeRef = useRef(chrome);
  chromeRef.current = chrome;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  useEffect(() => {
    if (!book || !host.current) return;
    let cancelled = false,
      restoring = true,
      saveTimer: ReturnType<typeof setTimeout> | undefined,
      reader: ReaderAdapter | undefined;
    let lastActive = Date.now(),
      intervalStart = Date.now();
    const flush = () => {
      const value = position.current;
      if (value && !restoring) {
        void save("position", value).catch((e) =>
          notifyRef.current(messageOf(e)),
        );
      }
    };
    const activity = () => {
      lastActive = Date.now();
    };
    const recordTime = () => {
      const end = Date.now();
      if (
        !restoring &&
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        lastActive > intervalStart - 60000
      ) {
        void save("session", {
          id: uid(),
          bookId: id,
          start: intervalStart,
          end,
          device: deviceId(),
        }).catch(() => {});
      }
      intervalStart = end;
    };
    const visibility = () => {
      flush();
      recordTime();
    };
    const start = async () => {
      setLoading(true);
      setOpenFailed(false);
      setOpened(false);
      setOfferedPosition(undefined);
      position.current = null;
      setError("");
      setCurrent(undefined);
      setPdfPageCount(undefined);
      setSections(undefined);
      setListenStart(undefined);
      const [files, oldView, shared, legacy, stored] = await Promise.all([
        downloadBook(book), readDeviceReading(id), get("preferences", "reader"), get("preferences", `pdf:${id}`), get("position", id),
      ]);
      if (cancelled) return;
      const view = await initializeDeviceReading(id, { ...comfortablePreferences(shared),
        flow: phone ? "scrolled" : shared?.flow ?? defaults.flow,
        spread: phone ? false : shared?.spread ?? defaults.spread,
        pdfLayout: devicePdfLayout(oldView, legacy?.pdfLayout, phone),
        ...oldView,
      });
      const initialPrefs = { ...comfortablePreferences(shared),
        ...view,
        width: view.width ?? shared?.width ?? defaults.width,
        flow: view.flow ?? (phone ? "scrolled" : shared?.flow) ?? defaults.flow,
        spread: view.spread ?? (phone ? false : shared?.spread) ?? defaults.spread,
        pdfLayout: devicePdfLayout(view, legacy?.pdfLayout, phone), pageTurnEffect: view.pageTurnEffect ?? "curl" as const,
      };
      const ctor =
        book.format === "epub"
          ? (await import("./reader/epub")).EpubReader
          : book.format === "pdf"
            ? (await import("./reader/pdf")).PdfReader
            : (await import("./reader/docx")).DocxReader;
      if (cancelled) return;
      reader = new ctor(host.current!, book, {
        onShortcut: (event) => interactions.current?.shortcut(event),
        onReaderTap: () => chromeRef.current.tap(),
        onZoom: (value) => {
          if (cancelled) return;
          setZoom(value);
          void writeDeviceReading(id, { zoom: value }).catch(e => notifyRef.current(messageOf(e)));
        },
        canSwipe,
        canPrepare: () => backgroundAllowed.current && Date.now() - lastActive > 1000,
        canDragTurn,
        canEdgeTurn: () => !backgroundBlocked.current && !adapter.current?.hasSelection() &&
          !shell.current?.querySelector(".passage-popup,.pdf-selection-handle"),
        onReaderSwipe: turnSwipe,
        onPageNote: (page) => openNotebookRef.current(page),
        onRegionMode: setRegion,
        onLayoutFallback: setLayoutFallback,
        onTextBoxLayout: () => setTextBoxLayout(version => version + 1),
        onPageCount: (count) => {
          if (cancelled) return;
          setPdfPageCount(count);
          void savePageCache(book, [{ key: pdfPageCountKey(book.hash), value: String(count) }]).catch(() => {});
        },
        onLocation: (locator, percentage) => {
          if (cancelled) return;
          setCurrent(locator);
          setProgress(Math.max(0, Math.min(1, percentage)));
          if (restoring) return;
          position.current = {
            id,
            bookId: id,
            locator,
            progress: Math.max(0, Math.min(1, percentage)),
            readAt: now(),
            device: deviceId(),
          };
          clearTimeout(saveTimer);
          saveTimer = setTimeout(flush, 650);
        },
        onSelection: (value, source) => {
          interactions.current?.select(value, source);
          activity();
        },
        onSelectionInteraction: (adjusting) => interactions.current?.adjusting(adjusting),
        onMouseSelection: (dragging) => interactions.current?.mouseSelecting(dragging),
        onAnnotation: (markId) => {
          const mark = annotationsRef.current.find((a) => a.id === markId);
          if (mark?.type === "page-note" && mark.locator.type === "pdf")
            openNotebookRef.current(mark.locator.page);
          else interactions.current?.openAnnotation(markId);
        },
        onError: (message) => setError(message),
      });
      adapter.current = reader;
      reader.configure(initialPrefs);
      if (book.format === "pdf") {
        setZoom(view.zoom || 1); setRotation(view.rotation || 0);
        (reader as import("./reader/pdf").PdfReader).restoreInitialView(view.zoom || 1, view.rotation || 0, stored?.locator);
      }
      await reader.open(files.source, files.derived);
      if (cancelled) return;
      reader.annotate(annotationsRef.current);
      void reader.sections().then(items => { if (!cancelled) setSections(items); })
        .catch(() => { if (!cancelled) setSections([]); });
      const target = params.get("annotation");
      const mark = target ? await get("annotation", target) : undefined;
      try {
        if (mark && mark.bookId === id) {
          await reader.goTo(mark.locator);
          if (mark.type === "page-note" && mark.locator.type === "pdf")
            openNotebookRef.current(mark.locator.page);
        } else if (stored) await reader.goTo(stored.locator);
      } catch (e) {
        setError(messageOf(e));
      }
      if (stored) position.current = stored;
      seenPosition.current = stored?.readAt || "";
      restoring = false;
      setOpened(true);
      setLoading(false);
      setReady((v) => v + 1);
      if (book.status === "unread") await db.transaction("rw", db.rows, db.outbox, db.conflicts, db.meta, async () => {
        const latest = await get("book", book.id);
        if (latest?.status === "unread") await save("book", { ...latest, status: "reading" });
      });
    };
    void start().catch((e) => {
      if (!cancelled) {
        setError(messageOf(e));
        setOpenFailed(true);
        setLoading(false);
      }
    });
    const sessionTimer = setInterval(recordTime, 15000);
    window.addEventListener("pagehide", visibility);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pointerdown", activity);
    window.addEventListener("keydown", activity);
    window.addEventListener("wheel", activity, { passive: true });
    return () => {
      flush();
      recordTime();
      cancelled = true;
      clearTimeout(saveTimer);
      clearInterval(sessionTimer);
      reader?.destroy();
      adapter.current = null;
      window.removeEventListener("pagehide", visibility);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
      window.removeEventListener("wheel", activity);
    };
  }, [book?.id, book?.hash, loadAttempt]);
  useEffect(() => {
    adapter.current?.annotate(annotations);
  }, [annotations, ready]);
  useEffect(() => {
    if (book?.format === "pdf" && opened) (adapter.current as import("./reader/pdf").PdfReader)?.configureInk(ink, drawing, inkStyle);
  }, [ink, drawing, inkStyle, ready, opened]);
  useEffect(() => {
    if (book?.format === "pdf" && opened)
      (adapter.current as PdfReader | null)?.configureTextBoxes(textBoxes, textBoxMode, textBoxDraft?.id);
  }, [textBoxes, textBoxMode, textBoxDraft?.id, ready, opened]);
  useEffect(() => { setDrawing(false); closeTextBoxes(); }, [id]);
  useEffect(() => {
    if (opened && book?.preparedTextPath) void downloadBook(book).catch(() => {});
  }, [opened, book?.preparedTextPath]);
  const sourceParam = params.get("source");
  useEffect(() => {
    if (!opened || !sourceParam || !book) return;
    try {
      const locator: unknown = JSON.parse(sourceParam);
      if (!validLocator(locator) || locator.hash !== book.hash) throw new Error("This source belongs to another edition.");
      void adapter.current?.goTo(locator).catch(e => notify(messageOf(e)));
    } catch (e) { notify(messageOf(e)); }
  }, [sourceParam, opened, book?.hash]);
  useEffect(() => {
    if (opened && savedPrefs !== null && localView !== undefined) adapter.current?.configure(prefs);
  }, [savedPrefs, pdfPrefs, localView, optimisticView, ready, phone, opened]);
  useEffect(() => {
    if (
      opened &&
      !loading &&
      remotePosition &&
      remotePosition.device !== deviceId() &&
      remotePosition.readAt > seenPosition.current &&
      remotePosition.readAt > (position.current?.readAt || "")
    ) {
      seenPosition.current = remotePosition.readAt;
      setOfferedPosition(remotePosition);
    }
  }, [remotePosition, loading, opened]);
  useEffect(() => {
    if (
      panel === "page-notes" &&
      !pinned &&
      current?.type === "pdf" &&
      current.page !== notebookPage
    )
      void openNotebook(current.page);
  }, [current?.type === "pdf" ? current.page : 0, pinned, panel]);
  async function configurePdf(patch: Partial<PdfLayout>) {
    setSettingsSaveError(false);
    setOptimisticView(prior => ({ ...prior, pdfLayout: { ...pdfLayout, ...prior.pdfLayout, ...patch } }));
    try {
      await writeDeviceReading(id, prior => ({ pdfLayout: { ...devicePdfLayout(prior, pdfPrefs?.pdfLayout, phone), ...patch } }));
    } catch (e) {
      setSettingsSaveError(true);
      notify(messageOf(e));
    }
  }
  async function configure(patch: Partial<Preferences>) {
    setSettingsSaveError(false);
    setOptimisticView(prior => ({ ...prior, ...patch }));
    try {
      await writeDeviceReading(id, patch);
    } catch (e) {
      setSettingsSaveError(true);
      notify(messageOf(e));
    }
  }
  async function goTo(locator: Locator | string) {
    try {
      if (!(await flushNotebook())) return;
      await adapter.current?.goTo(locator);
      setJumped(true);
      setTimeout(() => setJumped(false), 1400);
      setPanel("");
    } catch (e) {
      notify(messageOf(e));
    }
  }
  async function setPdfView(z: number, r: number) {
    setZoom(z);
    setRotation(r);
    void writeDeviceReading(id, { zoom: z, rotation: r }).catch(e => notify(messageOf(e)));
    try {
      if (r === rotation) {
        (adapter.current as import("./reader/pdf").PdfReader)?.requestZoom(z);
        return;
      }
      await (adapter.current as import("./reader/pdf").PdfReader)?.setView(
        z,
        r,
      );
    } catch (e) {
      notify(messageOf(e));
    }
  }
  if (book === undefined)
    return (
      <div className="reader-missing">
        <Link to="/">← Library</Link>
        <p>Loading book… If it has been removed, return to your library.</p>
      </div>
    );
  const tools = [
    ["contents", List, "Contents"],
    ["search", Search, "Search book"],
    ["notes", Highlighter, "Highlights and notes"],
    ["research", Sparkles, "Research book"],
    ["settings", Settings2, "Reading settings"],
  ] as const;
  const reading = readingProgress(book, current ?? remotePosition?.locator,
    current ? progress : remotePosition?.progress, pdfPageCount);
  const locationLabel = reading.pageLabel ?? `${reading.percent}% complete`;
  const author = knownAuthor(book.author);
  return (
    <main
      ref={shell}
      className={`reader-shell theme-${prefs.theme}${drawing ? " drawing-active" : ""}${textBoxMode ? " pdf-text-box-active" : ""}${chrome.visible ? " controls-visible" : " reading-mode"}${chrome.menu ? " controls-menu-open" : ""}${swipeEnabled ? " swipe-pages" : ""}${hidePageControls ? " hide-page-controls" : ""}${panel ? " panel-open" : ""}`}
      data-original-pdf-colors={pdfOriginalColors}
      data-loading={loading || savedPrefs === null || localView === undefined}
      onPointerMoveCapture={(event) => {
        if (
          event.pointerType === "mouse" &&
          event.clientY <=
            (shell.current?.getBoundingClientRect().top || 0) + 28
        )
          chrome.reveal();
      }}
      onClickCapture={(event) => {
        const target = event.target as HTMLElement;
        const page = textBoxMode && target.closest<HTMLElement>(".reader-host .pdf-page");
        if (page && !target.closest(".pdf-text-box-edit,button,a,input,textarea,select")) {
          event.preventDefault();
          void placeTextBox(Number(page.dataset.page), { x: event.clientX, y: event.clientY },
            target.closest<HTMLElement>("[data-text-box-id]")?.dataset.textBoxId);
          return;
        }
        const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>(
          'a[href^="#/"]',
        );
        if (anchor && (notebook.current || textBoxDraft)) {
          event.preventDefault();
          const href = anchor.getAttribute("href")!;
          void flushNotebook().then((ok) => {
            if (ok) location.hash = href;
          });
        }
      }}
      onKeyDownCapture={event => {
        if (!textBoxMode || (event.key !== "Enter" && event.key !== " ")) return;
        const target = (event.target as HTMLElement).closest<HTMLElement>("[data-text-box-id]");
        if (!target) return;
        event.preventDefault();
        void placeTextBox(Number(target.closest<HTMLElement>(".pdf-page")?.dataset.page), undefined, target.dataset.textBoxId);
      }}
    >
      <button
        className="reader-reveal"
        aria-label="Show reading controls"
        onFocus={chrome.reveal}
        onClick={() => {
          interactions.current?.dismiss();
          chrome.reveal();
        }}
        onPointerLeave={chrome.leave}
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") chrome.reveal();
        }}
      >
        Show reading controls
      </button>
      {opened && offeredPosition && (
        <div className="resume-reading" role="status">
          <span>
            A newer reading position is available from your other device.
          </span>
          <button
            className="text-button"
            onClick={async () => {
              await goTo(offeredPosition.locator);
              setOfferedPosition(undefined);
            }}
          >
            Resume there
          </button>
          <button
            className="text-button"
            onClick={() => setOfferedPosition(undefined)}
          >
            Stay here
          </button>
        </div>
      )}
      <header
        className="reader-header"
        onPointerDownCapture={chrome.reveal}
        onPointerEnter={chrome.reveal}
        onPointerLeave={chrome.leave}
      >
        <Link to="/" className="icon-button" aria-label="Back to library">
          <ArrowLeft size={21} />
        </Link>
        <div className="reader-title">
          <strong>{book.title}</strong>
          <div className="reader-byline">
            {author && <span className="reader-author">{author}</span>}
            <span className="reader-location">{locationLabel}</span>
          </div>
        </div>
        <button className="icon-button" aria-label="Contents" aria-pressed={panel === "contents"}
          onClick={() => void changePanel(panel === "contents" ? "" : "contents")}><List size={20} /></button>
        <div className="reader-action-buttons" ref={setActionsHost} />
        {book.format === "pdf" && <>
          <button className="icon-button" aria-label="Draw on PDF" aria-pressed={drawing} disabled={loading} onClick={async () => { if (!(await flushNotebook())) return; closeTextBoxes(); interactions.current?.dismiss(); adapter.current?.clearSelection(); (adapter.current as PdfReader)?.setRegionMode(false); setPanel(""); setRegion(false); setDrawing(!drawing); chrome.reveal(); }}><PenLine size={20} /></button>
          <button className="icon-button reader-text-box-direct" aria-label="Text box" title="Text box" aria-pressed={textBoxMode} disabled={loading} onClick={() => void toggleTextBoxes()}><Type size={20} /></button>
        </>}
        <button className="icon-button" aria-label="Reading settings" aria-pressed={panel === "settings"}
          onClick={() => void changePanel(panel === "settings" ? "" : "settings")}><Settings2 size={20} /></button>
        <button
          className="icon-button reader-menu-toggle"
          aria-label="Reading tools"
          aria-expanded={chrome.menu}
          onClick={() => chrome.setMenu(!chrome.menu)}
        >
          <MoreHorizontal size={22} />
        </button>
        <div className="reader-tools">
          {book.format === "pdf" && <button className="icon-button reader-text-box-overflow" aria-label="Text box" title="Text box" aria-pressed={textBoxMode} disabled={loading} onClick={() => void toggleTextBoxes()}><Type size={20} /></button>}
          {tools.filter(([name]) => name !== "contents" && name !== "settings").map(([name, Icon, label]) => (
            <button
              className={`icon-button ${panel === name ? "active" : ""}`}
              key={name}
              aria-label={label}
              aria-pressed={panel === name}
              onClick={() => void changePanel(panel === name ? "" : name)}
            >
              <Icon size={20} />
            </button>
          ))}
          <button className="icon-button" aria-label="Listen" title="Listen" aria-pressed={panel === "listen"} disabled={loading}
            onClick={() => { if (panel === "listen") void changePanel(""); else void openListen(); }}><Headphones size={20} /></button>
          <div className="reader-history-controls" ref={setSecondaryActionsHost} />
          <button className="text-button reading-mode-action" aria-label="Reading mode"
            onClick={async () => {
              if (!(await flushNotebook())) return;
              interactions.current?.dismiss();
              adapter.current?.clearSelection();
              if (region && book.format === "pdf")
                (adapter.current as import("./reader/pdf").PdfReader)?.setRegionMode(false);
              setRegion(false);
              setPanel("");
              closeTextBoxes();
              chrome.setPinned(false);
              if (shell.current?.contains(document.activeElement)) (document.activeElement as HTMLElement)?.blur();
              chrome.conceal();
            }}><BookOpen size={20} /><span>Reading mode</span></button>
          {book.format === "pdf" && (
            <button
              className={`icon-button ${panel === "page-notes" ? "active" : ""}`}
              aria-label="Page notes"
              aria-pressed={panel === "page-notes"}
              onClick={() =>
                void (panel === "page-notes"
                  ? changePanel("")
                  : openNotebook(current?.type === "pdf" ? current.page : 1))
              }
            >
              <NotebookPen size={20} />
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Dictionary"
            onClick={() => {
              setMeaningPage(current?.type === "pdf" ? current.page : 1);
              void changePanel("meaning");
            }}
          >
            <BookA size={20} />
          </button>
          <button
            className="icon-button"
            aria-label={fullscreen.active || quietFullscreen ? "Exit fullscreen reading" : "Enter fullscreen reading"}
            aria-pressed={fullscreen.active}
            onClick={() => {
              if (textBoxDraft) { notify("Save or cancel the text box first."); return; }
              closeTextBoxes();
              if (fullscreen.active) { void fullscreen.exit(); return; }
              if (quietFullscreen) { setQuietFullscreen(false); chrome.reveal(); return; }
              const request = fullscreen.enter();
              void request.then(async () => {
                if (!(await flushNotebook())) return;
                interactions.current?.dismiss(); adapter.current?.clearSelection();
                if (region && book.format === "pdf") (adapter.current as import("./reader/pdf").PdfReader)?.setRegionMode(false);
                setRegion(false); setPanel(""); setQuietFullscreen(true);
                if (shell.current?.contains(document.activeElement)) (document.activeElement as HTMLElement)?.blur();
                chrome.conceal();
              });
            }}
          >
            <Maximize2 size={19} />
          </button>
        </div>
      </header>
      {drawing && <Suspense fallback={<div className="ink-toolbar" role="status">Opening drawing tools…</div>}><InkToolbar style={inkStyle} change={setInkStyle}
        undo={() => void (adapter.current as import("./reader/pdf").PdfReader)?.undoInk().catch(e => notify(messageOf(e)))}
        redo={() => void (adapter.current as import("./reader/pdf").PdfReader)?.undoInk(true).catch(e => notify(messageOf(e)))}
        close={() => setDrawing(false)} exportPdf={() => void downloadMarkedPdf()} /></Suspense>}
      {textBoxMode && <PdfTextBoxTool draft={textBoxDraft}
        surface={textBoxDraft ? (adapter.current as PdfReader | null)?.textBoxSurface(textBoxDraft.page) : undefined}
        saved={editingSavedBox} saving={savingBox} placing={placingBox} update={setTextBoxDraft}
        place={() => void placeTextBox()} save={() => void storeTextBox()} remove={() => void storeTextBox(true)}
        exportPdf={() => void downloadMarkedPdf()} cancel={closeTextBoxes} />}
      <div className="reader-workspace">
        {panel && <button className="reader-panel-backdrop" aria-label="Close reading panel"
          onClick={() => void changePanel("")} />}
        <div
          className="reading-column"
          style={{
            maxWidth: book.format === "pdf" ? "none" : prefs.width + 100,
          }}
        >
          {loading && (
            <div className="reader-loading" role="status">
              <span className="spinner" />
              Opening your book…
            </div>
          )}
          {error && (
            <div className="reader-error" role="alert">
              <span>{error}</span>
              {book.format === "pdf" && (adapter.current as import("./reader/pdf").PdfReader)?.hasUnsavedInk() && <button className="text-button" onClick={() => void (adapter.current as import("./reader/pdf").PdfReader).retryInk().then(() => setError(""), e => setError(messageOf(e)))}>Retry saving drawings</button>}
              {openFailed && (
                <button
                  className="secondary"
                  disabled={loading}
                  onClick={() => {
                    setLoading(true);
                    setLoadAttempt(value => value + 1);
                  }}
                >
                  Retry opening book
                </button>
              )}
              <button
                aria-label="Dismiss error"
                className="icon-button"
                onClick={() => setError("")}
              >
                <X size={18} />
              </button>
            </div>
          )}
          <div
            ref={host}
            className={`reader-host ${book.format === "pdf" ? "pdf-reader" : book.format === "docx" ? "docx-reader" : ""} ${region ? "region-mode" : ""} ${jumped ? "passage-arrived" : ""}`}
            aria-label="Book content"
            tabIndex={0}
          />
        </div>
        {panel && (
          <aside className={`reader-panel ${panel === "research" ? "research-reader-panel" : ""}`}>
            <header>
              <h2>
                {
                  {
                    contents: "Contents",
                    search: "Search this book",
                    notes: "Your annotations",
                    settings: "Reading settings",
                    "page-notes": "Page notebooks",
                    meaning: "Meaning",
                    research: "Research",
                    listen: "Listen",
                  }[panel]
                }
              </h2>
              <button
                aria-label="Close panel"
                className="icon-button"
                onClick={() => void changePanel("")}
              >
                <X size={19} />
              </button>
            </header>
            <div className="panel-body">
              {panel === "listen" && <div ref={setListenHost} />}
              {panel === "research" && <ResearchPanel book={book} selection={researchSelection} />}
              {panel === "page-notes" && book.format === "pdf" && (
                <>
                  <label className="notebook-search">
                    Search this book’s notes
                    <input
                      aria-label="Search page notes"
                      placeholder="Words, tags, or page number"
                      value={notebookQuery}
                      onChange={(e) => setNotebookQuery(e.target.value)}
                    />
                  </label>
                  {notebookQuery && (
                    <div className="notebook-results">
                      {annotations
                        .filter(
                          (a) =>
                            a.type === "page-note" &&
                            a.locator.type === "pdf" &&
                            `${a.locator.page} ${a.note} ${a.tags.join(" ")}`
                              .toLowerCase()
                              .includes(notebookQuery.toLowerCase()),
                        )
                        .map((a) => (
                          <button
                            key={a.id}
                            className="search-result"
                            onClick={async () => {
                              if (!(await flushNotebook())) return;
                              await adapter.current?.goTo(a.locator);
                              if (a.locator.type === "pdf") {
                                await openNotebook(a.locator.page);
                                setNotebookQuery("");
                              }
                            }}
                          >
                            <strong>{a.text}</strong>
                            <span>{a.note.slice(0, 150)}</span>
                          </button>
                        ))}
                    </div>
                  )}
                  {pinned && (
                    <button
                      className="text-button"
                      onClick={async () => {
                        if (await flushNotebook()) {
                          setPinned(false);
                          if (current?.type === "pdf")
                            await openNotebook(current.page);
                        }
                      }}
                    >
                      Follow current page
                    </button>
                  )}
                  <PageNotebook
                    key={`${id}:${notebookPage}`}
                    book={book}
                    page={notebookPage}
                    handle={notebook}
                    onPinned={setPinned}
                    onDeleted={() => {
                      setPanel("");
                      notify("Page notebook moved to trash.");
                    }}
                  />
                </>
              )}
              {panel === "meaning" && (
                <Meaning
                  term={meaningTerm}
                  onAdd={
                    book.format === "pdf"
                      ? async (text) => {
                          if (!(await flushNotebook()))
                            throw new Error("Save the current notebook first.");
                          const prior = await get(
                            "annotation",
                            pageNoteId(book.id, meaningPage),
                          );
                          const document =
                            prior?.content?.document || emptyDocument();
                          await savePageNote(book, meaningPage, {
                            type: "doc",
                            content: [
                              ...(document.content || []),
                              paragraph(text),
                            ],
                          });
                          await openNotebook(meaningPage);
                          notify("Definition added to your page notebook.");
                        }
                      : undefined
                  }
                />
              )}
              {panel === "contents" && (
                <>
                  <ReaderContents sections={sections || []} position={current ?? remotePosition?.locator}
                    label={locationLabel} pages={pdfPageCount} loading={sections === undefined} onGoTo={target => void goTo(target)} />
                  <h3>Bookmarks</h3>
                  {bookmarks.length ? (
                    bookmarks.map((b) => (
                      <div className="bookmark-row" key={b.id}>
                        <button
                          className="text-button"
                          onClick={() => void goTo(b.locator)}
                        >
                          {b.label}
                        </button>
                        <button
                          aria-label={`Remove ${b.label}`}
                          className="icon-button"
                          onClick={() =>
                            void interactions.current
                              ?.removeBookmark(b)
                              .catch((e) => notify(messageOf(e)))
                          }
                        >
                          <X size={15} />
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="muted">
                      Save a place using the bookmark button.
                    </p>
                  )}
                </>
              )}
              {panel === "search" && (
                <>
                  <form
                    className="reader-search"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      setSearching(true);
                      try {
                        setHits((await adapter.current?.search(query)) || []);
                      } catch (e) {
                        notify(messageOf(e));
                      } finally {
                        setSearching(false);
                      }
                    }}
                  >
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Find a word or phrase"
                      autoFocus
                      aria-label="Search text"
                    />
                    <button
                      className="primary"
                      disabled={searching || !query.trim()}
                      aria-label="Find"
                    >
                      <Search size={18} />
                    </button>
                  </form>
                  <p className="muted">
                    {searching ? "Searching…" : `${hits.length} results`}
                  </p>
                  {hits.map((hit, i) => (
                    <button
                      key={i}
                      className="search-result"
                      onClick={() => void goTo(hit.locator)}
                    >
                      {hit.label}
                    </button>
                  ))}
                </>
              )}
              {panel === "notes" && (
                <>
                  <div className="panel-actions">
                    <span>{annotations.length} saved</span>
                    <button
                      className="text-button"
                      onClick={async () =>
                        exportAnnotations(annotations, [book], "md", [], await highlightStudyData())
                      }
                    >
                      <Download size={15} />
                      Export
                    </button>
                  </div>
                  {annotations.length ? (
                    annotations.map((a) => (
                      <AnnotationCard
                        key={a.id}
                        annotation={a}
                        onEdit={() =>
                          a.type === "page-note" && a.locator.type === "pdf"
                            ? void openNotebook(a.locator.page)
                            : setEditing(a)
                        }
                        onOpen={async () => {
                          await goTo(a.locator);
                          if (
                            a.type === "page-note" &&
                            a.locator.type === "pdf"
                          )
                            await openNotebook(a.locator.page);
                        }}
                      />
                    ))
                  ) : (
                    <p className="muted">
                      Select a passage to highlight it and add your thoughts.
                    </p>
                  )}
                </>
              )}
              {panel === "settings" && (
                <>
                  {settingsSaveError && <button className="secondary" onClick={() => { void writeDeviceReading(id, { ...effectiveView, zoom, rotation }).then(() => setSettingsSaveError(false), e => notify(messageOf(e))); }}>Retry saving settings</button>}
                    <p className="muted" role="status">Changes apply to all books on this device.</p>
                  <label className="pin-controls">
                    <input
                      type="checkbox"
                      checked={chrome.pinned}
                      onChange={(e) => chrome.setPinned(e.target.checked)}
                    />{" "}
                    Keep controls visible on this device
                  </label>
                  <label className="pin-controls">
                    <input type="checkbox" checked={hidePageControls}
                      onChange={event => togglePageControls(event.target.checked)} />
                    Hide bottom page controls
                  </label>
                  <h3 className="reading-settings-heading">Comfort</h3>
                  <p className="muted">Tap the page to show or hide controls. Hold a passage to select it.</p>
                  {(book.format === "pdf" || book.format === "epub") && (
                      <>
                        <label>Page-turn effect
                          <select aria-label="Page-turn effect" value={prefs.pageTurnEffect} onChange={event => void configure({ pageTurnEffect: event.target.value as "curl" | "none" })}>
                            <option value="curl">Paper curl</option>
                            <option value="none">Instant</option>
                          </select>
                        </label>
                        <label className="pin-controls">
                          <input
                            type="checkbox"
                            checked={swipeToTurn}
                            onChange={(e) => {
                              const enabled = e.target.checked;
                              setSwipeToTurn(enabled); setOptimisticView(prior => ({ ...prior, swipeToTurn: enabled }));
                              void writeDeviceReading(id, prior => ({
                                swipeToTurn: enabled,
                                ...(book.format === "pdf"
                                  ? {
                                      pdfLayout: {
                                        ...devicePdfLayout(prior, pdfPrefs?.pdfLayout, phone),
                                        navigation: enabled
                                          ? "paginated"
                                          : "continuous",
                                        fit: enabled ? "page" : "width",
                                      },
                                    }
                                  : {
                                      flow: enabled ? "paginated" : "scrolled",
                                    }),
                              })).catch((error) => {
                                setSettingsSaveError(true);
                                notify(messageOf(error));
                              });
                            }}
                          />
                          Swipe to turn pages
                        </label>
                        <p className="muted">
                          Grab an outer edge or corner to fold the page. Hold to
                          pause, then continue or drag back to cancel. The middle
                          stays available for selecting text. Zoomed PDFs can be panned.
                        </p>
                      </>
                    )}
                  <fieldset className="reading-theme-settings">
                    <legend>Page theme</legend>
                    <div className="theme-options">
                      {(["light", "sepia", "dark"] as const).map((theme) => (
                        <button
                          key={theme}
                          className={`theme-choice ${theme} ${prefs.theme === theme ? "selected" : ""}`}
                          aria-pressed={prefs.theme === theme}
                          onClick={() => void configure({ theme })}
                        >
                          {{ light: "Original", sepia: "Warm paper", dark: "Dark" }[theme]}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  {book.format === "pdf" && <>
                    <label className="pin-controls"><input type="checkbox" checked={pdfOriginalColors}
                      onChange={event => toggleOriginalColors(event.target.checked)} />
                      Original PDF colors
                    </label>
                    <p className="muted">Page themes also change picture and diagram colors. Use original PDF colors when color accuracy matters.</p>
                  </>}
                  <h3 className="reading-settings-heading">Page layout</h3>
                  {book.format !== "pdf" && (
                    <>
                      <label>
                        Typeface
                        <select
                          value={prefs.font}
                          onChange={(e) =>
                            void configure({
                              font: e.target.value as Preferences["font"],
                            })
                          }
                        >
                          <option>Literata</option>
                          <option>Source Sans 3</option>
                        </select>
                      </label>
                      <label>
                        Text size <span>{prefs.fontSize}px</span>
                        <input
                          type="range"
                          min="14"
                          max="36"
                          value={prefs.fontSize}
                          onChange={(e) =>
                            void configure({ fontSize: Number(e.target.value) })
                          }
                        />
                      </label>
                      <label>
                        Line spacing <span>{prefs.lineHeight}</span>
                        <input
                          type="range"
                          min="1.2"
                          max="2.4"
                          step="0.1"
                          value={prefs.lineHeight}
                          onChange={(e) =>
                            void configure({
                              lineHeight: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Reading width
                        <input
                          type="range"
                          min="440"
                          max="1100"
                          step="20"
                          value={prefs.width}
                          onChange={(e) =>
                            void configure({ width: Number(e.target.value) })
                          }
                        />
                      </label>
                      {book.format === "epub" && (
                        <>
                          <label>
                            Layout
                            <select
                              value={prefs.flow}
                              onChange={(e) =>
                                void configure({
                                  flow: e.target.value as Preferences["flow"],
                                })
                              }
                            >
                              <option value="scrolled">Scroll</option>
                              <option value="paginated">Turn pages</option>
                            </select>
                          </label>
                          <label className="checkbox-label">
                            <input
                              type="checkbox"
                              checked={prefs.spread}
                              onChange={(e) =>
                                void configure({ spread: e.target.checked })
                              }
                            />
                            Two pages on wide screens
                          </label>
                        </>
                      )}
                    </>
                  )}
                  {book.format === "pdf" && (
                    <>
                      <label>
                        Pages across
                        <select
                          value={pdfLayout.columns}
                          onChange={(event) =>
                            void configurePdf({
                              columns: Number(event.target.value) as 1 | 2,
                            })
                          }
                        >
                          <option value="1">One page</option>
                          <option value="2">Two pages</option>
                        </select>
                      </label>
                      <label>
                        Navigation
                        <select
                          value={pdfLayout.navigation}
                          onChange={(event) =>
                            void configurePdf({
                              navigation: event.target
                                .value as PdfLayout["navigation"],
                            })
                          }
                        >
                          <option value="continuous">
                            Continuous scrolling
                          </option>
                          <option value="paginated">Page turns</option>
                        </select>
                      </label>
                      <label>
                        Fit
                        <select
                          value={pdfLayout.fit}
                          onChange={(event) =>
                            void configurePdf({
                              fit: event.target.value as PdfLayout["fit"],
                            })
                          }
                        >
                          <option value="width">Fit width</option>
                          <option value="page">Fit page</option>
                        </select>
                      </label>
                      <label className="pin-controls"><input type="checkbox" checked={pdfLayout.trimMargins !== false} onChange={e => void configurePdf({ trimMargins: e.target.checked })} />Trim blank margins in two-page view</label>
                      <p className="muted">Keep two pages and use more of the screen. Turn this off for original margins.</p>
                      {layoutFallback && (
                        <p className="notice">
                          Showing one page to fit this screen. Two pages return
                          when there is more room.
                        </p>
                      )}
                      <label>
                        Zoom
                        <select
                          disabled={loading}
                          value={zoom}
                          onChange={(e) =>
                            void setPdfView(Number(e.target.value), rotation)
                          }
                        >
                          {![1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3].includes(zoom) &&
                            <option value={zoom}>{Math.round(zoom * 100)}%</option>}
                          <option value="1">100% of fit</option>
                          <option value="1.25">125%</option>
                          <option value="1.5">150%</option>
                          <option value="1.75">175%</option>
                          <option value="2">200%</option>
                          <option value="2.25">225%</option>
                          <option value="2.5">250%</option>
                          <option value="2.75">275%</option>
                          <option value="3">300%</option>
                        </select>
                      </label>
                      <p className="muted">Pinch the page, use Ctrl + mouse wheel, or press Ctrl/Cmd + plus, minus or 0. Only the PDF page zooms.</p>
                      <button
                        className="secondary"
                        disabled={loading}
                        onClick={() =>
                          void setPdfView(zoom, (rotation + 90) % 360)
                        }
                      >
                        <RotateCw size={17} />
                        Rotate page
                      </button>
                      <p className="muted">
                        PDF pages retain their original typography. Highlight
                        text or use region mode for scans and diagrams.
                      </p>
                      <button
                        className={region ? "primary" : "secondary"}
                        disabled={loading}
                        onClick={() => {
                          setRegion(!region);
                          (
                            adapter.current as import("./reader/pdf").PdfReader
                          ).setRegionMode(!region);
                          setPanel("");
                        }}
                      >
                        <Scan size={17} />
                        {region ? "Turn off region mode" : "Select a region"}
                      </button>
                    </>
                  )}
                  {book.format === "pdf" && <ReadingPointerControls {...readingPointer} />}
                  <button
                    className="text-button"
                    onClick={() => {
                      togglePageControls(false);
                      toggleOriginalColors(false);
                      void configure({ ...defaults, comfortDefaultsVersion: 1 });
                      if (book.format === "pdf")
                        void configurePdf(defaultPdfLayout);
                    }}
                  >
                    Reset reading settings
                  </button>
                </>
              )}
            </div>
          </aside>
        )}
      </div>
      {!hidePageControls && <footer
        className="reader-footer"
        onPointerDownCapture={chrome.reveal}
        onPointerEnter={chrome.reveal}
        onPointerLeave={chrome.leave}
      >
        {book.format === "pdf" && (
          <div
            className="reader-zoom-controls"
            role="group"
            aria-label="Page zoom"
          >
            <button
              className="icon-button"
              aria-label="Zoom out"
              disabled={loading || !!textBoxDraft || zoom <= 1}
              onClick={() =>
                void setPdfView(Math.max(1, zoom - 0.25), rotation)
              }
            >
              <ZoomOut size={18} />
            </button>
            <button
              className="text-button"
              aria-label="Reset page zoom"
              disabled={loading || !!textBoxDraft}
              onClick={() => void setPdfView(1, rotation)}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              className="icon-button"
              aria-label="Zoom in"
              disabled={loading || !!textBoxDraft || zoom >= 3}
              onClick={() =>
                void setPdfView(Math.min(3, zoom + 0.25), rotation)
              }
            >
              <ZoomIn size={18} />
            </button>
          </div>
        )}
        <button
          className="icon-button"
          aria-label="Previous page"
          disabled={loading || !!textBoxDraft}
          onClick={() =>
            void adapter.current?.previous().catch((e) => notify(messageOf(e)))
          }
        >
          <ChevronLeft size={22} />
        </button>
        <div className="reader-progress">
          <span>{locationLabel}</span>
          <div className="progress-line" aria-hidden="true">
            <span style={{ width: `${reading.fraction * 100}%` }} />
          </div>
        </div>
        {region && (
          <button
            className="text-button"
            onClick={() => {
              setRegion(false);
              (
                adapter.current as import("./reader/pdf").PdfReader
              ).setRegionMode(false);
            }}
          >
            End region mode
          </button>
        )}
        <button
          className="icon-button"
          aria-label="Next page"
          disabled={loading || !!textBoxDraft}
          onClick={() =>
            void adapter.current?.next().catch((e) => notify(messageOf(e)))
          }
        >
          <ChevronRight size={22} />
        </button>
      </footer>}
      {listenStart && <Suspense fallback={null}>
        <ReadAlong key={`${book.id}:${book.hash}`} book={book} adapter={adapter} host={host}
          controls={listenHost} start={listenStart.locator} selected={listenStart.selected} />
      </Suspense>}
      <ReaderInteractions
        key={book.id}
        ref={interactions}
        book={book}
        current={current}
        annotations={annotations}
        bookmarks={bookmarks}
        adapter={adapter}
        host={host}
        controls={actionsHost}
        secondaryControls={secondaryActionsHost}
        ready={!loading}
        suspended={panel !== "" || drawing}
        notify={notify}
        onResearch={openResearch}
        onListen={openListen}
        onDefinition={async (page, text) => {
          if (!(await flushNotebook()))
            throw new Error("Save the current notebook first.");
          const prior = await get("annotation", pageNoteId(book.id, page));
          const document = prior?.content?.document || emptyDocument();
          await savePageNote(book, page, {
            type: "doc",
            content: [...(document.content || []), paragraph(text)],
          });
          await openNotebook(page);
          notify("Definition added to your page notebook.");
        }}
      />
      {editing && (
        <EditAnnotation
          annotation={editing}
          onSave={(value, deleted) =>
            interactions.current!.changeAnnotation(value, deleted)
          }
          onClose={() => setEditing(undefined)}
          onDelete={(a) =>
            notify(
              "Annotation deleted. You can restore it from trash in Settings.",
            )
          }
        />
      )}
    </main>
  );
}
