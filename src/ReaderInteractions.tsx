import { samePassage } from "./reader/passages";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Bookmark as BookmarkIcon, Undo2, Redo2, X, Eraser, Highlighter, Sparkles, StickyNote, MoreHorizontal } from "lucide-react";
import { db } from "./db";
import {
  colors,
  now,
  uid,
  type Annotation,
  type Book,
  type Bookmark,
  type Color,
  type Locator,
} from "./model";
import type { ReaderAdapter, Selection, SelectionSource } from "./reader/types";
import { overlap, typingTarget } from "./reader/geometry";
import { ReaderHistory, type ReaderChange } from "./readerHistory";
import { Meaning } from "./Meaning";
import { validLocator } from "./validation";
import "./readerInteractions.css";

export type InteractionHandle = {
  adjusting: (active: boolean) => void;
  mouseSelecting: (active: boolean) => void;
  select: (value: Selection | null, source?: SelectionSource) => void;
  openAnnotation: (id: string) => void;
  shortcut: (event: KeyboardEvent) => void;
  dismiss: () => void;
  removeBookmark: (value: Bookmark) => Promise<void>;
  changeAnnotation: (value: Annotation, deleted?: boolean) => Promise<void>;
};
type Draft = { selection: Selection; text: string; annotationId?: string };
const selectionKey = (selection: Selection) =>
  JSON.stringify(selection.locator);
export const ReaderInteractions = forwardRef<
  InteractionHandle,
  {
    book: Book;
    current?: Locator;
    annotations: Annotation[];
    bookmarks: Bookmark[];
    adapter: RefObject<ReaderAdapter | null>;
    host: RefObject<HTMLDivElement | null>;
    controls: HTMLElement | null;
    secondaryControls: HTMLElement | null;
    suspended: boolean;
    ready: boolean;
    notify: (message: string) => void;
    onDefinition: (page: number, text: string) => Promise<void>;
    onResearch: (selection: Selection) => Promise<void>;
    onListen: (selection: Selection) => Promise<void>;
  }
