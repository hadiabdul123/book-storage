import { Extension, type Editor } from "@tiptap/react";
import { Fragment, Slice, type Node } from "@tiptap/pm/model";
import { AllSelection, Plugin, Selection, SelectionRange, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Step, StepResult, type Mappable } from "@tiptap/pm/transform";
import { closeHistory } from "@tiptap/pm/history";
import { db, save } from "./db";
import { now, uid, type RichNode } from "./model";
import { mediaKind, type NotebookMedia, type NotebookOverlay } from "./notebookAssets";
import { originalMediaBytes } from "./notebookMediaStore";
import { type InkStroke } from "./inkTypes";
import { plainText } from "./richText";
import { sourceLabel, sourceHref } from "./sourceReferences";
import { mediaFlow } from "./inlineMedia";

export interface NoteObjects { media: NotebookMedia[]; drawings: NotebookOverlay[]; strokes: InkStroke[] }
const hasObjects = (objects: NoteObjects) => !!(objects.media.length || objects.drawings.length || objects.strokes.length);

// A history step joins the editor's undo group to the separate attachment and ink rows.
export class NoteObjectsStep extends Step {
  constructor(readonly objects: NoteObjects, readonly deleted: boolean) { super(); }
  apply(doc: Node) { return StepResult.ok(doc); }
  invert() { return new NoteObjectsStep(this.objects, !this.deleted); }
  map() { return this; }
  toJSON() { return { stepType:"leafmark-note-objects", objects:this.objects, deleted:this.deleted }; }
}
export async function writeObjectSteps(steps: NoteObjectsStep[], originals: Map<string, ArrayBuffer>) {
  for (const { objects, deleted } of steps) {
    for (const media of objects.media) {
      const bytes = originals.get(media.id);
      if (bytes && !deleted && !(await db.mediaFiles.get(media.id))) await db.mediaFiles.add({id:media.id,bytes,uploaded:false});
      await save(mediaKind(media), media, deleted);
    }
    for (const overlay of objects.drawings) await save("notebook-overlay", overlay, deleted);
    for (const stroke of objects.strokes) await save("ink-stroke", stroke, deleted);
  }
}

type Clip = { key:string; slice: Slice; objects:NoteObjects; text:string };
const clipType = "application/x-leafmark-notebook-selection";
let copied: Clip | undefined;
export const lastCopiedSelection = () => copied;
export const fullPage = (editor: Editor) => editor.state.selection instanceof AllSelection;
export function selectPage(editor: Editor) {
  editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
  editor.view.focus();
}
export function selectedObjects(editor: Editor, all: NoteObjects, ids: Set<string>, strokeIds: Set<string>) {
  const { selection } = editor.state;
  if (fullPage(editor)) return all;
  const blocks = new Set<string>();
  for (const { $from, $to } of selection.ranges) {
    if ($from.pos === $to.pos) continue;
    editor.state.doc.nodesBetween($from.pos, $to.pos, node => {
      if (node.type.name === "drawing") blocks.add(node.attrs.blockId);
    });
  }
  const strokes = all.strokes.filter(s => s.target.type === "notebook" && (strokeIds.has(s.id) || blocks.has(s.target.blockId)));
  for (const stroke of strokes) if (stroke.target.type === "notebook") blocks.add(stroke.target.blockId);
  return {media:all.media.filter(m => ids.has(m.id)), drawings:all.drawings.filter(d => blocks.has(d.id)), strokes};
}

