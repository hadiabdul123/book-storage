import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { db, get } from "./db";
import type { NotebookNote } from "./researchTypes";
import type { RichNode } from "./model";
import { validRichDocument } from "./richText";
import { CitationExtension } from "./Citation";
import { registerNoteFlusher, saveNotebookNote } from "./notebookStore";
import { noteFormatting } from "./noteFormatting";
import { NoteFormatButtons } from "./NoteFormatButtons";
import { DrawingExtension } from "./NotebookDrawing";
import { uid } from "./model";

export function TopicEditor({ note }: { note: NotebookNote }) {
  const [title, setTitle] = useState(note.title), [tags, setTags] = useState(note.tags.join(", "));
  const [status, setStatus] = useState("Opening note…");
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState("home");
  const value = useRef({ note, revision: 0, saved: 0 });
  const active = useRef(true), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<Promise<boolean> | null>(null);
  const draftKey = `topic-draft:${note.id}`;
  const editor = useEditor({
    extensions: [CitationExtension, DrawingExtension.configure({ noteId: note.id }), ...noteFormatting(), StarterKit.configure({ heading: { levels: [1, 2, 3] }, blockquote: false, code: false, codeBlock: false, horizontalRule: false, link: { openOnClick: false, autolink: false, linkOnPaste: false }, strike: false }), TaskList, TaskItem.configure({ nested: true })],
    content: note.document, editable: false,
    editorProps: { attributes: { role: "textbox", "aria-label": "Topic note content", "aria-multiline": "true", class: "notebook-writing" } },
    onUpdate: ({ editor }) => change({ document: editor.getJSON() as RichNode }),
  });
  function change(patch: Partial<NotebookNote>) {
    value.current = { ...value.current, note: { ...value.current.note, ...patch }, revision: value.current.revision + 1 };
    setStatus("Saving…");
    void db.meta.put({ key: draftKey, value: JSON.stringify(value.current.note) }).catch(() => { if (active.current) setStatus("Could not store a recovery draft. Keep this note open."); });
    clearTimeout(timer.current); timer.current = setTimeout(() => void flush(), 450);
  }
  async function flush(): Promise<boolean> {
    clearTimeout(timer.current);
    if (pending.current) return pending.current;
    if (value.current.revision === value.current.saved) return true;
    pending.current = (async () => {
      try {
        while (value.current.revision !== value.current.saved) {
          const snapshot = value.current;
          const saved = await saveNotebookNote(snapshot.note, snapshot.note.updatedAt);
          value.current.saved = snapshot.revision;
          value.current.note = { ...value.current.note, updatedAt: saved.updatedAt };
          if (value.current.revision === snapshot.revision) await db.meta.delete(draftKey);
        }
        if (active.current) setStatus("Saved on this device"); return true;
      } catch (e) { if (active.current) setStatus(`Could not save: ${e instanceof Error ? e.message : String(e)}`); return false; }
      finally { pending.current = null; }
    })();
    return pending.current;
  }
  useEffect(() => registerNoteFlusher(note.id, flush), [note.id, editor]);
  useEffect(() => {
    if (!editor) return;
    let cancelled = false; active.current = true;
    const load = async (recover = true) => {
      const latest = await get("notebook-note", note.id) || note;
      const savedDraft = recover ? await db.meta.get(draftKey) : undefined;
      let draft: NotebookNote | undefined;
      try { const candidate = JSON.parse(savedDraft?.value || "null"); if (candidate?.id === note.id && typeof candidate.title === "string" && Array.isArray(candidate.tags) && validRichDocument(candidate.document)) draft = candidate; } catch { /* Ignore malformed recovery data. */ }
      if (cancelled) return;
      const next = draft || latest;
      value.current = { note: next, revision: draft ? 1 : 0, saved: 0 };
      editor.commands.setContent(next.document, { emitUpdate: false }); editor.setEditable(true, false);
      setTitle(next.title); setTags(next.tags.join(", ")); setLoaded(true);
      setStatus(draft ? "Recovered unfinished writing" : "Saved on this device");
      if (draft) void flush();
    };
    void load().catch(e => setStatus(`Could not open note: ${e.message}`));
    const clipped = (e: Event) => { if ((e as CustomEvent).detail?.id === note.id) void load(false).catch(e => setStatus(e.message)); };
    window.addEventListener("leafmark-clipped", clipped);
    const leave = (e: BeforeUnloadEvent) => { if (value.current.revision !== value.current.saved) { void flush(); e.preventDefault(); e.returnValue = ""; } };
    const hide = () => { if (document.hidden) void flush(); };
    window.addEventListener("beforeunload", leave); document.addEventListener("visibilitychange", hide);
    return () => { cancelled = true; active.current = false; clearTimeout(timer.current); void flush(); window.removeEventListener("leafmark-clipped", clipped); window.removeEventListener("beforeunload", leave); document.removeEventListener("visibilitychange", hide); };
  }, [editor, note.id]);
  return <section className="topic-editor" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) void flush(); }}>
    <label className="topic-title-label">Title<input aria-label="Topic note title" maxLength={200} disabled={!loaded} value={title} onChange={e => { setTitle(e.target.value); change({ title: e.target.value }); }} /></label>
    <div className="notebook-ribbon"><div className="ribbon-tabs" role="tablist" aria-label="Notebook tools">{["home", "insert", "draw"].map(t => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}</div>
    <div className={`notebook-toolbar ribbon-${tab}`} role="toolbar" aria-label="Topic note formatting" onMouseDown={e => { if (!(e.target as Element).closest("input,select")) e.preventDefault(); }}>
      {tab === "home" && <>
      <button aria-label="Bold" aria-pressed={editor?.isActive("bold") || false} onClick={() => editor?.chain().focus().toggleBold().run()}><b>B</b></button>
      <button aria-label="Italic" onClick={() => editor?.chain().focus().toggleItalic().run()}><i>I</i></button>
      <NoteFormatButtons editor={editor} />
      <button aria-label="Heading" onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>H</button>
      <button aria-label="Bullet list" onClick={() => editor?.chain().focus().toggleBulletList().run()}>• List</button>
      <button aria-label="Numbered list" onClick={() => editor?.chain().focus().toggleOrderedList().run()}>1. List</button>
      <button aria-label="Checklist" onClick={() => editor?.chain().focus().toggleTaskList().run()}>☑</button>
      <button aria-label="Undo" onClick={() => editor?.chain().focus().undo().run()}>↶</button><button aria-label="Redo" onClick={() => editor?.chain().focus().redo().run()}>↷</button>
      </>}
      {tab === "insert" && <><button onClick={() => editor?.chain().focus().insertContent({ type: "drawing", attrs: { blockId: uid(), height: 300 } }).run()}>Insert drawing</button><NoteFormatButtons editor={editor} /></>}
      {tab === "draw" && <><button onClick={() => editor?.chain().focus().insertContent({ type: "drawing", attrs: { blockId: uid(), height: 300 } }).run()}>New drawing</button><span className="muted">Choose Edit drawing on a canvas to use pens and highlighters.</span></>}
    </div></div>
    <EditorContent editor={editor} />
    <label>Tags<input aria-label="Topic note tags" maxLength={500} disabled={!loaded} value={tags} onChange={e => { setTags(e.target.value); change({ tags: e.target.value.split(",").map(t => t.trim()).filter(Boolean) }); }} placeholder="science, questions, ideas" /></label>
    <div className="topic-save-status"><span role="status">{status}</span><button className="text-button" disabled={!loaded} onClick={() => void flush()}>Save now</button></div>
  </section>;
}
