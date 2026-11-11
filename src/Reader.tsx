import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  List,
  Search,
  Highlighter,
  BookmarkPlus,
  Settings2,
  X,
  Check,
  Maximize2,
  RotateCw,
  Scan,
  Download,
} from "lucide-react";
import { db, get, list, save } from "./db";
import {
  defaults,
  type Annotation,
  type Color,
  type Locator,
  type Preferences,
  type Position,
  colors,
  deviceId,
  now,
  uid,
} from "./model";
import { downloadBook } from "./sync";
import type {
  ReaderAdapter,
  SearchHit,
  Section,
  Selection,
} from "./reader/types";
import {
  AnnotationCard,
  ColorPicker,
  EditAnnotation,
  messageOf,
} from "./components";
import { exportAnnotations } from "./export";

export function Reader({ notify }: { notify: (message: string) => void }) {
  const { id = "" } = useParams(),
    [params] = useSearchParams();
  const book = useLiveQuery(() => get("book", id), [id]);
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
  const savedPrefs = useLiveQuery(() => get("preferences", "reader"), []);
  const prefs = savedPrefs || defaults;
  const host = useRef<HTMLDivElement>(null),
    adapter = useRef<ReaderAdapter | null>(null),
    position = useRef<Position | null>(null),
    prefsRef = useRef(prefs),
    annotationsRef = useRef(annotations);
  prefsRef.current = prefs;
  annotationsRef.current = annotations;
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [panel, setPanel] = useState(""),
    [sections, setSections] = useState<Section[]>([]),
    [selection, setSelection] = useState<Selection | null>(null),
    [color, setColor] = useState<Color>("yellow"),
    [note, setNote] = useState(""),
    [editing, setEditing] = useState<Annotation>(),
    [progress, setProgress] = useState(0),
    [current, setCurrent] = useState<Locator>(),
    [query, setQuery] = useState(""),
    [hits, setHits] = useState<SearchHit[]>([]),
    [searching, setSearching] = useState(false),
    [saving, setSaving] = useState(false),
    [zoom, setZoom] = useState(1),
    [rotation, setRotation] = useState(0),
    [region, setRegion] = useState(false),
    [ready, setReady] = useState(0),
    [jumped, setJumped] = useState(false);
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
      position.current = null;
      setError("");
      setSelection(null);
      const files = await downloadBook(book);
      if (cancelled) return;
      const ctor =
        book.format === "epub"
          ? (await import("./reader/epub")).EpubReader
          : book.format === "pdf"
            ? (await import("./reader/pdf")).PdfReader
            : (await import("./reader/docx")).DocxReader;
      if (cancelled) return;
      reader = new ctor(host.current!, book, {
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
        onSelection: (value) => {
          setSelection(value);
          activity();
        },
        onAnnotation: (markId) => {
          const mark = annotationsRef.current.find((a) => a.id === markId);
          if (mark) setEditing(mark);
        },
        onError: (message) => setError(message),
      });
      adapter.current = reader;
      reader.configure(prefsRef.current);
      await reader.open(files.source, files.derived);
      if (cancelled) return;
      reader.annotate(annotationsRef.current);
      setSections(await reader.sections());
      const stored = await get("position", id),
        target = params.get("annotation");
      const mark = target ? await get("annotation", target) : undefined;
      try {
        if (mark && mark.bookId === id) await reader.goTo(mark.locator);
        else if (stored) await reader.goTo(stored.locator);
      } catch (e) {
        setError(messageOf(e));
      }
      if (stored) position.current = stored;
      restoring = false;
      setLoading(false);
      setReady((v) => v + 1);
      if (book.status === "unread")
        await save("book", { ...book, status: "reading" });
    };
    void start().catch((e) => {
      if (!cancelled) {
        setError(messageOf(e));
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
  }, [book?.id, book?.hash]);
  useEffect(() => {
    adapter.current?.annotate(annotations);
  }, [annotations, ready]);
  useEffect(() => {
    adapter.current?.configure(prefs);
  }, [savedPrefs, ready]);
  async function configure(patch: Partial<Preferences>) {
    try {
      await save("preferences", { ...prefs, ...patch });
    } catch (e) {
      notify(messageOf(e));
    }
  }
  async function goTo(locator: Locator | string) {
    try {
      await adapter.current?.goTo(locator);
      setJumped(true);
      setTimeout(() => setJumped(false), 1400);
      setPanel("");
    } catch (e) {
      notify(messageOf(e));
    }
  }
  async function createAnnotation() {
    if (!selection || saving) return;
    setSaving(true);
    try {
      await save("annotation", {
        id: uid(),
        bookId: id,
        locator: selection.locator,
        text: selection.text,
        note,
        color,
        tags: [],
        createdAt: now(),
      });
      setSelection(null);
      setNote("");
      adapter.current?.clearSelection();
      notify("Highlight saved on this device.");
    } catch (e) {
      notify(messageOf(e));
    } finally {
      setSaving(false);
    }
  }
  async function setPdfView(z: number, r: number) {
    setZoom(z);
    setRotation(r);
    try {
      await (adapter.current as import("./reader/pdf").PdfReader)?.setView(
        z,
        r,
      );
    } catch (e) {
      notify(messageOf(e));
    }
  }
  function toc(items: Section[], depth = 0): React.ReactNode {
    return items.map((s) => (
      <div key={`${depth}-${s.id}`}>
        <button
          className="toc-item"
          style={{ paddingLeft: 16 + depth * 14 }}
          onClick={() => void goTo(s.id)}
        >
          {s.label}
        </button>
        {s.children && toc(s.children, depth + 1)}
      </div>
    ));
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
    ["settings", Settings2, "Reading settings"],
  ] as const;
  return (
    <main className={`reader-shell theme-${prefs.theme}`}>
      <header className="reader-header">
        <Link to="/" className="icon-button" aria-label="Back to library">
          <ArrowLeft size={21} />
        </Link>
        <div className="reader-title">
          <strong>{book.title}</strong>
          <span>{book.author}</span>
        </div>
        <div className="reader-tools">
          {tools.map(([name, Icon, label]) => (
            <button
              className={`icon-button ${panel === name ? "active" : ""}`}
              key={name}
              aria-label={label}
              aria-pressed={panel === name}
              onClick={() => setPanel(panel === name ? "" : name)}
            >
              <Icon size={20} />
            </button>
          ))}
          <button
            className="icon-button"
            aria-label="Add bookmark"
            disabled={!current}
            onClick={async () => {
              if (!current) return;
              try {
                await save("bookmark", {
                  id: uid(),
                  bookId: id,
                  locator: current,
                  label:
                    current.type === "pdf"
                      ? `Page ${current.page}`
                      : `${Math.round(progress * 100)}% through`,
                  createdAt: now(),
                });
                notify("Bookmark saved.");
              } catch (e) {
                notify(messageOf(e));
              }
            }}
          >
            <BookmarkPlus size={20} />
          </button>
          <button
            className="icon-button desktop-only"
            aria-label="Toggle full screen"
            onClick={() => {
              if (document.fullscreenElement) void document.exitFullscreen();
              else
                void document.documentElement
                  .requestFullscreen()
                  .catch(() =>
                    notify("Full screen is not available in this browser."),
                  );
            }}
          >
            <Maximize2 size={19} />
          </button>
        </div>
      </header>
      <div className="reader-workspace">
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
            className={`reader-host ${jumped ? "passage-arrived" : ""}`}
            aria-label="Book content"
          />
        </div>
        {panel && (
          <aside className="reader-panel">
            <header>
              <h2>
                {
                  {
                    contents: "Contents",
                    search: "Search this book",
                    notes: "Your annotations",
                    settings: "Reading settings",
                  }[panel]
                }
              </h2>
              <button
                aria-label="Close panel"
                className="icon-button"
                onClick={() => setPanel("")}
              >
                <X size={19} />
              </button>
            </header>
            <div className="panel-body">
              {panel === "contents" && (
                <>
                  <div>{toc(sections)}</div>
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
                            void save("bookmark", b, true).catch((e) =>
                              notify(messageOf(e)),
                            )
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
                      onClick={() =>
                        exportAnnotations(annotations, [book], "md")
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
                        onEdit={() => setEditing(a)}
                        onOpen={() => void goTo(a.locator)}
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
                  <label>
                    Page theme
                    <div className="theme-options">
                      {(["light", "sepia", "dark"] as const).map((theme) => (
                        <button
                          key={theme}
                          className={`theme-choice ${theme} ${prefs.theme === theme ? "selected" : ""}`}
                          onClick={() => void configure({ theme })}
                        >
                          {theme}
                        </button>
                      ))}
                    </div>
                  </label>
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
                        Page layout
                        <select
                          defaultValue="continuous"
                          onChange={(event) => {
                            void (
                              adapter.current as import("./reader/pdf").PdfReader
                            )
                              .setPageLayout(event.target.value === "single")
                              .catch((error) => notify(messageOf(error)));
                          }}
                        >
                          <option value="continuous">Continuous</option>
                          <option value="single">Single page</option>
                        </select>
                      </label>
                      <label>
                        Zoom
                        <select
                          value={zoom}
                          onChange={(e) =>
                            void setPdfView(Number(e.target.value), rotation)
                          }
                        >
                          <option value="1">Fit width</option>
                          <option value="1.25">125%</option>
                          <option value="1.5">150%</option>
                          <option value="2">200%</option>
                        </select>
                      </label>
                      <button
                        className="secondary"
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
                  <button
                    className="text-button"
                    onClick={() => void configure(defaults)}
                  >
                    Reset reading settings
                  </button>
                </>
              )}
            </div>
          </aside>
        )}
      </div>
      <footer className="reader-footer">
        <button
          className="icon-button"
          aria-label="Previous page"
          onClick={() =>
            void adapter.current?.previous().catch((e) => notify(messageOf(e)))
          }
        >
          <ChevronLeft size={22} />
        </button>
        <div className="reader-progress">
          <span>
            {current?.type === "pdf"
              ? `Page ${current.page}`
              : `${Math.round(progress * 100)}% complete`}
          </span>
          <div className="progress-line">
            <span style={{ width: `${progress * 100}%` }} />
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
          onClick={() =>
            void adapter.current?.next().catch((e) => notify(messageOf(e)))
          }
        >
          <ChevronRight size={22} />
        </button>
      </footer>
      {selection && (
        <div
          className="selection-toolbar"
          role="region"
          aria-label="Save selected passage"
        >
          <div className="selection-top">
            <ColorPicker value={color} onChange={setColor} />
            <button
              className="icon-button"
              aria-label="Cancel highlight"
              onClick={() => {
                setSelection(null);
                setNote("");
                adapter.current?.clearSelection();
              }}
            >
              <X size={18} />
            </button>
          </div>
          <p className="selection-excerpt">{selection.text}</p>
          <textarea
            aria-label="Note for selected passage"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note (optional)"
            rows={2}
          />
          <button
            className="primary"
            onClick={() => void createAnnotation()}
            disabled={saving}
          >
            <Check size={17} />
            {saving ? "Saving…" : "Save highlight"}
          </button>
        </div>
      )}
      {editing && (
        <EditAnnotation
          annotation={editing}
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
