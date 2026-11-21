import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./notebookWorkspace.css";
import { NotebookToolRail, type ToolName } from "./NotebookToolRail";
import type { DragEvent, PointerEvent } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, Slice, type Node as EditorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { useLiveQuery } from "dexie-react-hooks";
import StarterKit from "@tiptap/starter-kit";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { NotebookBoxSelection, NoteObjectsStep, writeObjectSteps, selectedObjects, copySelection, lastCopiedSelection, removeSelection, pasteSelection, readSelection, objectsInRange, selectBoxText, selectPage } from "./notebookClipboard";
import { db, get, list } from "./db";
import type { NotebookNote, SourceRef } from "./researchTypes";
import type { RichNode } from "./model";
import { paragraph, validRichDocument } from "./richText";
import { CitationExtension } from "./Citation";
import { registerNoteFlusher, saveNotebookNote } from "./notebookStore";
import { noteFormatting } from "./noteFormatting";
import { NoteFormatButtons } from "./NoteFormatButtons";
import { DrawingExtension } from "./NotebookDrawing";
import { Paperclip, PenLine, MousePointer2, Type, Quote, SquarePen } from "lucide-react";
import { InsertQuote } from "./InsertQuote";
import { NotebookTextBoxControls } from "./NotebookTextBoxControls";
import { insertTextBox, notebookJSON, NotebookTextBoxes, validTextBox } from "./notebookTextBox";
import { citationNode } from "./sourceReferences";
import { InkToolbar } from "./InkToolbar";
import { defaultInkStyle } from "./inkTypes";
import { InkHistory, type bindInkSurface } from "./ink";
import { NotebookInkAnchors, NotebookPaperInk, type PaperTool } from "./NotebookPaperInk";
import { mediaLabel, cueHref, readCue, type MediaCue } from "./NotebookMedia";
import { NotebookMediaLayer } from "./NotebookMediaLayer";
import { attachmentExtension, attachMedia, copyMediaToNote, notebookMediaList, placeMedia, positionMedia } from "./notebookMediaStore";
import { adjacentMediaGap, InlineMediaExtension, mediaDragType, mediaFlow, mediaPosition, reserveMediaGap } from "./inlineMedia";
import { mediaTypes, type FreeMediaPosition, type NotebookMedia } from "./notebookAssets";
import { copiedMediaIds, decodeMediaSelection, encodeMediaSelection, useMediaSelection } from "./mediaSelection";
import { useSearchParams } from "react-router-dom";

const noMedia: NotebookMedia[] = [];
const noInk = {drawings:[], strokes:[]};