export function copySelection(editor: Editor, clipboard: DataTransfer, objects: NoteObjects) {
  const slice = editor.state.selection.content();
  const references: string[] = [];
  slice.content.descendants(node => {
    if (node.type.name === "citation") {
      const source = node.attrs.source;
      references.push(sourceLabel(source) + " " + new URL(sourceHref(source), location.href).href);
    }
  });
  if (!hasObjects(objects) && !references.length) return false;
  const text = [plainText({type:"doc",content:slice.content.toJSON() ?? []}), ...objects.media.map(m=>m.title), ...references].filter(Boolean).join("\n");
  const key = uid();
  clipboard.setData("text/plain", text || "[Drawing]");
  clipboard.setData(clipType, key);
  // Some clipboard implementations discard custom MIME types but retain HTML.
  const span = document.createElement("span");
  span.dataset.leafmarkClip = key; span.textContent = text || "[Drawing]";
  clipboard.setData("text/html", span.outerHTML);
  copied = {key,slice,objects,text};
  return true;
}
export function readSelection(clipboard: DataTransfer) {
  if (!copied) return;
  const key = clipboard.getData(clipType) || clipboard.getData("text/html").match(/data-leafmark-clip="([0-9a-f-]+)"/i)?.[1];
  return key === copied.key ? copied : undefined;
}
export function removeSelection(editor: Editor, objects: NoteObjects, all: NoteObjects) {
  if (!hasObjects(objects)) return false;
  const tr = closeHistory(editor.state.tr).deleteSelection().step(new NoteObjectsStep(removableObjects(objects,all),true));
  editor.view.dispatch(tr); editor.view.dispatch(closeHistory(editor.state.tr)); return true;
}
function removableObjects(objects:NoteObjects, all:NoteObjects) {
  const ids = new Set(objects.strokes.map(s => s.id));
  const drawings = objects.drawings.filter(d => !all.strokes.some(s => s.target.type === "notebook" && s.target.blockId === d.id && !ids.has(s.id)));
  return {...objects,drawings};
}
export async function pasteSelection(editor: Editor, noteId: string, clip: Clip, originals: Map<string,ArrayBuffer>, replaced:NoteObjects, all:NoteObjects) {
  const state = editor.state;
  const ids = new Map<string,string>();
  const remap = (id:string) => { if (!ids.has(id)) ids.set(id,uid()); return ids.get(id)!; };
  const content: RichNode[] = structuredClone(clip.slice.content.toJSON() || []);
  function rekey(node: RichNode) {
    if (node.attrs?.inkAnchor) node.attrs.inkAnchor = remap(node.attrs.inkAnchor);
    if (node.type === "drawing" && node.attrs?.blockId) node.attrs.blockId = remap(node.attrs.blockId);
    node.content?.forEach(rekey);
  }
  content.forEach(rekey);
  const stamp = now();
  const media: NotebookMedia[] = [];
  const bytes = new Map<string,ArrayBuffer>();
  for (const original of clip.objects.media) {
    const id = uid();
    bytes.set(id,await originalMediaBytes(original));
    media.push({...original,id,noteId,createdAt:stamp});
  }
  if (editor.isDestroyed || editor.state.doc !== state.doc || !editor.state.selection.eq(state.selection))
    throw Error("The insertion point changed. Paste again where you want the selection.");
  const tr = closeHistory(editor.state.tr);
  // Use an explicit paragraph for objects with an anchor outside the selection.
  const emptyPage = state.doc.childCount === 1 && state.doc.firstChild?.type.name === "paragraph" && !state.doc.firstChild.content.size;
  const startAnchor = uid(), endAnchor = uid();
  const atStart = (m:NotebookMedia) => m.placement?.after === "start";
  const needsStart = !emptyPage && (media.some(atStart) || clip.objects.drawings.some(d=>!ids.has(d.anchor)));
  const needsEnd = media.some(m => !atStart(m) && !ids.has(m.placement?.after ?? ""));
  let slice = Slice.fromJSON(editor.schema,content.length ? {content,openStart:clip.slice.openStart,openEnd:clip.slice.openEnd} : null);
  if (needsStart || needsEnd) {
    let blocks = slice.content;
    if (needsStart) blocks = blocks.addToStart(editor.schema.nodes.paragraph.create({inkAnchor:startAnchor}));
    if (needsEnd) blocks = blocks.addToEnd(editor.schema.nodes.paragraph.create({inkAnchor:endAnchor}));
    slice = new Slice(blocks,0,0);
  }
  tr.replaceSelection(slice);
  if (hasObjects(replaced)) tr.step(new NoteObjectsStep(removableObjects(replaced,all),true));
  for (const m of media) m.placement = {...m.placement, after:ids.get(m.placement?.after ?? "") ?? (atStart(m) ? emptyPage ? "start" : startAnchor : endAnchor),order:m.placement?.order ?? 0};
  const drawings = clip.objects.drawings.map(d => ({...d,id:remap(d.id),noteId,createdAt:stamp,anchor:ids.get(d.anchor) ?? (emptyPage ? "paper" : startAnchor)}));
  const strokes = clip.objects.strokes.flatMap(s => s.target.type === "notebook" ? [{...s,id:uid(),createdAt:stamp,
    target:{type:"notebook" as const,noteId,blockId:remap(s.target.blockId)}}] : []);
  for (const [id,file] of bytes) originals.set(id,file);
  const pasted = {media,drawings,strokes};
  if (hasObjects(pasted)) tr.step(new NoteObjectsStep(pasted,false));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.dispatch(closeHistory(editor.state.tr)); editor.view.focus();
}

