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
import { Bookmark as BookmarkIcon, Undo2, Redo2, X, Eraser } from "lucide-react";
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
import type { ReaderAdapter, Selection } from "./reader/types";
import { overlap, typingTarget } from "./reader/geometry";
import { ReaderHistory, type ReaderChange } from "./readerHistory";
import { Meaning } from "./Meaning";
import { validLocator } from "./validation";
import "./readerInteractions.css";

export type InteractionHandle = {
  select: (value: Selection | null) => void;
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
    suspended: boolean;
    ready: boolean;
    notify: (message: string) => void;
    onDefinition: (page: number, text: string) => Promise<void>;
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
    suspended,
    ready,
    notify,
    onDefinition,
  },
  ref,
) {
  const history = useMemo(() => new ReaderHistory(), [book.id]);
  const [, refresh] = useState(0);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [chosen, setChosen] = useState<string>();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"tools" | "meaning" | "note">("tools");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draftsRef = useRef(drafts);
  const popup = useRef<HTMLDivElement>(null);
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
  const latest = useRef({ selected, bookmarks, current, open });
  latest.current = { selected, bookmarks, current, open };
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
    };
  }, [draftKey]);
  const selectNow = (value: Selection | null, annotationId?: string) => {
    if (!value) {
      setOpen(false);
      return;
    }
    if (
      selectionKey(value) !== (selected ? selectionKey(selected) : "") ||
      annotationId !== chosen
    )
      setMode("tools");
    setSelected(value);
    setChosen(annotationId);
    setOpen(true);
  };
  const selectionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const select = (value: Selection | null, annotationId?: string) => {
    clearTimeout(selectionTimer.current);
    if (
      !annotationId &&
      value &&
      window.matchMedia("(pointer: coarse)").matches
    ) {
      selectionTimer.current = setTimeout(() => selectNow(value), 180);
    } else selectNow(value, annotationId);
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
      setOpen(false);
      adapter.current?.clearSelection();
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
        setOpen(false);
        if (!host.current?.contains(element)) adapter.current?.clearSelection();
      }
    };
    let began: { x: number; y: number; time: number } | undefined;
    const touchStart = (e: PointerEvent) => {
      began = host.current?.contains(e.target as Node)
        ? { x: e.clientX, y: e.clientY, time: Date.now() }
        : undefined;
    };
    const touchEnd = (e: PointerEvent) => {
      if (
        began &&
        Date.now() - began.time < 250 &&
        Math.hypot(e.clientX - began.x, e.clientY - began.y) < 8 &&
        document.getSelection()?.isCollapsed
      )
        setOpen(false);
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
    select,
    shortcut,
    dismiss: () => setOpen(false),
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
    let frame = 0,
      last = 0;
    const tick = (time: number) => {
      frame = requestAnimationFrame(tick);
      if (time - last < 80 || !host.current || !adapter.current) return;
      last = time;
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
      const rect = state.selected
        ? visible(state.selected.locator)[0]
        : undefined;
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
      const above =
        aboveSpace >= desiredHeight ||
        (belowSpace < desiredHeight && aboveSpace > belowSpace);
      const maxHeight = Math.max(
        80,
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
              above ? rect.top - height - handleGap : rect.bottom + handleGap,
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
          popup.current.matches(":hover");
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
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [adapter, host]);
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
                    select(d.selection, d.annotationId);
                    setMode("note");
                  })
                }
              >
                Unfinished notes ({Object.keys(drafts).length})
              </button>
            )}
          </>,
          controls,
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
          data-mode={mode}
          role="region"
          aria-label="Save selected passage"
          style={{
            left: layout.left,
            top: layout.top,
            maxHeight: layout.maxHeight,
            visibility: layout.visible ? "visible" : "hidden",
          }}
        >
          <div className="passage-popup-top">
            <span>{target ? "Highlighted passage" : "Selected passage"}</span>
            <button
              className="icon-button"
              aria-label="Close selection tools"
              onClick={() => {
                setOpen(false);
                adapter.current?.clearSelection();
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
            {!selected.text.startsWith("Region on page") &&
              selected.text.length <= 100 && (
                <button
                  aria-pressed={mode === "meaning"}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() =>
                    setMode(mode === "meaning" ? "tools" : "meaning")
                  }
                >
                  Meaning
                </button>
              )}
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
              {selectedBookmark ? "Unbookmark" : "Bookmark"}
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
