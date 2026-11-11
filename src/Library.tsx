import { useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "react-router-dom";
import {
  Plus,
  Search,
  Grid2X2,
  List,
  Upload,
  ArrowRight,
  Download,
  Check,
  FolderPlus,
  Trash2,
  BookOpen,
} from "lucide-react";
import { db, get, list, save } from "./db";
import { importBook } from "./import";
import { downloadBook } from "./sync";
import { type Book, type Collection, uid } from "./model";
import { BookCard, Cover, Dialog, Empty, messageOf } from "./components";

export function Library({ notify }: { notify: (message: string) => void }) {
  const books = useLiveQuery(() => list("book"), []) || [],
    positions = useLiveQuery(() => list("position"), []) || [],
    collections = useLiveQuery(() => list("collection"), []) || [],
    members = useLiveQuery(() => list("membership"), []) || [],
    files = useLiveQuery(() => db.files.toCollection().primaryKeys(), []) || [];
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [sort, setSort] = useState("recent"),
    [layout, setLayout] = useState("grid"),
    [collection, setCollection] = useState(""),
    [importing, setImporting] = useState(""),
    [errors, setErrors] = useState<string[]>([]),
    [warnings, setWarnings] = useState<string[]>([]),
    [detail, setDetail] = useState<Book>(),
    [drag, setDrag] = useState(false),
    [newCollection, setNewCollection] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const progress = (id: string) =>
    positions.find((p) => p.bookId === id)?.progress || 0;
  const recent = [...positions]
    .sort((a, b) => b.readAt.localeCompare(a.readAt))
    .map((p) => books.find((b) => b.id === p.bookId))
    .find((b) => b && b.status !== "finished");
  const shown = useMemo(
    () =>
      books
        .filter(
          (b) =>
            (!query ||
              `${b.title} ${b.author} ${b.tags.join(" ")}`
                .toLowerCase()
                .includes(query.toLowerCase())) &&
            (filter === "all" ||
              (filter === "downloaded"
                ? files.includes(b.id)
                : b.status === filter)) &&
            (!collection ||
              members.some(
                (m) => m.bookId === b.id && m.collectionId === collection,
              )),
        )
        .sort((a, b) =>
          sort === "title"
            ? a.title.localeCompare(b.title)
            : sort === "author"
              ? a.author.localeCompare(b.author)
              : sort === "progress"
                ? progress(b.id) - progress(a.id)
                : b.addedAt.localeCompare(a.addedAt),
        ),
    [books, query, filter, collection, members, sort, positions, files],
  );
  async function importFiles(selected: FileList | File[]) {
    if (importing) return;
    setErrors([]);
    setWarnings([]);
    const failures: string[] = [];
    const notices: string[] = [];
    for (const file of Array.from(selected)) {
      setImporting(file.name);
      try {
        const result = await importBook(file);
        notices.push(...result.warnings.map((warning) => `${file.name}: ${warning}`));
      } catch (error) {
        failures.push(`${file.name}: ${messageOf(error)}`);
      }
    }
    setImporting("");
    setErrors(failures);
    setWarnings(notices);
    if (failures.length < Array.from(selected).length)
      notify("Books added to your library.");
    if (input.current) input.current.value = "";
  }
  return (
    <div
      className={`library-page ${drag ? "dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        void importFiles(e.dataTransfer.files);
      }}
    >
      <header className="page-header">
        <div>
          <p className="page-kicker">Your reading space</p>
          <h1>
            Library<span className="count">{books.length}</span>
          </h1>
        </div>
        <button
          className="primary"
          onClick={() => input.current?.click()}
          disabled={!!importing}
        >
          <Plus size={19} />
          <span>Add books</span>
        </button>
        <input
          ref={input}
          type="file"
          accept=".epub,.pdf,.docx"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void importFiles(e.target.files);
          }}
        />
      </header>
      {importing && (
        <div className="notice" role="status">
          <span className="spinner" />
          Importing {importing}…
        </div>
      )}
      {errors.length > 0 && (
        <div className="error" role="alert">
          {errors.map((e) => (
            <p key={e}>{e}</p>
          ))}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="notice" role="status" aria-label="Import warnings">
          <div>{warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>
        </div>
      )}
      {recent && !query && !collection && filter === "all" && (
        <section className="continue-reading">
          <Link to={`/read/${recent.id}`}>
            <Cover book={recent} small />
          </Link>
          <div>
            <span className="muted">Pick up where you left off</span>
            <h2>{recent.title}</h2>
            <p>{recent.author}</p>
            <div className="resume-progress">
              <div className="progress-line">
                <span style={{ width: `${progress(recent.id) * 100}%` }} />
              </div>
              <span>{Math.round(progress(recent.id) * 100)}% complete</span>
            </div>
            <Link
              className="text-button resume-button"
              to={`/read/${recent.id}`}
            >
              Continue reading <ArrowRight size={17} />
            </Link>
          </div>
          <div className="continue-decoration" aria-hidden="true">
            <BookOpen size={100} strokeWidth={0.7} />
          </div>
        </section>
      )}
      <div className="library-toolbar">
        <div className="tabs" aria-label="Filter books">
          {[
            ["all", "All books"],
            ["reading", "Reading"],
            ["unread", "Unread"],
            ["finished", "Finished"],
            ["downloaded", "Downloaded"],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setFilter(id)}
              className={filter === id ? "active" : ""}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="filter-row">
        <label className="search-field">
          <Search size={18} />
          <input
            aria-label="Search library"
            placeholder="Search books, authors, tags…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          aria-label="Collection"
          value={collection}
          onChange={(e) => setCollection(e.target.value)}
        >
          <option value="">All collections</option>
          {collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          className="icon-button"
          aria-label="New collection"
          onClick={() => setNewCollection(true)}
        >
          <FolderPlus size={19} />
        </button>
        <select
          value={sort}
          aria-label="Sort books"
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="recent">Recently added</option>
          <option value="title">Title</option>
          <option value="author">Author</option>
          <option value="progress">Progress</option>
        </select>
        <div className="view-toggle">
          <button
            aria-label="Grid view"
            aria-pressed={layout === "grid"}
            onClick={() => setLayout("grid")}
          >
            <Grid2X2 size={18} />
          </button>
          <button
            aria-label="List view"
            aria-pressed={layout === "list"}
            onClick={() => setLayout("list")}
          >
            <List size={19} />
          </button>
        </div>
      </div>
      {collection && (
        <div className="collection-heading">
          <h2>{collections.find((c) => c.id === collection)?.name}</h2>
          <button
            className="text-button danger"
            onClick={async () => {
              const c = collections.find((c) => c.id === collection);
              if (
                !c ||
                !confirm(
                  "Delete this collection? Your books will stay in the library.",
                )
              )
                return;
              try {
                for (const m of members.filter((m) => m.collectionId === c.id))
                  await save("membership", m, true);
                await save("collection", c, true);
                setCollection("");
              } catch (e) {
                notify(messageOf(e));
              }
            }}
          >
            Delete collection
          </button>
        </div>
      )}
      {!books.length ? (
        <Empty title="A little space for a lot of reading">
          <p>
            Add your first book, then make yourself at home.
            <br />
            EPUB, PDF, and Word documents are welcome.
          </p>
          <button className="primary" onClick={() => input.current?.click()}>
            <Upload size={18} />
            Choose your books
          </button>
          <small>Or drop files anywhere on this page</small>
        </Empty>
      ) : !shown.length ? (
        <Empty icon={<Search size={30} />} title="No books found">
          <p>Try another search or change your filters.</p>
        </Empty>
      ) : (
        <div className={layout === "grid" ? "books-grid" : "books-list"}>
          {shown.map((book) => (
            <BookCard
              key={book.id}
              book={book}
              progress={progress(book.id)}
              downloaded={files.includes(book.id)}
              onDetails={() => setDetail(book)}
            />
          ))}
        </div>
      )}
      {drag && (
        <div className="drop-overlay">
          <Upload size={42} />
          <h2>Drop your next read here</h2>
          <p>EPUB · PDF · DOCX</p>
        </div>
      )}
      {detail && (
        <BookDetails
          book={detail}
          collections={collections}
          onClose={() => setDetail(undefined)}
          notify={notify}
        />
      )}
      {newCollection && (
        <Dialog title="New collection" onClose={() => setNewCollection(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const name = String(
                new FormData(e.currentTarget).get("name"),
              ).trim();
              if (name) {
                try {
                  const id = uid();
                  await save("collection", { id, name });
                  setCollection(id);
                  setNewCollection(false);
                } catch (e) {
                  notify(messageOf(e));
                }
              }
            }}
          >
            <label>
              Name
              <input
                name="name"
                required
                autoFocus
                placeholder="A shelf for your ideas"
              />
            </label>
            <div className="form-actions">
              <button className="primary">Create collection</button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
function BookDetails({
  book,
  collections,
  onClose,
  notify,
}: {
  book: Book;
  collections: Collection[];
  onClose: () => void;
  notify: (m: string) => void;
}) {
  const [draft, setDraft] = useState(book),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const file = useLiveQuery(() => db.files.get(book.id), [book.id]);
  const memberships = useLiveQuery(() => list("membership"), []) || [];
  return (
    <Dialog title="Book details" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await save("book", draft);
            onClose();
          } catch (e) {
            setError(messageOf(e));
          }
        }}
      >
        <div className="details-summary">
          <Cover book={draft} small />
          <div>
            <strong>{book.format.toUpperCase()}</strong>
            <p>{(book.bytes / 1024 / 1024).toFixed(1)} MB</p>
            <small>Added {new Date(book.addedAt).toLocaleDateString()}</small>
            <label className="text-button">
              Change cover
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={async (e) => {
                  const image = e.target.files?.[0];
                  if (!image) return;
                  const url = URL.createObjectURL(image);
                  try {
                    const bitmap = await createImageBitmap(image);
                    const canvas = document.createElement("canvas");
                    canvas.width = 240;
                    canvas.height = Math.round(
                      (bitmap.height * 240) / bitmap.width,
                    );
                    canvas
                      .getContext("2d")!
                      .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                    setDraft({
                      ...draft,
                      cover: canvas.toDataURL("image/webp", 0.8),
                    });
                    bitmap.close();
                  } catch (err) {
                    setError(messageOf(err));
                  } finally {
                    URL.revokeObjectURL(url);
                  }
                }}
              />
            </label>
          </div>
        </div>
        <label>
          Title
          <input
            required
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </label>
        <label>
          Author
          <input
            value={draft.author}
            onChange={(e) => setDraft({ ...draft, author: e.target.value })}
          />
        </label>
        <label>
          Description
          <textarea
            rows={3}
            value={draft.description}
            onChange={(e) =>
              setDraft({ ...draft, description: e.target.value })
            }
          />
        </label>
        <label>
          Tags
          <input
            value={draft.tags.join(", ")}
            onChange={(e) =>
              setDraft({
                ...draft,
                tags: e.target.value.split(",").map((x) => x.trim()),
              })
            }
          />
        </label>
        <label>
          Reading status
          <select
            value={draft.status}
            onChange={(e) =>
              setDraft({ ...draft, status: e.target.value as Book["status"] })
            }
          >
            <option value="unread">Unread</option>
            <option value="reading">Reading</option>
            <option value="finished">Finished</option>
          </select>
        </label>
        {!!collections.length && (
          <fieldset>
            <legend>Collections</legend>
            {collections.map((c) => (
              <label className="checkbox-label" key={c.id}>
                <input
                  type="checkbox"
                  checked={memberships.some(
                    (m) => m.bookId === book.id && m.collectionId === c.id,
                  )}
                  onChange={async (e) => {
                    try {
                      await save(
                        "membership",
                        {
                          id: `${book.id}_${c.id}`,
                          bookId: book.id,
                          collectionId: c.id,
                        },
                        !e.target.checked,
                      );
                    } catch (err) {
                      setError(messageOf(err));
                    }
                  }}
                />
                {c.name}
              </label>
            ))}
          </fieldset>
        )}
        <div className="download-row">
          <span>
            {file ? (
              <>
                <Check size={16} />
                Available offline
              </>
            ) : (
              <>
                <Download size={16} />
                Not downloaded
              </>
            )}
          </span>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                if (file) {
                  if (!file.uploaded)
                    throw new Error(
                      "Sync this book before removing its only local copy.",
                    );
                  await db.files.delete(book.id);
                } else await downloadBook(book);
              } catch (e) {
                setError(messageOf(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Working…" : file ? "Remove download" : "Download"}
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button
            className="danger text-button"
            type="button"
            onClick={async () => {
              if (
                !confirm(
                  "Move this book to trash? You can restore it in Settings.",
                )
              )
                return;
              try {
                const latest = await get("book", book.id);
                if (latest) await save("book", latest, true);
                notify("Book moved to trash. Restore it in Settings.");
                onClose();
              } catch (e) {
                setError(messageOf(e));
              }
            }}
          >
            <Trash2 size={15} />
            Trash book
          </button>
          <button className="primary">Save changes</button>
        </div>
      </form>
    </Dialog>
  );
}