>(function ReaderInteractions(
  {
    book,
    current,
    annotations,
    bookmarks,
    adapter,
    host,
    controls,
    secondaryControls,
    suspended,
    ready,
    notify,
    onDefinition,
    onResearch,
    onListen,
  },
  ref,
) {
  const history = useMemo(() => new ReaderHistory(), [book.id]);
  const [, refresh] = useState(0);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [chosen, setChosen] = useState<string>();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"tools" | "meaning" | "note" | "more" | "colors">("tools");
  const [adjusting, setAdjusting] = useState(false);
  const [mouseSelecting, setMouseSelecting] = useState(false);
  const [selectionSource, setSelectionSource] = useState<SelectionSource>();
  const [rail, setRail] = useState(false);
  useEffect(() => { setRail(false); }, [open, book.id]);
  useEffect(() => {
    const surface = host.current;
    if (!surface) return;
    const active = rail && open && !suspended;
    if (!active) { surface.classList.remove("selection-top-rail"); return; }
    const before = parseFloat(getComputedStyle(surface).paddingTop) || 0, scroll = surface.scrollTop;
    surface.classList.add("selection-top-rail");
    const delta = (parseFloat(getComputedStyle(surface).paddingTop) || 0) - before;
    surface.scrollTop = scroll;
    return () => { const top = surface.scrollTop; surface.classList.remove("selection-top-rail"); surface.scrollTop = Math.max(0, top - delta); };
  }, [rail, open, suspended, host]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draftsRef = useRef(drafts);
  const popup = useRef<HTMLDivElement>(null);
  const popupTouch = useRef<{ button: HTMLButtonElement; x: number; y: number; at: number } | undefined>(undefined);
  const [layout, setLayout] = useState<{
    left: number;
    top: number;
    maxHeight: number;
    popupTop: number;
    popupBottom: number;
    visible: boolean;
    markers: { id: string; left: number; top: number }[];
    places: string[];
  }>({
    left: 0,
    top: 0,
    maxHeight: 520,
    popupTop: 0,
    popupBottom: 0,
    visible: false,
    markers: [],
    places: [],
  });
  const latest = useRef({ selected, chosen, bookmarks, current, open });
  latest.current = { selected, chosen, bookmarks, current, open };
  const matches = selected
    ? annotations.filter(
        (a) =>
          a.type !== "page-note" &&
          adapter.current?.intersects(a.locator, selected.locator),
      )
    : [];
  const target =
    annotations.find((a) => a.id === chosen && a.type !== "page-note") ||
    (matches.length === 1 ? matches[0] : undefined);
  const ambiguous = matches.length > 1 && !target;
  useEffect(() => { if (ambiguous && open) setMode("more"); }, [ambiguous, open]);
  const key = selected ? selectionKey(selected) : "";
  const note = drafts[key]?.text ?? target?.note ?? "";
  const selectedBookmark = selected
    ? bookmarks.find(
        (b) => b.kind === "passage" && samePassage(b.locator, selected.locator),
      )
    : undefined;
  const placeBookmarks = bookmarks.filter(
    (b) =>
      b.kind !== "passage" &&
      (current?.type === "pdf"
        ? b.locator.type === "pdf" && b.locator.page === current.page
        : layout.places[0] === b.id),
  );
  const draftKey = `passage-drafts:${book.id}`;
  const updateDrafts = (next: Record<string, Draft>) => {
    draftsRef.current = next;
    setDrafts(next);
    void db.meta
      .put({ key: draftKey, value: JSON.stringify(next) })
      .catch(() =>
        notify(
          "Could not store the recovery draft. Keep this reader open until the note is saved.",
        ),
      );
  };
  useEffect(() => {
    const refreshDrafts = () => { void db.meta.get(draftKey).then(row => {
      try { const next = JSON.parse(row?.value || "{}"); draftsRef.current = next; setDrafts(next); } catch { /* Keep writing if storage is unavailable. */ }
    }); };
    window.addEventListener("leafmark-clipped", refreshDrafts);
    let active = true;
    void db.meta.get(draftKey).then((row) => {
      if (!row || !active) return;
      try {
        const parsed = JSON.parse(row.value);
        const valid = Object.fromEntries(
          Object.entries(parsed).filter(
            ([, d]: [string, any]) =>
              typeof d?.text === "string" &&
              typeof d?.selection?.text === "string" &&
              validLocator(d.selection.locator) &&
              d.selection.locator.hash === book.hash,
          ),
        );
        // Do not replace writing entered while recovery data was loading.
        const next = { ...valid, ...draftsRef.current } as Record<
          string,
          Draft
        >;
        draftsRef.current = next;
        setDrafts(next);
      } catch {}
    });
    return () => {
      active = false;
      window.removeEventListener("leafmark-clipped", refreshDrafts);
    };
  }, [draftKey]);
  const selectNow = (value: Selection | null, annotationId?: string, source?: SelectionSource) => {
    if (!value) {
      setOpen(false);
      return;
    }
    const prior = latest.current;
    const same = selectionKey(value) === (prior.selected ? selectionKey(prior.selected) : "");
    const nextChosen = annotationId ?? (same ? prior.chosen : undefined);
    if (!same || nextChosen !== prior.chosen)
      setMode("tools");
    latest.current = { ...prior, selected: value, chosen: nextChosen, open: true };
    setSelected(value);
    setChosen(nextChosen);
    setSelectionSource(source);
    if (source === "native") setRail(false);
    setOpen(true);
  };
  const selectionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const pendingSelection = useRef<{ value: Selection | null; annotationId?: string; source?: SelectionSource } | undefined>(undefined);
  const adjustingRef = useRef(false);
  const selectionInteraction = (active: boolean) => {
    if (!active && adjustingRef.current) {
      clearTimeout(selectionTimer.current);
      const latest = pendingSelection.current;
      if (latest) selectNow(latest.value, latest.annotationId, latest.source);
    }
    adjustingRef.current = active; setAdjusting(active);
  };
  const select = (value: Selection | null, annotationId?: string, source?: SelectionSource) => {
    pendingSelection.current = { value, annotationId, source };
    clearTimeout(selectionTimer.current);
    if (
      !annotationId &&
      value &&
      source !== "native" &&
      window.matchMedia("(pointer: coarse)").matches
    ) {
      selectionTimer.current = setTimeout(() => selectNow(value, annotationId, source), 180);
    } else selectNow(value, annotationId, source);
  };
  const closeSelection = () => {
    clearTimeout(selectionTimer.current);
    pendingSelection.current = undefined;
    latest.current = { ...latest.current, selected: null, chosen: undefined, open: false };
    setOpen(false); setSelected(null); setChosen(undefined); setMode("tools");
    adapter.current?.clearSelection();
  };
  useEffect(() => () => clearTimeout(selectionTimer.current), []);
  async function perform(
    label: string,
    changes: ReaderChange[],
    removed = false,
  ) {
    setBusy(true);
    try {
      await history.perform(label, changes);
      refresh((n) => n + 1);
      if (removed) notify("");
      setFeedback(removed ? label : "");
    } finally {
      setBusy(false);
    }
  }
  async function attempt(fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  }
  async function move(direction: "undo" | "redo") {
    setBusy(true);
    try {
      const label = await history.move(direction);
      if (label)
        notify(`${direction === "undo" ? "Undid" : "Redid"}: ${label}`);
      setFeedback("");
      refresh((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }
  const shortcut = (event: KeyboardEvent) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      closeSelection();
      return;
    }
    if (event.defaultPrevented || typingTarget(event.target)) return;
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.repeat)
      return;
    const direction =
      event.key.toLowerCase() === "z"
        ? event.shiftKey
          ? "redo"
          : "undo"
        : event.key.toLowerCase() === "y"
          ? "redo"
          : undefined;
    if (
      !direction ||
      !(direction === "undo"
        ? history.undoStack.length
        : history.redoStack.length)
    )
      return;
    event.preventDefault();
    void attempt(() => move(direction));
  };
  const shortcutRef = useRef(shortcut);
  shortcutRef.current = shortcut;
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => shortcutRef.current(event);
    const dismiss = (event: PointerEvent) => {
      const element = event.target as Element;
      // Native selection handles operate inside the reading surface. Do not
      // tear down the action state as a finger begins adjusting them.
      if (host.current?.contains(element)) return;
      if (
        !element.closest?.(
          ".passage-popup, .passage-bookmark, .reader-action-buttons, .reader-feedback, .pdf-selection-handle",
        )
      ) {
        closeSelection();
      }
    };
    let began: { x: number; y: number; time: number; open: boolean } | undefined;
    const touchStart = (e: PointerEvent) => {
      began = host.current?.contains(e.target as Node)
        ? { x: e.clientX, y: e.clientY, time: Date.now(), open: latest.current.open }
        : undefined;
    };
    const touchEnd = (e: PointerEvent) => {
      if (
        began &&
        began.open &&
        !(e.target as Element).closest?.(".pdf-selection-handle") &&
        Date.now() - began.time < 250 &&
        Math.hypot(e.clientX - began.x, e.clientY - began.y) < 8 &&
        document.getSelection()?.isCollapsed
      )
        closeSelection();
      began = undefined;
    };
    document.addEventListener("pointerdown", touchStart);
    document.addEventListener("pointerup", touchEnd);
    window.addEventListener("keydown", keydown);
    document.addEventListener("pointerdown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", touchStart);
      document.removeEventListener("pointerup", touchEnd);
      window.removeEventListener("keydown", keydown);
      document.removeEventListener("pointerdown", dismiss);
    };
  }, []);
  useImperativeHandle(ref, () => ({
    adjusting: selectionInteraction,
    mouseSelecting: setMouseSelecting,
    select: (value, source) => select(value, undefined, source),
    shortcut,
    dismiss: closeSelection,
    openAnnotation: (id) => {
      const a = annotations.find((a) => a.id === id);
      if (a) select({ text: a.text, locator: a.locator }, id);
    },
    removeBookmark: (b) =>
      perform(
        "Bookmark removed",
        [{ kind: "bookmark", value: b, expected: b, deleted: true }],
        true,
      ),
    changeAnnotation: (a, deleted = false) =>
      perform(
        deleted ? "Highlight removed" : "Highlight edited",
        [
          {
            kind: "annotation",
            value: a,
            expected: annotations.find((v) => v.id === a.id),
            deleted,
          },
        ],
        deleted,
      ),
  }));
  useEffect(() => {
    let frame = 0, disposed = false;
    const tick = () => {
      frame = 0;
      if (disposed || !host.current || !adapter.current) return;
      const reader = adapter.current,
        viewport = host.current.getBoundingClientRect();
      const vv = window.visualViewport;
      const clip = {
        left: Math.max(viewport.left, vv?.offsetLeft || 0),
        right: Math.min(
          viewport.right,
          (vv?.offsetLeft || 0) + (vv?.width || innerWidth),
        ),
        top: Math.max(viewport.top, vv?.offsetTop || 0),
        bottom: Math.min(
          viewport.bottom,
          (vv?.offsetTop || 0) + (vv?.height || innerHeight),
        ),
      };
      const shell = host.current.closest(".reader-shell");
      const header = shell?.querySelector<HTMLElement>(".reader-header");
      const footer = shell?.querySelector<HTMLElement>(".reader-footer");
      // Overlay controls restrict popup placement, not passage/bookmark visibility.
      let popupTop = clip.top,
        popupBottom = clip.bottom;
      if (header && getComputedStyle(header).visibility !== "hidden")
        popupTop = Math.max(
          clip.top,
          header.getBoundingClientRect().bottom + 8,
        );
      if (footer && getComputedStyle(footer).visibility !== "hidden")
        popupBottom = Math.min(
          clip.bottom,
          footer.getBoundingClientRect().top - 8,
        );
      const visible = (locator: Locator) =>
        reader.bounds(locator).filter((r) => overlap(r, clip));
      const state = latest.current;
      const rects = state.selected && !mouseSelecting ? visible(state.selected.locator) : [];
      const rect = rects.length ? { left: Math.min(...rects.map(r => r.left)), right: Math.max(...rects.map(r => r.right)), top: Math.min(...rects.map(r => r.top)), bottom: Math.max(...rects.map(r => r.bottom)) } : undefined;
      const compact = mode === "tools" || mode === "colors";
      const popupLimit = innerWidth <= 700 ? Math.min(420, innerHeight * 0.5) : 520;
      const width =
          popup.current?.offsetWidth || Math.min(360, innerWidth - 16),
        desiredHeight = Math.min(
          popupLimit,
          popup.current
            ? popup.current.scrollHeight +
                popup.current.offsetHeight -
                popup.current.clientHeight
            : 110,
        );
      const left = rect
        ? Math.max(
            8,
            Math.min(
              innerWidth - width - 8,
              (rect.left + rect.right - width) / 2,
            ),
          )
        : 8;
      const handleGap = host.current
        .closest(".reader-shell")
        ?.querySelector(".pdf-selection-handle")
        ? 48
        : 14;
      const aboveSpace = rect
          ? Math.max(0, rect.top - popupTop - handleGap)
          : 0,
        belowSpace = rect
          ? Math.max(0, popupBottom - rect.bottom - handleGap)
          : 0;
      const useRail = selectionSource === "touch" ||
        (selectionSource !== "native" && window.matchMedia("(pointer: coarse)").matches);
      if (useRail && compact && rect && aboveSpace < desiredHeight && !rail) setRail(true);
      const above = (compact && useRail) || aboveSpace >= desiredHeight ||
        (belowSpace < desiredHeight && aboveSpace > belowSpace);
      const maxHeight = Math.max(
        compact ? 56 : 80,
        Math.min(popupLimit, above ? aboveSpace : belowSpace),
      );
      // offsetHeight may still be constrained by the previous selection's
      // maxHeight. Use the natural content height for both size and position.
      const height = Math.min(desiredHeight, maxHeight);
      const top = rect
        ? Math.max(
            popupTop + 4,
            Math.min(
              popupBottom - height - 4,
              compact && useRail && rail ? popupTop + 4 : above ? rect.top - height - handleGap : rect.bottom + handleGap,
            ),
          )
        : 0;
      const markerTop =
        header && getComputedStyle(header).visibility !== "hidden"
          ? Math.max(clip.top, header.getBoundingClientRect().bottom + 8)
          : clip.top;
      const markerBottom =
        footer && getComputedStyle(footer).visibility !== "hidden"
          ? Math.min(clip.bottom, footer.getBoundingClientRect().top - 8)
          : clip.bottom;
      const markers: { id: string; left: number; top: number }[] = [],
        places: { id: string; top: number }[] = [];
      for (const b of state.bookmarks) {
        const r = visible(b.locator)[0];
        if (!r) continue;
        if (b.kind === "passage")
          markers.push({
            id: b.id,
            left: Math.max(clip.left + 2, r.left - 24),
            top: Math.max(markerTop, Math.min(markerBottom - 28, r.top)),
          });
        else places.push({ id: b.id, top: r.top });
      }
      places.sort((a, b) => a.top - b.top);
      const next = {
        left: Math.round(left),
        top: Math.round(top),
        maxHeight,
        popupTop,
        popupBottom,
        // Wait for the mounted popup to be measured before exposing buttons.
        visible: !!rect && !!popup.current,
        markers,
        places: places.map((p) => p.id),
      };
      // EPUB fonts/images can move a range between hover and pointer-down.
      // Keep the action buttons under the pointer until the click is complete;
      // expanded note/meaning views still get their own measured placement.
      setLayout((previous) => {
        // Read hover when applying the update too: a pointer may have entered since the
        // animation frame queued this update. Measuring must not steal a click.
        const holdTools =
          popup.current?.dataset.mode === "tools" &&
          (popup.current.matches(":hover") || !!popupTouch.current);
        const placed =
          holdTools &&
          previous.visible &&
          next.visible &&
          previous.popupTop === popupTop &&
          previous.popupBottom === popupBottom
            ? {
                ...next,
                left: previous.left,
                top: previous.top,
                maxHeight: previous.maxHeight,
              }
            : next;
        return JSON.stringify(previous) === JSON.stringify(placed)
          ? previous
          : placed;
      });
    };
    const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(tick); };
    const surface = host.current, shell = surface?.closest(".reader-shell");
    const resize = new ResizeObserver(schedule);
    if (surface) resize.observe(surface);
    if (shell) resize.observe(shell);
    if (popup.current) resize.observe(popup.current);
    const changes = new MutationObserver(schedule);
    if (surface) changes.observe(surface, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class", "hidden"] });
    if (shell) changes.observe(shell, { attributes: true, attributeFilter: ["class", "style"] });
    shell?.addEventListener("transitionend", schedule);
    surface?.addEventListener("scroll", schedule, { passive: true, capture: true });
    surface?.addEventListener("reader-layout", schedule);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    document.fonts.addEventListener("loadingdone", schedule);
    schedule();
    return () => {
      disposed = true; cancelAnimationFrame(frame); resize.disconnect(); changes.disconnect();
      shell?.removeEventListener("transitionend", schedule);
      surface?.removeEventListener("scroll", schedule, true); surface?.removeEventListener("reader-layout", schedule);
      window.removeEventListener("resize", schedule); window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule); document.fonts.removeEventListener("loadingdone", schedule);
    };
  }, [adapter, host, selected, bookmarks, current, open, mode, note, busy, feedback, suspended, ready, rail, adjusting, mouseSelecting, selectionSource]);
  async function colorAction(color: Color) {
    if (!selected || ambiguous) return;
    if (target) {
      const removing = color === target.color;
      await perform(
        removing ? "Highlight removed" : "Highlight recolored",
        [
          {
            kind: "annotation",
            value: { ...target, color },
            expected: target,
            deleted: removing,
          },
        ],
        removing,
      );
      if (removing) {
        setChosen(undefined);
        setOpen(false);
        adapter.current?.clearSelection();
      }
    } else {
      const a: Annotation = {
        id: uid(),
        bookId: book.id,
        locator: selected.locator,
        text: selected.text,
        note: "",
        color,
        tags: [],
        createdAt: now(),
      };
      await perform("Highlight created", [{ kind: "annotation", value: a }]);
      setChosen(a.id);
      adapter.current?.clearSelection();
      notify("Highlight saved on this device.");
    }
    if (mode === "colors") setMode("tools");
  }
  async function saveNote() {
    if (!selected || ambiguous) return;
    const a: Annotation = target
      ? { ...target, note }
      : {
          id: uid(),
          bookId: book.id,
          locator: selected.locator,
          text: selected.text,
          note,
          color: "yellow",
          tags: [],
          createdAt: now(),
        };
    await perform(target ? "Highlight note edited" : "Highlight created", [
      { kind: "annotation", value: a, expected: target },
    ]);
    const next = { ...draftsRef.current };
    delete next[key];
    updateDrafts(next);
    setChosen(a.id);
    setMode("tools");
    notify("Highlight saved on this device.");
    adapter.current?.clearSelection();
  }
  async function togglePlace() {
    if (!current) return;
    if (placeBookmarks.length)
      await perform(
        "Bookmark removed",
        placeBookmarks.map((b) => ({
          kind: "bookmark",
          value: b,
          expected: b,
          deleted: true,
        })),
        true,
      );
    else {
      const b: Bookmark = {
        id: current.type === "pdf" ? `page:${book.id}:${current.page}` : uid(),
        bookId: book.id,
        kind: "place",
        locator: current,
        label:
          current.type === "pdf"
            ? `Page ${current.page}`
            : "Saved reading place",
        createdAt: now(),
      };
      await perform("Bookmark added", [{ kind: "bookmark", value: b }]);
      notify("Bookmark saved.");
    }
  }
  async function togglePassage() {
    if (!selected) return;
    if (selectedBookmark)
      await perform(
        "Passage bookmark removed",
        [
          {
            kind: "bookmark",
            value: selectedBookmark,
            expected: selectedBookmark,
            deleted: true,
          },
        ],
        true,
      );
    else {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(selectionKey(selected)),
      );
      const fingerprint = Array.from(new Uint8Array(digest))
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 32);
      const b: Bookmark = {
        id: `passage:${book.id}:${fingerprint}`,
        kind: "passage",
        bookId: book.id,
        locator: selected.locator,
        text: selected.text,
        label: `Passage: ${selected.text.slice(0, 80)}`,
        createdAt: now(),
      };
      await perform("Passage bookmarked", [{ kind: "bookmark", value: b }]);
      notify("Passage bookmarked.");
      adapter.current?.clearSelection();
    }
  }
  return (
    <>
      {controls &&
        createPortal(
          <>
            <button
              className="icon-button"
              aria-label={
                placeBookmarks.length ? "Remove bookmark" : "Add bookmark"
              }
              title={
                current?.type === "pdf"
                  ? `${placeBookmarks.length ? "Remove bookmark for" : "Bookmark"} page ${current.page}`
                  : "Toggle reading-place bookmark"
              }
              aria-pressed={!!placeBookmarks.length}
              disabled={!current || busy}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => void attempt(togglePlace)}
            >
              <BookmarkIcon
                size={20}
                fill={placeBookmarks.length ? "currentColor" : "none"}
              />
            </button>
          </>,
          controls,
        )}
      {secondaryControls &&
        createPortal(
          <>
            <button
              className="icon-button"
              aria-label="Undo reader change"
              title="Undo (Ctrl+Z)"
              disabled={!history.undoStack.length || busy}
              onClick={() => void attempt(() => move("undo"))}
            >
              <Undo2 size={19} />
            </button>
            <button
              className="icon-button"
              aria-label="Redo reader change"
              title="Redo (Ctrl+Shift+Z)"
              disabled={!history.redoStack.length || busy}
              onClick={() => void attempt(() => move("redo"))}
            >
              <Redo2 size={19} />
            </button>
            {!!Object.keys(drafts).length && (
              <button
                className="draft-recovery text-button"
                disabled={!ready}
                onClick={() =>
                  void attempt(async () => {
                    const d = Object.values(drafts)[0];
                    await adapter.current?.goTo(d.selection.locator);
                    clearTimeout(selectionTimer.current);
                    pendingSelection.current = undefined;
                    selectNow(d.selection, d.annotationId);
                    setMode("note");
                  })
                }
              >
                Unfinished notes ({Object.keys(drafts).length})
              </button>
            )}
          </>,
          secondaryControls,
        )}
      {layout.markers.map((marker) => {
        const b = bookmarks.find((b) => b.id === marker.id);
        if (!b) return null;
        return (
          <button
            key={marker.id}
            className="passage-bookmark"
            aria-label={`Bookmarked passage: ${b.text || b.label}`}
            title="Open passage bookmark"
            style={{ left: marker.left, top: marker.top }}
            onClick={() =>
              select({ text: b.text || b.label, locator: b.locator })
            }
          >
            <BookmarkIcon size={16} fill="currentColor" />
          </button>
        );
      })}
      {selected && open && !suspended && (
        <div
          ref={popup}
          className="passage-popup"
          aria-busy={busy}
          data-mode={mode}
          role="region"
          aria-label="Save selected passage"
          onPointerDownCapture={event => {
            const button = (event.target as Element).closest("button");
            if (event.pointerType === "touch" && button && !button.disabled)
              popupTouch.current = { button, x: event.clientX, y: event.clientY, at: performance.now() };
          }}
          onPointerCancelCapture={() => { popupTouch.current = undefined; }}
          onTouchEndCapture={event => {
            const began = popupTouch.current;
            popupTouch.current = undefined;
            const touch = event.changedTouches[0];
            if (!began || !touch || event.touches.length || event.changedTouches.length !== 1 ||
                performance.now() - began.at > 350 || Math.hypot(touch.clientX - began.x, touch.clientY - began.y) > 8) return;
            // Chrome can suppress compatibility clicks while text handles are active.
            // Dispatch one deliberate tap and cancel the subsequent native click.
            event.preventDefault();
            began.button.click();
          }}
          style={{
            left: layout.left,
            top: layout.top,
            maxHeight: layout.maxHeight,
            visibility: layout.visible && !adjusting && !mouseSelecting ? "visible" : "hidden",
          }}
        >
          <div className="passage-compact-row" role="toolbar" aria-label="Passage actions">
            <button aria-label="Choose highlight color" disabled={busy} aria-expanded={mode === "colors"} onPointerDown={e => e.preventDefault()} onClick={() => setMode(mode === "colors" ? "tools" : "colors")}><Highlighter size={19} /><i style={{ background: colors[target?.color || "yellow"] }} /></button>
            <button aria-label={selectedBookmark ? "Remove passage bookmark" : "Bookmark passage"} aria-pressed={!!selectedBookmark} onPointerDown={e => e.preventDefault()} onClick={() => void attempt(togglePassage)}><BookmarkIcon size={19} fill={selectedBookmark ? "currentColor" : "none"} /></button>
            <button aria-label="Explain" title="Explain with Groq" disabled={busy || selected.text.length > 100 || selected.text.startsWith("Region on page")} onPointerDown={e => e.preventDefault()} onClick={() => setMode("meaning")}><Sparkles size={19} /></button>
            <button aria-label={target?.note ? "Edit note" : "Add note"} disabled={ambiguous} onPointerDown={e => e.preventDefault()} onClick={() => setMode(mode === "note" ? "tools" : "note")}><StickyNote size={19} /></button>
            <button aria-label="More passage actions" aria-expanded={mode === "more"} onPointerDown={e => e.preventDefault()} onClick={() => setMode(mode === "more" ? "tools" : "more")}><MoreHorizontal size={19} /></button>
          </div>
          <div className="passage-popup-top">
            <span>{target ? "Highlighted passage" : "Selected passage"}</span>
            <button
              className="icon-button"
              aria-label="Close selection tools"
              onClick={() => {
                closeSelection();
              }}
            >
              <X size={16} />
            </button>
          </div>
          <p className="selection-excerpt">{selected.text}</p>
          {ambiguous ? (
            <div className="overlap-choices">
              <p>Choose a highlight to change:</p>
              {matches.map((a) => (
                <button key={a.id} onClick={() => setChosen(a.id)}>
                  <span style={{ background: colors[a.color] }} />
                  {a.text.slice(0, 100)}
                </button>
              ))}
            </div>
          ) : (
            <div
              className="passage-colors"
              role="group"
              aria-label="Highlight colors"
            >
              {Object.entries(colors).map(([color, value]) => (
                <button
                  key={color}
                  disabled={busy}
                  style={{ background: value }}
                  aria-label={`${color} highlight`}
                  aria-pressed={target?.color === color}
                  title={
                    target?.color === color
                      ? `Remove ${color} highlight`
                      : `Highlight ${color}`
                  }
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() =>
                    void attempt(() => colorAction(color as Color))
                  }
                >
                  {target?.color === color ? "✓" : ""}
                </button>
              ))}

            </div>
          )}
          <div className="passage-actions">
            {!selected.text.startsWith("Region on page") && <button type="button" onPointerDown={e => e.preventDefault()} onClick={() => {
              if (!navigator.clipboard) { notify("Clipboard access is unavailable in this browser."); return; }
              void navigator.clipboard.writeText(selected.text).then(() => notify("Copied passage."), () => notify("Copy was blocked. Allow clipboard access and try again."));
            }}>Copy</button>}
            {!selected.text.startsWith("Region on page") &&
              selected.text.length <= 100 && (
                <button
                  aria-pressed={mode === "meaning"}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() =>
                    setMode(mode === "meaning" ? "tools" : "meaning")
                  }
                >
                  Explain
                </button>
              )}
            {!selected.text.startsWith("Region on page") && <button type="button" disabled={busy} onPointerDown={e => e.preventDefault()} onClick={() => { if (selected) void attempt(() => onResearch(selected)); }}>Research</button>}
            {!selected.text.startsWith("Region on page") && <button type="button" disabled={busy} onPointerDown={e => e.preventDefault()} onClick={() => void attempt(() => onListen(selected))}>Listen from here</button>}
            <button
              disabled={ambiguous}
              aria-pressed={mode === "note"}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => setMode(mode === "note" ? "tools" : "note")}
            >
              {target?.note ? "Edit note" : "Add note"}
            </button>
            <button
              disabled={busy}
              aria-label={selectedBookmark ? "Remove passage bookmark" : "Bookmark passage"}
              aria-pressed={!!selectedBookmark}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => void attempt(togglePassage)}
            >
              <BookmarkIcon
                size={15}
                fill={selectedBookmark ? "currentColor" : "none"}
              />
              <span className="passage-bookmark-label">{selectedBookmark ? "Unbookmark" : "Bookmark"}</span>
            </button>
            {target && (
              <button
                className="remove-highlight"
                aria-label="Remove highlight"
                title="Remove highlight"
                disabled={busy}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => void attempt(() => colorAction(target.color))}
              >
                <Eraser size={17} />
              </button>
            )}
          </div>
          {mode === "note" && (
            <div className="passage-note">
              <textarea
                autoFocus
                aria-label="Note for selected passage"
                rows={3}
                value={note}
                onChange={(e) =>
                  updateDrafts({
                    ...draftsRef.current,
                    [key]: {
                      selection: selected,
                      text: e.target.value,
                      annotationId: target?.id,
                    },
                  })
                }
              />
              <div>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void attempt(saveNote)}
                >
                  Save note
                </button>
                <button
                  className="text-button"
                  onClick={() => {
                    const next = { ...draftsRef.current };
                    delete next[key];
                    updateDrafts(next);
                    setMode("tools");
                  }}
                >
                  Discard note changes
                </button>
              </div>
            </div>
          )}
          {mode === "meaning" && (
            <Meaning
              compact
              term={selected.text}
              context={async () => ({ id: "selection", kind: "book", bookId: book.id, title: book.title, locator: selected.locator, excerpt: await adapter.current?.context(selected) || selected.text })}
              onExplain={() => { if (selected) void attempt(() => onResearch(selected)); }}
              onAdd={
                selected.locator.type === "pdf"
                  ? (text) =>
                      onDefinition(
                        selected.locator.type === "pdf"
                          ? selected.locator.page
                          : 1,
                        text,
                      )
                  : undefined
              }
            />
          )}
        </div>
      )}
      {feedback && (
        <div className="reader-feedback" role="status">
          <span>{feedback}</span>
          <button
            disabled={busy}
            onClick={() => void attempt(() => move("undo"))}
          >
            Undo
          </button>
          <button
            aria-label="Dismiss undo message"
            onClick={() => setFeedback("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
});
