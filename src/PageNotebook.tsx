import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { db, get, save } from "./db";
import { pageNoteId, savePageNote } from "./pageNotes";
import { emptyDocument, validRichDocument } from "./richText";
import type { Book, RichNode } from "./model";

export type NotebookHandle = { flush: () => Promise<boolean> };
export function PageNotebook({
  book,
  page,
  handle,
  onPinned,
  onDeleted,
}: {
  book: Book;
  page: number;
  handle: MutableRefObject<NotebookHandle | null>;
  onPinned: (pinned: boolean) => void;
  onDeleted: () => void;
}) {
  const [status, setStatus] = useState("Opening notebook…"),
    [tags, setTags] = useState("");
  const [loaded, setLoaded] = useState(false);
  const value = useRef({
    document: emptyDocument(),
    tags: [] as string[],
    revision: 0,
    saved: 0,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<Promise<boolean> | null>(null);
  const active = useRef(true);
  const draftKey = `page-note-draft:${book.id}:${page}`;
  const statusText = (text: string) => {
    if (active.current) setStatus(text);
  };
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        blockquote: false,
        code: false,
        codeBlock: false,
        horizontalRule: false,
        link: false,
        strike: false,
        underline: false,
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
    ],
    content: emptyDocument(),
    editable: false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": `Notebook for page ${page}`,
        "aria-multiline": "true",
        class: "notebook-writing",
      },
    },
    onUpdate: ({ editor }) =>
      change(editor.getJSON() as RichNode, value.current.tags),
    onFocus: () => onPinned(true),
  });
  function change(document: RichNode, nextTags: string[]) {
    value.current = {
      ...value.current,
      document,
      tags: nextTags,
      revision: value.current.revision + 1,
    };
    onPinned(true);
    statusText("Saving…");
    // Recovery drafts are private and cleared with all other account data.
    void db.meta
      .put({
        key: draftKey,
        value: JSON.stringify({ document, tags: nextTags }),
      })
      .catch(() => {});
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 450);
  }
  async function flush(): Promise<boolean> {
    clearTimeout(timer.current);
    if (pending.current) return pending.current;
    if (value.current.revision === value.current.saved) return true;
    pending.current = (async () => {
      try {
        while (value.current.revision !== value.current.saved) {
          const snapshot = value.current;
          await savePageNote(book, page, snapshot.document, snapshot.tags);
          value.current.saved = snapshot.revision;
          if (value.current.revision === snapshot.revision)
            await db.meta.delete(draftKey);
        }
        statusText("Saved on this device");
        return true;
      } catch (error) {
        statusText(
          `Could not save: ${error instanceof Error ? error.message : String(error)}`,
        );
        onPinned(true);
        return false;
      } finally {
        pending.current = null;
      }
    })();
    return pending.current;
  }
  useEffect(() => {
    active.current = true;
    handle.current = { flush };
    if (!editor) return;
    let cancelled = false;
    void (async () => {
      const saved = await get("annotation", pageNoteId(book.id, page));
      const draft = await db.meta.get(draftKey);
      let document = saved?.content?.document || emptyDocument(),
        nextTags = saved?.tags || [];
      if (draft) {
        try {
          const parsed = JSON.parse(draft.value);
          if (
            validRichDocument(parsed.document) &&
            Array.isArray(parsed.tags) &&
            parsed.tags.every((t: unknown) => typeof t === "string")
          ) {
            document = parsed.document;
            nextTags = parsed.tags;
          }
        } catch {
          /* Ignore malformed recovery data. */
        }
      }
      if (cancelled) return;
      value.current = {
        document,
        tags: nextTags,
        revision: draft ? 1 : 0,
        saved: 0,
      };
      editor.commands.setContent(document, { emitUpdate: false });
      editor.setEditable(true);
      setTags(nextTags.join(", "));
      setLoaded(true);
      setStatus(
        draft
          ? "Recovered unsaved writing"
          : saved
            ? "Saved on this device"
            : "Your notes for this page",
      );
      if (draft) void flush();
    })().catch((e) => statusText(`Could not open notebook: ${e.message}`));
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (value.current.revision !== value.current.saved) {
        void flush();
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      cancelled = true;
      active.current = false;
      clearTimeout(timer.current);
      void flush();
      handle.current = null;
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [editor, book.id, page]);
  const command = (run: () => void) => {
    run();
  };
  return (
    <section
      className="page-notebook"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          void flush().then((ok) => {
            if (active.current && ok && !editor?.isFocused) onPinned(false);
          });
      }}
    >
      <div className="notebook-heading">
        <h3>Page {page}</h3>
        <span className="notebook-status" role="status">
          {status}
        </span>
      </div>
      <div
        className="notebook-toolbar"
        role="toolbar"
        aria-label="Notebook formatting"
        onMouseDown={(e) => e.preventDefault()}
      >
        {editor && (
          <>
            <button
              type="button"
              aria-label="Bold"
              onClick={() =>
                command(() => {
                  editor.chain().focus().toggleBold().run();
                })
              }
            >
              <b>B</b>
            </button>
            <button
              type="button"
              aria-label="Italic"
              onClick={() => {
                editor.chain().focus().toggleItalic().run();
              }}
            >
              <i>I</i>
            </button>
            <button
              type="button"
              aria-label="Heading"
              onClick={() => {
                editor.chain().focus().toggleHeading({ level: 2 }).run();
              }}
            >
              H
            </button>
            <button
              type="button"
              aria-label="Bullet list"
              onClick={() => {
                editor.chain().focus().toggleBulletList().run();
              }}
            >
              • List
            </button>
            <button
              type="button"
              aria-label="Numbered list"
              onClick={() => {
                editor.chain().focus().toggleOrderedList().run();
              }}
            >
              1. List
            </button>
            <button
              type="button"
              aria-label="Checklist"
              onClick={() => {
                editor.chain().focus().toggleTaskList().run();
              }}
            >
              ☑
            </button>
            <button
              type="button"
              aria-label="Undo"
              onClick={() => {
                editor.chain().focus().undo().run();
              }}
            >
              ↶
            </button>
            <button
              type="button"
              aria-label="Redo"
              onClick={() => {
                editor.chain().focus().redo().run();
              }}
            >
              ↷
            </button>
          </>
        )}
      </div>
      <EditorContent editor={editor} />
      <label>
        Tags
        <input
          aria-label="Page note tags"
          value={tags}
          disabled={!loaded}
          onChange={(e) => {
            setTags(e.target.value);
            change(
              value.current.document,
              e.target.value
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
            );
          }}
        />
      </label>
      <div className="button-row">
        <button
          className="secondary"
          disabled={!loaded}
          onClick={() => void flush()}
        >
          Save now
        </button>
        <button
          className="text-button danger"
          disabled={!loaded}
          onClick={async () => {
            if (!confirm("Move this page notebook to trash?")) return;
            if (!(await flush())) return;
            try {
              const note = await get("annotation", pageNoteId(book.id, page));
              if (note) await save("annotation", note, true);
              await db.meta.delete(draftKey);
              onDeleted();
            } catch (e) {
              statusText(`Could not delete: ${String(e)}`);
            }
          }}
        >
          Delete page note
        </button>
      </div>
    </section>
  );
}
