import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { useLiveQuery } from "dexie-react-hooks";
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
import { Paperclip, PenLine, MousePointer2, Type } from "lucide-react";
import { InkToolbar } from "./InkToolbar";
import { defaultInkStyle } from "./inkTypes";
import { InkHistory, type bindInkSurface } from "./ink";
import { NotebookInkAnchors, NotebookPaperInk, type PaperTool } from "./NotebookPaperInk";
import { mediaLabel, cueHref, readCue, type MediaCue } from "./NotebookMedia";
import { NotebookMediaLayer } from "./NotebookMediaLayer";
import { attachmentExtension, attachMedia, notebookMediaList, placeMedia } from "./notebookMediaStore";
import { adjacentMediaGap, InlineMediaExtension, mediaDragType, mediaFlow, mediaPosition, reserveMediaGap } from "./inlineMedia";
import { mediaTypes, type NotebookMedia } from "./notebookAssets";
import { useSearchParams } from "react-router-dom";

const noMedia: NotebookMedia[] = [];

export function TopicEditor({ note }: { note: NotebookNote }) {
  const [title, setTitle] = useState(note.title), [tags, setTags] = useState(note.tags.join(", "));
  const [status, setStatus] = useState("Opening note…");
  const [loaded, setLoaded] = useState(false);
  const [params] = useSearchParams();
  const drawing = params.get("drawing") || undefined;
  const [paperTool, setPaperTool] = useState<PaperTool>(drawing ? "select" : "write");
  const [inkStyle, setInkStyle] = useState(defaultInkStyle);
  const [inkHistory] = useState(() => new InkHistory());
  const [notice, setNotice] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [dropLine, setDropLine] = useState<number>();
  const [cue, setCue] = useState<MediaCue | undefined>(() => readCue(location.href, note.id));
  const files = useLiveQuery(async () => (await notebookMediaList()).filter(media => media.noteId === note.id), [note.id]);
  const paper = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const inkBinding = useRef<ReturnType<typeof bindInkSurface> | undefined>(undefined);
  const inkWrites = useRef(new Set<Promise<void>>());
  const value = useRef({ note, revision: 0, saved: 0 });
  const active = useRef(true), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<Promise<boolean> | null>(null);
  const mediaWrite = useRef<Promise<void> | undefined>(undefined);
  const draftKey = `topic-draft:${note.id}`;
  const editor = useEditor({
    extensions: [NotebookInkAnchors, InlineMediaExtension, CitationExtension, DrawingExtension.configure({ noteId: note.id }), ...noteFormatting(), StarterKit.configure({ heading: { levels: [1, 2, 3] }, blockquote: false, code: false, codeBlock: false, horizontalRule: false, link: { openOnClick: false, autolink: false, linkOnPaste: false }, strike: false }), TaskList, TaskItem.configure({ nested: true })],
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
  useEffect(() => registerNoteFlusher(note.id, async () => {
    inkBinding.current?.flush();
    await mediaWrite.current;
    const inkSaved = Promise.all([...inkWrites.current]).then(() => true, () => false);
    return (await flush()) && await inkSaved && !inkHistory.pending.size;
  }), [note.id, editor]);
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
  function switchTool(tool: PaperTool) {
    inkBinding.current?.flush(); setPaperTool(tool);
    if (tool === "write") editor?.commands.focus();
  }

  function updateMedia(action: () => Promise<void>) {
    if (mediaWrite.current) return;
    setAttaching(true);
    setNotice("");
    mediaWrite.current = action().catch(e => setNotice(e instanceof Error ? e.message : String(e))).finally(() => {
      mediaWrite.current = undefined;
      setAttaching(false);
    });
  }

  function addFiles(input: File[], position: number) {
    if (!editor || !loaded || !input.length) return;
    updateMedia(async () => {
      const errors: string[] = [];
      const accepted = input.filter(file => {
        try { attachmentExtension(file); return true; }
        catch (e) { errors.push(e instanceof Error ? e.message : String(e)); return false; }
      });
      if (!accepted.length) { setNotice(errors.join(" ")); return; }
      const gap = reserveMediaGap(editor, position);
      if (!(await flush())) throw new Error("Save the note and try attaching the files again.");
      const before = mediaFlow(editor.state.doc, files || noMedia).filter(item => item.position === gap.position).map(item => item.media.id);
      const saved: string[] = [];
      for (const file of accepted) {
        try { saved.push((await attachMedia(note.id, file, { after: gap.after, order: before.length + saved.length })).id); }
        catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
      }
      if (saved.length) await placeMedia(note.id, gap.after, [...before, ...saved]);
      if (errors.length) setNotice(errors.join(" "));
    });
  }

  function moveMedia(id: string, position: number, direction: -1 | 1, reference?: string, split = false) {
    if (!editor || !loaded) return;
    updateMedia(async () => {
      const gap = reserveMediaGap(editor, position, split);
      if (!(await flush())) throw new Error("Save the note before moving attachments.");
      const target = mediaFlow(editor.state.doc, files || noMedia).filter(item => item.position === gap.position && item.media.id !== id).map(item => item.media.id);
      const index = reference ? target.indexOf(reference) : -1;
      target.splice(index < 0 ? (direction < 0 ? target.length : 0) : index + (direction > 0 ? 1 : 0), 0, id);
      await placeMedia(note.id, gap.after, target);
    });
  }

  function bumpMedia(id: string, direction: -1 | 1) {
    if (!editor) return;
    const flow = mediaFlow(editor.state.doc, files || noMedia);
    const index = flow.findIndex(item => item.media.id === id);
    const current = flow[index], neighbor = flow[index + direction];
    if (!current) return;
    if (neighbor?.position === current.position) moveMedia(id, current.position, direction, neighbor.media.id);
    else {
      const target = adjacentMediaGap(editor.state.doc, current.position, direction);
      if (target !== undefined) moveMedia(id, target, direction);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>, commit: boolean) {
    const types = event.dataTransfer.types;
    if (!editor || !loaded || (!types.includes("Files") && !types.includes(mediaDragType))) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = types.includes(mediaDragType) ? "move" : "copy";
    const block = (event.target as Element).closest<HTMLElement>("[data-media-id]");
    const target = files?.find(media => media.id === block?.dataset.mediaId);
    const rect = block?.getBoundingClientRect();
    const position = target ? mediaPosition(editor.state.doc, target) : editor.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? editor.state.doc.content.size;
    const before = rect ? event.clientY < rect.top + rect.height / 2 : false;
    if (!commit && paper.current) {
      const top = rect ? (before ? rect.top : rect.bottom) : editor.view.coordsAtPos(position).top;
      setDropLine(Math.max(0, top - paper.current.getBoundingClientRect().top));
    }
    if (!commit) return;
    setDropLine(undefined);
    switchTool("write");
    const id = event.dataTransfer.getData(mediaDragType);
    if (id && files?.some(media => media.id === id) && target?.id !== id) moveMedia(id, position, before ? -1 : 1, target?.id, !target);
    else if (!id) addFiles(Array.from(event.dataTransfer.files), position);
  }
  const mediaParam = params.get("media"), timeParam = params.get("at");
  useEffect(() => { const next = readCue(location.href, note.id); if (next) setCue(next); }, [mediaParam, timeParam, note.id]);
  useEffect(() => { if (drawing) setPaperTool("select"); }, [drawing]);
  return <section className="topic-editor" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) void flush(); }}>
    <div className="notebook-ribbon">
    <div className="notebook-toolbar" role="toolbar" aria-label="Topic note formatting" onMouseDown={e => { if (!(e.target as Element).closest("input,select")) e.preventDefault(); }}>
      <button type="button" aria-pressed={paperTool === "draw"} disabled={!loaded} onClick={() => switchTool(paperTool === "draw" ? "write" : "draw")}><PenLine size={17} />Pen</button>
      <button type="button" disabled={!loaded || attaching} onClick={() => fileInput.current?.click()}><Paperclip size={17} />Attach media</button>
      <button aria-label="Bold" aria-pressed={editor?.isActive("bold") || false} onClick={() => editor?.chain().focus().toggleBold().run()}><b>B</b></button>
      <button aria-label="Italic" onClick={() => editor?.chain().focus().toggleItalic().run()}><i>I</i></button>
      <NoteFormatButtons editor={editor} />
      <button aria-label="Heading" onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>H</button>
      <button aria-label="Bullet list" onClick={() => editor?.chain().focus().toggleBulletList().run()}>• List</button>
      <button aria-label="Numbered list" onClick={() => editor?.chain().focus().toggleOrderedList().run()}>1. List</button>
      <button aria-label="Checklist" onClick={() => editor?.chain().focus().toggleTaskList().run()}>☑</button>
      <button aria-label="Undo" onClick={() => editor?.chain().focus().undo().run()}>↶</button><button aria-label="Redo" onClick={() => editor?.chain().focus().redo().run()}>↷</button>
    </div>
    {paperTool !== "write" && <div className="paper-ink-tools">
      <button className="text-button" aria-pressed={paperTool === "draw"} onClick={() => switchTool("draw")}><PenLine size={16} />Draw</button>
      <button className="text-button" aria-pressed={paperTool === "select"} onClick={() => switchTool("select")}><MousePointer2 size={16} />Select drawing</button>
      <button className="text-button" onClick={() => switchTool("write")}><Type size={16} />Write</button>
      <InkToolbar style={inkStyle} change={style => { inkBinding.current?.flush(); setInkStyle(style); switchTool("draw"); }} undo={() => void inkHistory.move().catch(e => setNotice(e.message))} redo={() => void inkHistory.move(true).catch(e => setNotice(e.message))} />
    </div>}</div>
    <input ref={fileInput} type="file" multiple accept={Object.keys(mediaTypes).map(ext => `.${ext}`).join(",")} aria-label="Attach image, video or audio" hidden onChange={e => {
      const input = Array.from(e.currentTarget.files || []);
      e.currentTarget.value = "";
      const position = editor?.state.selection.to ?? 0;
      switchTool("write");
      addFiles(input, position);
    }} />
    {attaching && <p role="status">Saving attachments…</p>}
    {notice && <p className="notice" role="status">{notice} {inkHistory.pending.size > 0 && <button className="text-button" onClick={() => void inkHistory.retry().then(() => setNotice("Drawing saved."), e => setNotice(e.message))}>Retry drawing save</button>}</p>}
    <div className="note-paper-layout">
      {cue && files && !files.some(media => media.id === cue.id) && <p role="status">This attachment is unavailable. Check sync or restore it from Trash.</p>}
      <div className="note-paper-column">
        <label className="topic-title-label"><input aria-label="Topic note title" maxLength={200} disabled={!loaded} value={title} onChange={e => { setTitle(e.target.value); change({ title: e.target.value }); }} /></label>
        <div ref={paper} className="notebook-paper" onDragOverCapture={event => handleDrop(event, false)} onDropCapture={event => handleDrop(event, true)}
          onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropLine(undefined); }} onDragEnd={() => setDropLine(undefined)}>
          <EditorContent editor={editor} onClickCapture={event => {
            const link = (event.target as Element).closest("a"); const next = link && readCue(link.href, note.id);
            if (next) { event.preventDefault(); event.stopPropagation(); setCue(next); }
          }} />
          {dropLine !== undefined && <div className="notebook-drop-line" style={{ top: dropLine }} aria-hidden="true" />}
          {editor && loaded && <NotebookMediaLayer editor={editor} files={files || noMedia} cue={cue} onMove={bumpMedia} onTimestamp={value => {
            switchTool("write");
            editor.chain().focus().insertContent([{ type: "text", text: mediaLabel(value.time), marks: [{ type: "link", attrs: { href: cueHref(note.id, value), target: "_self", rel: null, class: null } }] }, { type: "text", text: " " }]).run();
          }} />}
          {editor && loaded && <NotebookPaperInk editor={editor} noteId={note.id} paper={paper} mode={paperTool} style={inkStyle} history={inkHistory} notice={setNotice} saveNote={flush} bindingRef={inkBinding} writes={inkWrites} openDrawing={drawing} />}
        </div>
      </div>
    </div>
    <label className="note-tags">Tags<input aria-label="Topic note tags" maxLength={500} disabled={!loaded} value={tags} onChange={e => { setTags(e.target.value); change({ tags: e.target.value.split(",").map(t => t.trim()).filter(Boolean) }); }} placeholder="Add tags" /></label>
    <div className="topic-save-status"><span role="status">{status}</span><button className="text-button" disabled={!loaded} onClick={() => void flush()}>Save now</button></div>
  </section>;
}