type Rect = {left:number;top:number;right:number;bottom:number};
const overlaps = (a:Rect,b:Rect) => a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
export function objectsInRange(editor: Editor, paper: HTMLElement, files: NotebookMedia[], area?: Rect) {
  const selection = editor.state.selection;
  const dom = document.getSelection();
  const rects = area ? [area] : dom?.rangeCount && !dom.isCollapsed && editor.view.dom.contains(dom.anchorNode)
    ? Array.from(dom.getRangeAt(0).getClientRects()) : [];
  const ids = new Set<string>(), strokes = new Set<string>();
  const all = !area && fullPage(editor);
  for (const el of paper.querySelectorAll<HTMLElement>("[data-media-id],path[data-stroke]")) {
    if (!all && !rects.some(r => overlaps(r,el.getBoundingClientRect()))) continue;
    if (el.dataset.mediaId) ids.add(el.dataset.mediaId);
    if (el.dataset.stroke) strokes.add(el.dataset.stroke);
  }
  if (!area && !selection.empty) for (const {media,position} of mediaFlow(editor.state.doc,files)) {
    if (!media.placement?.free && (all || (position > selection.from && position < selection.to))) ids.add(media.id);
  }
  return {ids,strokes};
}
type Interval = {from:number;to:number};
function mappedRanges(ranges:Interval[], mapping:Mappable) {
  return ranges.map(r => ({from:mapping.map(r.from,1),to:mapping.map(r.to,-1)})).filter(r=>r.from<r.to);
}
class BoxBookmark {
  constructor(readonly ranges:Interval[]) {}
  map(mapping:Mappable) { return new BoxBookmark(mappedRanges(this.ranges,mapping)); }
  resolve(doc:Node) { return boxSelection(doc,this.ranges); }
}
class BoxSelection extends Selection {
  constructor(doc:Node, readonly intervals:Interval[]) {
    const ranges = intervals.map(r=>new SelectionRange(doc.resolve(r.from),doc.resolve(r.to)));
    super(ranges[0].$from,ranges[ranges.length-1].$to,ranges);
  }
  visible = false;
  content() {
    let fragment = Fragment.empty;
    for (const range of this.intervals) fragment = fragment.append(this.$from.doc.slice(range.from,range.to,true).content);
    return new Slice(fragment,0,0);
  }
  eq(other:Selection) { return other instanceof BoxSelection && this.intervals.length===other.intervals.length &&
    this.intervals.every((r,i)=>r.from===other.intervals[i].from && r.to===other.intervals[i].to); }
  map(doc:Node,mapping:Mappable) { return boxSelection(doc,mappedRanges(this.intervals,mapping)); }
  getBookmark() { return new BoxBookmark(this.intervals); }
  toJSON() { return {type:"notebook-box-selection",ranges:this.intervals}; }
  static fromJSON(doc:Node,json:{ranges:Interval[]}) { return boxSelection(doc,json.ranges); }
}
Selection.jsonID("notebook-box-selection",BoxSelection);
function boxSelection(doc:Node,ranges:Interval[]):Selection {
  if (!ranges.length) return Selection.atStart(doc);
  return ranges.length===1 ? TextSelection.create(doc,ranges[0].from,ranges[0].to) : new BoxSelection(doc,ranges);
}
export const NotebookBoxSelection = Extension.create({
  name:"notebookBoxSelection",
  addProseMirrorPlugins() {
    return [new Plugin({props:{decorations:({doc,selection})=>selection instanceof BoxSelection ?
      DecorationSet.create(doc,selection.intervals.map(r=>Decoration.inline(r.from,r.to,{class:"notebook-box-selection"}))) : null}})];
  },
});
export function selectBoxText(editor: Editor, area: Rect) {
  const ranges:Interval[] = [];
  editor.state.doc.descendants((node,pos) => {
    if (!node.isText || !node.text) {
      if (node.isAtom && !node.isText) {
        const el=editor.view.nodeDOM(pos);
        if (el instanceof Element && overlaps(area,el.getBoundingClientRect())) ranges.push({from:pos,to:pos+node.nodeSize});
      }
      return;
    }
    const text = editor.view.domAtPos(pos+1).node;
    if (text.nodeType !== 3) return;
    const range = document.createRange();
    range.selectNodeContents(text);
    if (!overlaps(area,range.getBoundingClientRect())) return;
    for (let i=0;i<text.textContent!.length;i++) {
      range.setStart(text,i); range.setEnd(text,i+1);
      if (overlaps(area,range.getBoundingClientRect())) {
        const last = ranges.at(-1);
        if (last?.to === pos+i) last.to++; else ranges.push({from:pos+i,to:pos+i+1});
      }
    }
  });
  const selection = ranges.length ? boxSelection(editor.state.doc,ranges) : Selection.near(editor.state.selection.$from);
  editor.view.dispatch(editor.state.tr.setSelection(selection));
}
