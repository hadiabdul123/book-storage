import { useEffect, useRef, useState, type ReactNode } from "react";
import { X, BookOpen, ArrowUpRight, MoreHorizontal } from "lucide-react";
import { Link } from "react-router-dom";
import { type Annotation, type Book, type Color, colors } from "./model";
import { get, save } from "./db";
import { useLiveQuery } from "dexie-react-hooks";
import { PageNotebook, type NotebookHandle } from "./PageNotebook";
import { RichTextView } from "./RichTextView";

export const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : String((error as { message?: string })?.message || error);
export function Empty({
  icon = <BookOpen size={34} />,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      <div className="muted">{children}</div>
    </div>
  );
}
export function Dialog({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? "dialog wide" : "dialog"}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button className="icon-button" aria-label="Close" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
export function Cover({
  book,
  small = false,
}: {
  book: Book;
  small?: boolean;
}) {
  return (
    <div
      className={`cover ${small ? "small" : ""}`}
      style={
        {
          "--cover-hue": String(parseInt(book.hash.slice(0, 4), 16) % 360),
        } as React.CSSProperties
      }
    >
      {book.cover ? (
        <img src={book.cover} alt={`Cover of ${book.title}`} loading="lazy" />
      ) : (
        <div className="cover-type">
          <span>{book.author}</span>
          <strong>{book.title}</strong>
          <BookOpen size={24} />
        </div>
      )}
    </div>
  );
}
export function BookCard({
  book,
  progress,
  onDetails,
  downloaded,
}: {
  book: Book;
  progress: number;
  onDetails: () => void;
  downloaded: boolean;
}) {
  return (
    <article className="book-card">
      <Link to={`/read/${book.id}`} className="book-cover-link">
        <Cover book={book} />
        <span className="cover-read">
          Open book <ArrowUpRight size={17} />
        </span>
      </Link>
      <div className="book-card-title">
        <Link to={`/read/${book.id}`}>
          <h3>{book.title}</h3>
        </Link>
        <button
          className="icon-button"
          onClick={onDetails}
          aria-label={`Details for ${book.title}`}
        >
          <MoreHorizontal size={20} />
        </button>
      </div>
      <p>{book.author}</p>
      <div className="book-meta">
        <span>
          {book.format.toUpperCase()}
          {downloaded ? " · Downloaded" : ""}
        </span>
        <span>
          {book.status === "finished"
            ? "Finished"
            : progress > 0
              ? `${Math.round(progress * 100)}%`
              : ""}
        </span>
      </div>
      {progress > 0 && (
        <div className="progress-line">
          <span style={{ width: `${Math.min(100, progress * 100)}%` }} />
        </div>
      )}
    </article>
  );
}
export function ColorPicker({
  value,
  onChange,
}: {
  value: Color;
  onChange: (color: Color) => void;
}) {
  return (
    <div className="color-picker" role="group" aria-label="Highlight color">
      {(Object.keys(colors) as Color[]).map((color) => (
        <button
          key={color}
          type="button"
          aria-label={color}
          aria-pressed={value === color}
          className={value === color ? "swatch selected" : "swatch"}
          style={{ background: colors[color] }}
          onClick={() => onChange(color)}
        />
      ))}
    </div>
  );
}
export function AnnotationCard({
  annotation,
  book,
  onOpen,
  onEdit,
}: {
  annotation: Annotation;
  book?: Book;
  onOpen?: () => void;
  onEdit: () => void;
}) {
  return (
    <article
      className="annotation-card"
      style={
        { "--mark-color": colors[annotation.color] } as React.CSSProperties
      }
    >
      <div className="annotation-meta">
        <span>
          {book?.title ||
            (annotation.locator.type === "pdf"
              ? `Page ${annotation.locator.page}`
              : "Saved passage")}
        </span>
        <button className="text-button" onClick={onEdit}>
          Edit
        </button>
      </div>
      <blockquote>{annotation.text}</blockquote>
      {annotation.type === "page-note" && annotation.content ? (
        <RichTextView document={annotation.content.document} />
      ) : (
        annotation.note && <p className="note-text">{annotation.note}</p>
      )}
      <div className="annotation-footer">
        <span>
          {new Date(annotation.createdAt).toLocaleDateString()}
          {annotation.tags.length ? ` · ${annotation.tags.join(", ")}` : ""}
        </span>
        {onOpen ? (
          <button className="text-button" onClick={onOpen}>
            Go to passage <ArrowUpRight size={14} />
          </button>
        ) : (
          <Link
            to={`/read/${annotation.bookId}?annotation=${annotation.id}`}
            className="text-button"
          >
            Go to passage <ArrowUpRight size={14} />
          </Link>
        )}
      </div>
    </article>
  );
}
type EditProps = {
  annotation: Annotation;
  onClose: () => void;
  onDelete?: (a: Annotation) => void;
};
export function EditAnnotation(props: EditProps) {
  return props.annotation.type === "page-note" ? (
    <EditPageNotebook {...props} />
  ) : (
    <EditHighlight {...props} />
  );
}
function EditPageNotebook({ annotation, onClose, onDelete }: EditProps) {
  const book = useLiveQuery(
    () => get("book", annotation.bookId),
    [annotation.bookId],
  );
  const handle = useRef<NotebookHandle | null>(null);
  const close = async () => {
    if ((await handle.current?.flush()) ?? true) onClose();
  };
  return (
    <Dialog title="Page notebook" onClose={() => void close()}>
      {book && annotation.locator.type === "pdf" ? (
        <PageNotebook
          book={book}
          page={annotation.locator.page}
          handle={handle}
          onPinned={() => {}}
          onDeleted={() => {
            onDelete?.(annotation);
            onClose();
          }}
        />
      ) : (
        <p>Opening notebook…</p>
      )}
    </Dialog>
  );
}
function EditHighlight({
  annotation,
  onClose,
  onDelete,
}: {
  annotation: Annotation;
  onClose: () => void;
  onDelete?: (a: Annotation) => void;
}) {
  const [note, setNote] = useState(annotation.note),
    [color, setColor] = useState(annotation.color),
    [tags, setTags] = useState(annotation.tags.join(", ")),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Dialog title="Edit annotation" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await save("annotation", {
              ...annotation,
              note,
              color,
              tags: tags
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
            });
            onClose();
          } catch (error) {
            setError(messageOf(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <blockquote className="quote-preview">{annotation.text}</blockquote>
        <ColorPicker value={color} onChange={setColor} />
        <label>
          Your note
          <textarea
            autoFocus
            rows={6}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What would you like to remember?"
          />
        </label>
        <label>
          Tags
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="Ideas, research, inspiration"
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button
            type="button"
            className="danger text-button"
            onClick={async () => {
              try {
                await save("annotation", annotation, true);
                onDelete?.(annotation);
                onClose();
              } catch (e) {
                setError(messageOf(e));
              }
            }}
          >
            Delete annotation
          </button>
          <button className="primary" disabled={busy}>
            Save changes
          </button>
        </div>
      </form>
    </Dialog>
  );
}