export type StudyClip = { source: SourceRef; text: string; file?: File; point?: { x: number; y: number } };
export type StudyInsert = (clip: StudyClip) => Promise<void>;
export function TopicEditor({ note, toolbarHost, insertHandle, onReady, clipRegion }: { clipRegion?: React.ReactNode; onReady?: (ready: boolean) => void; insertHandle?: React.RefObject<StudyInsert | null>; note: NotebookNote; toolbarHost?: HTMLElement | null }) {
  const [title, setTitle] = useState(note.title), [tags, setTags] = useState(note.tags.join(", "));
  const [status, setStatus] = useState("Opening note…");
  const [loaded, setLoaded] = useState(false);
  const [params] = useSearchParams();
  const drawing = params.get("drawing") || undefined;
  const [paperTool, setPaperTool] = useState<PaperTool>(drawing ? "select" : "write");
  const [markColor, setMarkColor] = useState(() => {
    try { const saved = localStorage.getItem("notebook-highlight-color"); if (saved && /^#[0-9a-f]{6}$/i.test(saved)) return saved; } catch { /* Private browsing */ }
    return "#f4cc60";
  });
  const [markTool, setMarkTool] = useState(false);
  const [inkStyle, setInkStyle] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("notebook-pen-style") || "null");
      if (saved && ["pen","highlighter","eraser","lasso"].includes(saved.tool) && typeof saved.width === "number" &&
          saved.width > 0 && saved.width <= 40 && /^#[0-9a-f]{6}$/i.test(saved.color)) return {...defaultInkStyle,...saved} as typeof defaultInkStyle;
    } catch { /* Private browsing */ }
    return defaultInkStyle;
  });
  const [inkHistory] = useState(() => new InkHistory());
  const [notice, setNotice] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [quoteAnchor, setQuoteAnchor] = useState<{ doc: EditorNode; position: number }>();
  const [dropLine, setDropLine] = useState<number>();
  const [selectingMedia, setSelectingMedia] = useState(false);
  const [selectedMedia, setSelectedMedia] = useState<Set<string>>(() => new Set());
  const [cue, setCue] = useState<MediaCue | undefined>(() => readCue(location.href, note.id));
  const files = useLiveQuery(async () => (await notebookMediaList()).filter(media => media.noteId === note.id), [note.id]);
  const paper = useRef<HTMLDivElement>(null);
  const [selectedStrokes, setSelectedStrokes] = useState<Set<string>>(new Set());
  const ink = useLiveQuery(async () => ({
    drawings:(await list("notebook-overlay")).filter(d => d.noteId === note.id),
    strokes:(await list("ink-stroke")).filter(s => s.target.type === "notebook" && s.target.noteId === note.id),
  }), [note.id]);
  const steps = useRef<NoteObjectsStep[]>([]), originals = useRef(new Map<string,ArrayBuffer>());
  const allObjects = {media:files ?? noMedia, ...(ink ?? noInk)};
  const fileInput = useRef<HTMLInputElement>(null);
  const inkBinding = useRef<ReturnType<typeof bindInkSurface> | undefined>(undefined);
  const inkWrites = useRef(new Set<Promise<void>>());
  const value = useRef({ note, revision: 0, saved: 0 });
  const active = useRef(true), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<Promise<boolean> | null>(null);
  const mediaWrite = useRef<Promise<void> | undefined>(undefined);
  const cleanupDrag = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cleanupDrag.current?.(), []);
  const titleField = useRef<HTMLTextAreaElement>(null);
  const draftKey = `topic-draft:${note.id}`;
  const editor = useEditor({
    extensions: [NotebookBoxSelection, NotebookInkAnchors, NotebookTextBoxes, InlineMediaExtension, CitationExtension, DrawingExtension.configure({ noteId: note.id }), ...noteFormatting(), StarterKit.configure({ heading: { levels: [1, 2, 3] }, blockquote: false, code: false, codeBlock: false, horizontalRule: false, link: { openOnClick: false, autolink: false, linkOnPaste: false }, strike: false }), TaskList, TaskItem.configure({ nested: true })],
    content: note.document, editable: false,
    editorProps: { attributes: { role: "textbox", "aria-label": "Topic note content", "aria-multiline": "true", class: "notebook-writing" } },
    onTransaction: ({editor,transaction}) => {
      const changes = transaction.steps.filter((s): s is NoteObjectsStep => s instanceof NoteObjectsStep);
      if (!changes.length) return;
      steps.current.push(...changes);
      change({document:notebookJSON(editor.getJSON() as RichNode)});
      queueMicrotask(() => void flush());
    },
    onUpdate: ({ editor }) => change({ document: notebookJSON(editor.getJSON() as RichNode) }),
  });
  useEffect(() => {
    const el = titleField.current;
    if (!el) return;
    const grow = () => { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; };
    grow();
    if (el.parentElement) {
      // Width changes rewrap the title. Height changes are produced by grow().
      let previousWidth = el.clientWidth;
      const resize = new ResizeObserver(() => { if (previousWidth !== el.clientWidth) { previousWidth = el.clientWidth; grow(); } });
      resize.observe(el.parentElement); return () => resize.disconnect();
    }
  }, [title]);
  function change(patch: Partial<NotebookNote>) {
    value.current = { ...value.current, note: { ...value.current.note, ...patch }, revision: value.current.revision + 1 };
    setStatus("Saving…");
    if (!steps.current.length) void db.meta.put({ key: draftKey, value: JSON.stringify(value.current.note) }).catch(() => { if (active.current) setStatus("Could not store a recovery draft. Keep this note open."); });
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
          const batch = steps.current.slice();
          const saved = batch.length ? await db.transaction("rw", [db.rows, db.outbox, db.conflicts, db.meta, db.mediaFiles], async () => {
            await writeObjectSteps(batch, originals.current);
            return saveNotebookNote(snapshot.note, snapshot.note.updatedAt);
          }) : await saveNotebookNote(snapshot.note, snapshot.note.updatedAt);
          steps.current.splice(0,batch.length);
          for (const step of batch) for (const media of step.objects.media) originals.current.delete(media.id);
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
    inkBinding.current?.flush(); setPaperTool(tool); if (tool !== "write") setMarkTool(false);
    if (tool !== "write") { setSelectedStrokes(new Set()); setSelectingMedia(false); setSelectedMedia(new Set()); }
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
      const before = inlineFlow().filter(item => item.position === gap.position).map(item => item.media.id);
      const saved: string[] = [];
      for (const file of accepted) {
        try { saved.push((await attachMedia(note.id, file, { after: gap.after, order: before.length + saved.length })).id); }
        catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
      }
      if (saved.length) await placeMedia(note.id, gap.after, [...before, ...saved]);
      if (errors.length) setNotice(errors.join(" "));
    });
  }

  function inlineFlow() { return editor ? mediaFlow(editor.state.doc, (files || noMedia).filter(media => !media.placement?.free)) : []; }

  function moveMedia(ids: string[], position: number, direction: -1 | 1, reference?: string, split = false) {
    if (!editor || !loaded) return;
    updateMedia(async () => {
      const gap = reserveMediaGap(editor, position, split);
      if (!(await flush())) throw new Error("Save the note before moving attachments.");
      const target = inlineFlow().filter(item => item.position === gap.position && !ids.includes(item.media.id)).map(item => item.media.id);
      const index = reference ? target.indexOf(reference) : -1;
      target.splice(index < 0 ? (direction < 0 ? target.length : 0) : index + (direction > 0 ? 1 : 0), 0, ...ids);
      await placeMedia(note.id, gap.after, target);
    });
  }

  function bumpMedia(id: string, direction: -1 | 1) {
    if (!editor) return;
    const flow = inlineFlow();
    const index = flow.findIndex(item => item.media.id === id);
    const current = flow[index], neighbor = flow[index + direction];
    if (!current) return;
    if (neighbor?.position === current.position) moveMedia([id], current.position, direction, neighbor.media.id);
    else {
      const target = adjacentMediaGap(editor.state.doc, current.position, direction);
      if (target !== undefined) moveMedia([id], target, direction);
    }
  }

  function selectedIds() {
    if (!editor) return [];
    return mediaFlow(editor.state.doc, files || noMedia).filter(item => selectedMedia.has(item.media.id)).map(item => item.media.id);
  }

  function toggleMedia(id: string) {
    setSelectingMedia(true);
    setSelectedMedia(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleFree(id?: string) {
    const root = paper.current;
    if (!root) return;
    const target = id && files?.find(media => media.id === id);
    const ids = id ? [id] : selectedIds();
    const bounds = root.getBoundingClientRect();
    if (!bounds.width) return;
    const positions = new Map<string, FreeMediaPosition | undefined>();
    for (const mediaId of ids) {
      const media = files?.find(item => item.id === mediaId);
      if (!media) continue;
      if (target && target.placement?.free) { positions.set(mediaId, undefined); continue; }
      if (media.placement?.free) continue;
      const block = root.querySelector(`[data-media-id="${CSS.escape(mediaId)}"]`)?.getBoundingClientRect();
      if (block) positions.set(mediaId, { x: 0, y: Math.max(0, Math.min(100, (block.top - bounds.top) / bounds.width)), width: media.displayWidth ?? .45 });
    }
    if (positions.size) updateMedia(() => positionMedia(note.id, positions));
  }

  function pasteMedia(ids: string[]) {
    if (!editor || !loaded || !ids.length) return;
    updateMedia(async () => {
      const gap = reserveMediaGap(editor, editor.state.selection.to);
      if (!(await flush())) throw new Error("Save the note before pasting attachments.");
      const order = Math.max(-1, ...inlineFlow().filter(item => item.position === gap.position).map(item => item.media.placement?.order ?? 0)) + 1;
      await copyMediaToNote(note.id, ids, gap.after, order);
      setNotice(`${ids.length} ${ids.length === 1 ? "attachment" : "attachments"} pasted.`);
    });
  }

  function dropTarget(x: number, y: number, element: Element | null) {
    if (!editor) return;
    const block = element?.closest<HTMLElement>("[data-media-id]");
    const target = files?.find(media => media.id === block?.dataset.mediaId && !media.placement?.free);
    const rect = block?.getBoundingClientRect();
    const position = target ? mediaPosition(editor.state.doc, target) : editor.view.posAtCoords({ left: x, top: y })?.pos ?? editor.state.doc.content.size;
    const before = rect ? y < rect.top + rect.height / 2 : false;
    return { target, position, before, top: rect ? (before ? rect.top : rect.bottom) : editor.view.coordsAtPos(position).top };
  }

  function moveInlineGroup(id: string, destination: ReturnType<typeof dropTarget>) {
    if (!destination || !files?.some(media => media.id === id)) return;
    const ids = selectedMedia.has(id) ? selectedIds() : [id];
    const { target, position, before } = destination;
    if (!target || !ids.includes(target.id)) moveMedia(ids, position, before ? -1 : 1, target?.id, !target);
  }

  function dragInline(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (event.button !== 0 || cleanupDrag.current) return;
    const handle = event.currentTarget, pointer = event.pointerId, x = event.clientX, y = event.clientY;
    let moved = false;
    event.preventDefault(); event.stopPropagation();
    handle.setPointerCapture(pointer);
    function locate(e: globalThis.PointerEvent) {
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      return paper.current?.contains(hit) ? dropTarget(e.clientX, e.clientY, hit) : undefined;
    }
    function move(e: globalThis.PointerEvent) {
      if (e.pointerId !== pointer || (!moved && Math.hypot(e.clientX - x, e.clientY - y) < 6)) return;
      moved = true;
      const target = locate(e);
      setDropLine(target && paper.current ? Math.max(0, target.top - paper.current.getBoundingClientRect().top) : undefined);
    }
    function finish(e: globalThis.PointerEvent) {
      if (e.pointerId !== pointer) return;
      clean(); setDropLine(undefined);
      if (e.type !== "pointerup") return;
      if (moved) moveInlineGroup(id, locate(e));
      else toggleMedia(id);
    }
    function clean() {
      handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish); handle.removeEventListener("lostpointercapture", finish);
      cleanupDrag.current = undefined;
    }
    handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish); handle.addEventListener("lostpointercapture", finish);
    cleanupDrag.current = clean;
  }

  useEffect(() => {
    if (!insertHandle || !editor || !loaded) return;
    const preview = (event: Event) => {
      const point = (event as CustomEvent<{x:number;y:number} | null>).detail;
      const root = paper.current;
      if (!point || !root) { setDropLine(undefined); return; }
      const pos = editor.view.posAtCoords({ left: point.x, top: point.y })?.pos ?? editor.state.doc.content.size;
      setDropLine(Math.max(0, editor.view.coordsAtPos(pos).top - root.getBoundingClientRect().top));
    };
    document.addEventListener("leafmark-study-drop-preview", preview);
    return () => document.removeEventListener("leafmark-study-drop-preview", preview);
  }, [insertHandle, editor, loaded]);

  function handleDrop(event: DragEvent<HTMLDivElement>, commit: boolean) {
    const types = event.dataTransfer.types;
    if (!editor || !loaded || (!types.includes("Files") && !types.includes(mediaDragType))) return;
    event.preventDefault(); event.stopPropagation();
    event.dataTransfer.dropEffect = types.includes(mediaDragType) ? "move" : "copy";
    const destination = dropTarget(event.clientX, event.clientY, event.target as Element);
    if (!destination) return;
    if (!commit && paper.current) {
      const { top } = destination;
      setDropLine(Math.max(0, top - paper.current.getBoundingClientRect().top));
    }
    if (!commit) return;
    setDropLine(undefined);
    switchTool("write");
    const id = event.dataTransfer.getData(mediaDragType);
    if (id) moveInlineGroup(id, destination);
    else addFiles(Array.from(event.dataTransfer.files), destination.position);
  }
  const mediaParam = params.get("media"), timeParam = params.get("at");
  useEffect(() => { const next = readCue(location.href, note.id); if (next) setCue(next); }, [mediaParam, timeParam, note.id]);
  useEffect(() => { if (drawing) setPaperTool("select"); }, [drawing]);
  useEffect(() => {
    if (!insertHandle || !editor || !loaded) return;
    insertHandle.current = async clip => {
      const { source, point } = clip;
      let exists = false;
      editor.state.doc.descendants(node => { if (node.type.name === "citation" && node.attrs.source?.id === source.id) exists = true; });
      const position = point ? editor.view.posAtCoords({ left: point.x, top: point.y })?.pos ?? editor.state.doc.content.size : editor.state.selection.to;
      if (!exists && !insertQuote(clip.file ? "" : clip.text, source, { position, doc: editor.state.doc }, clip.file ? source.id : undefined))
        throw new Error("Place the caret in the note and try again.");
      if (!(await flush())) throw new Error("Could not save the clip. Keep the note open and retry.");
      if (clip.file && !(await get("notebook-image", source.id)))
        await attachMedia(note.id, clip.file, { after: source.id, order: 0 }, source.id);
    };
    onReady?.(true);
    return () => { insertHandle.current = null; onReady?.(false); };
  }, [editor, loaded, insertHandle, note.id, onReady]);
  function insertQuote(text: string, source: SourceRef, anchor = quoteAnchor, imageAnchor?: string) {
    if (!editor || editor.isDestroyed || !anchor || editor.state.doc !== anchor.doc) return false;
    const { position } = anchor;
    const { schema } = editor.state;
    const citation = schema.nodeFromJSON(citationNode(source));
    const quote = text.match(/[\s\S]{1,50000}/gu)?.map(part => schema.nodeFromJSON(paragraph(part))) || [];
    const blocks = Fragment.fromArray([...quote, ...(imageAnchor ? [schema.nodes.paragraph.create({ inkAnchor: imageAnchor })] : []), citation]);
    const tr = closeHistory(editor.state.tr).replaceRange(position, position, new Slice(blocks, 0, 0));
    let after: number | undefined;
    tr.doc.descendants((node, at) => {
      if (node === citation) after = at + node.nodeSize;
    });
    if (after === undefined) return false;
    if (!tr.doc.resolve(after).nodeAfter?.isTextblock) tr.insert(after, schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView();
    switchTool("write");
    setSelectingMedia(false);
    editor.view.dispatch(tr);
    editor.view.dispatch(closeHistory(editor.state.tr));
    setQuoteAnchor(undefined);
    requestAnimationFrame(() => { if (!editor.isDestroyed) editor.view.focus(); });
    return true;
  }
  const selected = () => editor && selectedObjects(editor, allObjects, selectedMedia, selectedStrokes);
  const lasso = useMediaSelection(paper, selectingMedia, (ids, area) => {
    if (!editor || !paper.current) return;
    editor.view.focus();
    if (area) selectBoxText(editor,area);
    const hit = area ? objectsInRange(editor,paper.current,allObjects.media,area) : undefined;
    setSelectedMedia(hit?.ids ?? new Set(ids)); setSelectedStrokes(hit?.strokes ?? new Set());
  });
  useEffect(() => {
    if (!editor || !loaded) return;
    let frame = 0;
    function refresh() {
      if (!editor || !paper.current || selectingMedia || !editor.view.hasFocus()) return;
      const hit = objectsInRange(editor,paper.current,files ?? noMedia);
      setSelectedMedia(hit.ids); setSelectedStrokes(hit.strokes);
    }
    const update = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(refresh); };
    editor.on("selectionUpdate", update); document.addEventListener("selectionchange", update);
    return () => { cancelAnimationFrame(frame); editor.off("selectionUpdate",update); document.removeEventListener("selectionchange",update); };
  }, [editor,loaded,selectingMedia,files]);
  function currentObjects() {
    if (!editor || !paper.current) return;
    if (selectingMedia) return selected();
    const hit = objectsInRange(editor,paper.current,allObjects.media);
    return selectedObjects(editor,allObjects,hit.ids,hit.strokes);
  }
  function clearPicked() { setSelectedMedia(new Set()); setSelectedStrokes(new Set()); }
  async function clipboardAction(cut: boolean) {
    if (!editor) return;
    const data = new DataTransfer(), objects = currentObjects();
    if (!objects || !copySelection(editor,data,objects)) {
      editor.view.focus(); document.execCommand(cut ? "cut" : "copy"); return;
    }
    const state = editor.state;
    try {
      await navigator.clipboard.write([new ClipboardItem(Object.fromEntries(["text/plain","text/html"].map(type => [type,new Blob([data.getData(type)],{type})])))]);
      const canCut = cut && !editor.isDestroyed && editor.state.doc === state.doc && editor.state.selection.eq(state.selection);
      if (canCut) {
        if (!removeSelection(editor,objects,allObjects)) editor.commands.deleteSelection(); clearPicked();
      }
      setNotice(canCut ? "Selection cut." : "Selection copied.");
    } catch { setNotice("Use the system Copy or Cut command for this selection."); }
  }
  function paintSelectedWords() {
    if (!markTool || !editor || selectingMedia || paperTool !== "write") return;
    requestAnimationFrame(() => {
      if (!editor.isDestroyed && editor.view.hasFocus() && !editor.state.selection.empty)
        editor.commands.setHighlight({color:markColor});
    });
  }
  const activeTool: ToolName | undefined = selectingMedia ? "Select" : paperTool !== "write" ? "Pen" : markTool ? "Highlight" : undefined;
  function chooseTool(name: ToolName) {
    setMarkTool(name === "Highlight");
    switchTool(name === "Pen" ? "draw" : "write");
    setSelectingMedia(name === "Select");
    if (name === "Highlight") editor?.chain().focus().setHighlight({ color: markColor }).run();
  }
  const ribbon = <NotebookToolRail active={activeTool} disabled={!editor || !loaded} choose={chooseTool}
    palette={(name, close) => {
      if (name === "Insert") return <div className="note-action-list" onClick={close}>
      <button type="button" disabled={!loaded || attaching} onClick={() => fileInput.current?.click()}><Paperclip size={17} />Attach media</button>
      <button type="button" disabled={!loaded || !editor} onClick={() => {
        if (!editor) return;
        const { $to } = editor.state.selection;
        const position = $to.depth === 1 && validTextBox($to.parent.attrs.textBox) ? $to.after() : $to.pos;
        setQuoteAnchor({ doc: editor.state.doc, position });
      }}><Quote size={17} />Insert quote</button>
        <button onClick={() => { if (editor) { switchTool("write"); setSelectingMedia(false); insertTextBox(editor); } }}><SquarePen size={17}/>Text box</button>
        {clipRegion}
      </div>;
      if (name === "Format") return <div className="note-format-grid">
      <button aria-label="Bold" aria-pressed={editor?.isActive("bold") || false} onClick={() => editor?.chain().focus().toggleBold().run()}><b>B</b></button>
      <button aria-label="Italic" onClick={() => editor?.chain().focus().toggleItalic().run()}><i>I</i></button>
      <NoteFormatButtons editor={editor} />
      <button aria-label="Heading" onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>H</button>
      <button aria-label="Bullet list" onClick={() => editor?.chain().focus().toggleBulletList().run()}>• List</button>
      <button aria-label="Numbered list" onClick={() => editor?.chain().focus().toggleOrderedList().run()}>1. List</button>
      <button aria-label="Checklist" onClick={() => editor?.chain().focus().toggleTaskList().run()}>☑</button>
      <button aria-label="Undo" onClick={() => editor?.chain().focus().undo().run()}>↶</button><button aria-label="Redo" onClick={() => editor?.chain().focus().redo().run()}>↷</button>
      </div>;
      if (name === "Highlight") return <><strong>Highlight color</strong><div className="note-swatches">
        {Object.entries({ Gold:"#f4cc60", Green:"#a2cfaa", Blue:"#9abedc", Rose:"#ebb3bd", Lavender:"#c9b9de" }).map(([label,color]) =>
          <button key={color} aria-label={label} aria-pressed={markColor === color} style={{backgroundColor:color}}
            onClick={() => { setMarkColor(color); try {localStorage.setItem("notebook-highlight-color",color);} catch { /* Private browsing */ } editor?.chain().focus().setHighlight({color}).run(); close(); }} />)}
        </div><button onClick={() => { editor?.chain().focus().unsetHighlight().run(); setMarkTool(false); close(); }}>Remove highlight</button></>;
      if (name === "Pen") return <>
    {paperTool !== "write" && <div className="paper-ink-tools">
      <button className="text-button" aria-pressed={paperTool === "draw"} onClick={() => { switchTool("draw"); close(); }}><PenLine size={16} />Draw</button>
      <button className="text-button" aria-pressed={paperTool === "select"} onClick={() => { switchTool("select"); close(); }}><MousePointer2 size={16} />Select drawing</button>
      <button className="text-button" onClick={() => { switchTool("write"); close(); }}><Type size={16} />Write</button>
      <InkToolbar style={inkStyle} change={style => { inkBinding.current?.flush(); setInkStyle(style); try {localStorage.setItem("notebook-pen-style",JSON.stringify(style));} catch { /* Private browsing */ } switchTool("draw"); }} undo={() => void inkHistory.move().catch(e => setNotice(e.message))} redo={() => void inkHistory.move(true).catch(e => setNotice(e.message))} />
    </div>}
      </>;
      return <div className="note-action-list">
        <button onClick={() => { if (editor) selectPage(editor); close(); }}>Select all</button>
        <button onClick={() => { void clipboardAction(false); close(); }}>Copy selection</button>
        <button onClick={() => { void clipboardAction(true); close(); }}>Cut selection</button>
        {lastCopiedSelection() && <button onClick={() => {
          const clip = lastCopiedSelection(), objects = currentObjects();
          if (editor && clip && objects) void pasteSelection(editor,note.id,clip,originals.current,objects,allObjects).then(clearPicked,e=>setNotice(e.message));
          close();
        }}>Paste selection</button>}
        <button onClick={() => { const objects=currentObjects(); if(editor && objects) {
          if (!removeSelection(editor,objects,allObjects)) editor.commands.deleteSelection(); clearPicked();
        } close(); }}>Delete selection</button>
{selectingMedia && <div className="notebook-media-tools">
      <span role="status">{selectedMedia.size ? `${selectedMedia.size} selected` : "Tap attachments or drag a box around them"}</span>
      <button className="text-button" disabled={!selectedMedia.size} onClick={() => {
        const ids = selectedIds();
        if (!decodeMediaSelection(`leafmark:attachments:${ids.join(",")}`)) { setNotice("Select up to 30 attachments at a time."); return; }
        const text = encodeMediaSelection(ids);
        void navigator.clipboard?.writeText(text).catch(() => {});
        setNotice("Attachments copied. Paste on a notebook page.");
      }}>Copy attachments</button>
      <button className="text-button" disabled={!selectedMedia.size} onClick={() => toggleFree()}>Move selection freely</button>
      <button className="text-button" onClick={() => { setSelectingMedia(false); setSelectedMedia(new Set()); }}>Done</button>
    </div>}
    {copiedMediaIds().length > 0 && <div className="notebook-media-tools"><button className="text-button" onClick={() => pasteMedia(copiedMediaIds())}>Paste attachments</button></div>}      </div>;
    }}/>;
  return <section className="topic-editor" onBlur={e => {
    const target = e.relatedTarget as Node | null;
    if (!e.currentTarget.contains(target) && !toolbarHost?.contains(target)) void flush();
  }}>
    {toolbarHost ? createPortal(ribbon, toolbarHost) : ribbon}
    {quoteAnchor && <InsertQuote onClose={() => setQuoteAnchor(undefined)} onInsert={insertQuote} />}
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
        <time className="page-date" dateTime={note.createdAt}>{new Date(note.createdAt).toLocaleDateString(undefined,{month:"long",day:"numeric"})}</time>
        <label className="topic-title-label"><textarea rows={1} ref={titleField} onKeyDown={e => { if(e.key === "Enter") { e.preventDefault(); editor?.commands.focus(); } }} aria-label="Topic note title" maxLength={200} disabled={!loaded} value={title} onChange={e => { const text = e.target.value.replace(/[\r\n]+/g," "); setTitle(text); change({ title: text }); }} /></label>
        <div ref={paper} className="notebook-paper" data-media-select={selectingMedia} data-writing-tool={paperTool} {...lasso.handlers}
          onClickCapture={event => {
            const target = event.target as Element;
            const id = target.closest<HTMLElement>("[data-media-id]")?.dataset.mediaId;
            if (id && (selectingMedia || event.shiftKey || event.ctrlKey || event.metaKey) && !target.closest("button, dialog, .workspace-menu")) { event.preventDefault(); event.stopPropagation(); toggleMedia(id); }
          }} onKeyDownCapture={event => {
            if (!editor || (event.target as Element).closest("input,textarea,button,select,video,audio")) return;
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
              event.preventDefault(); event.stopPropagation(); selectPage(editor);
              setSelectedMedia(new Set(allObjects.media.map(m=>m.id))); setSelectedStrokes(new Set(allObjects.strokes.map(s=>s.id)));
            } else if (event.key === "Backspace" || event.key === "Delete") {
              const objects = currentObjects();
              if (objects && removeSelection(editor,objects,allObjects)) { event.preventDefault(); event.stopPropagation(); clearPicked(); }
            }
          }} onCopyCapture={event => {
            const objects=currentObjects();
            if (editor && objects && copySelection(editor,event.clipboardData,objects)) {event.preventDefault();event.stopPropagation();}
          }} onCutCapture={event => {
            const objects=currentObjects();
            if (editor && objects && copySelection(editor,event.clipboardData,objects)) {
              event.preventDefault(); event.stopPropagation(); if (!removeSelection(editor,objects,allObjects)) editor.commands.deleteSelection(); clearPicked();
            }
          }} onPasteCapture={event => {
            const clip=readSelection(event.clipboardData), objects=currentObjects();
            if (editor && clip && objects) {
              event.preventDefault(); event.stopPropagation();
              void pasteSelection(editor,note.id,clip,originals.current,objects,allObjects).then(clearPicked,e=>setNotice(e.message));
              return;
            }
            const ids = decodeMediaSelection(event.clipboardData.getData("text/plain"));
            if (ids) { event.preventDefault(); event.stopPropagation(); pasteMedia(ids); }
          }} onDragOverCapture={event => handleDrop(event, false)} onDropCapture={event => handleDrop(event, true)}
          onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropLine(undefined); }} onDragEnd={() => setDropLine(undefined)}>
          <EditorContent editor={editor} onPointerUp={paintSelectedWords} onClickCapture={event => {
            const link = (event.target as Element).closest("a"); const next = link && readCue(link.href, note.id);
            if (next) { event.preventDefault(); event.stopPropagation(); setCue(next); }
          }} />
          {dropLine !== undefined && <div className="notebook-drop-line" style={{ top: dropLine }} aria-hidden="true" />}
          {editor && loaded && <NotebookTextBoxControls editor={editor} paper={paper} enabled={paperTool === "write" && !selectingMedia} />}
          {lasso.box && <div className="notebook-media-lasso" style={lasso.box} aria-hidden="true" />}
          {editor && loaded && <NotebookMediaLayer editor={editor} files={files || noMedia} cue={cue} paper={paper} selected={selectedMedia} onSelect={toggleMedia} onFree={toggleFree} onDragInline={dragInline} onMoveFree={positions => updateMedia(() => positionMedia(note.id, positions))} onMove={bumpMedia} onTimestamp={value => {
            switchTool("write");
            editor.chain().focus().insertContentAt(editor.state.selection.to, [{ type: "text", text: mediaLabel(value.time), marks: [{ type: "link", attrs: { href: cueHref(note.id, value), target: "_self", rel: null, class: null } }] }, { type: "text", text: " " }]).run();
          }} />}
          {editor && loaded && <NotebookPaperInk overlays={allObjects.drawings} strokes={allObjects.strokes} selectedStrokes={selectedStrokes} editor={editor} noteId={note.id} paper={paper} mode={paperTool} style={inkStyle} history={inkHistory} notice={setNotice} saveNote={flush} bindingRef={inkBinding} writes={inkWrites} openDrawing={drawing} />}
        </div>
      </div>
    </div>
    <label className="note-tags">Tags<input aria-label="Topic note tags" maxLength={500} disabled={!loaded} value={tags} onChange={e => { setTags(e.target.value); change({ tags: e.target.value.split(",").map(t => t.trim()).filter(Boolean) }); }} placeholder="Add tags" /></label>
    <div className="topic-save-status" data-error={status.startsWith("Could not")}><span role="status">{status}</span><button className="text-button" disabled={!loaded} onClick={() => void flush()}>Save now</button></div>
  </section>;
}
