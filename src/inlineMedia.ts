import { Extension, type Editor } from "@tiptap/react";
import type { Node as DocumentNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { canSplit } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { uid } from "./model";
import type { NotebookMedia } from "./notebookAssets";

export const mediaDragType = "application/x-leafmark-attachment";
type Widget = { media: NotebookMedia; host: HTMLElement };
type MediaWidgetState = { widgets: Widget[]; decorations: DecorationSet };
const widgetsKey = new PluginKey<MediaWidgetState>("notebookInlineMedia");

function blocks(doc: DocumentNode) {
  const result: { start: number; end: number; anchorPos?: number; anchor?: string }[] = [];
  doc.forEach((node, start) => {
    const block: typeof result[number] = { start, end: start + node.nodeSize };
    if (node.type.name === "paragraph" || node.type.name === "heading") {
      block.anchorPos = start;
      block.anchor = node.attrs.inkAnchor;
    } else node.descendants((child, pos) => {
      if (block.anchorPos === undefined && ["paragraph", "heading"].includes(child.type.name)) {
        block.anchorPos = start + pos + 1;
        block.anchor = child.attrs.inkAnchor;
      }
    });
    result.push(block);
  });
  return result;
}

function endGap(doc: DocumentNode) {
  const last = doc.lastChild;
  return last?.type.name === "paragraph" && !last.content.size ? doc.content.size - last.nodeSize : doc.content.size;
}

export function mediaPosition(doc: DocumentNode, media: NotebookMedia) {
  if (media.placement?.after === "start") return 0;
  return media.placement ? blocks(doc).find(block => block.anchor === media.placement!.after)?.end ?? endGap(doc) : endGap(doc);
}

export function mediaFlow(doc: DocumentNode, files: NotebookMedia[]) {
  if (!files.length) return [];
  const gaps = new Map(blocks(doc).map(block => [block.anchor, block.end]));
  gaps.set("start", 0);
  const last = endGap(doc);
  return files.map(media => ({ media, position: media.placement ? gaps.get(media.placement.after) ?? last : last })).sort((a, b) =>
    a.position - b.position || (a.media.placement?.order ?? 0) - (b.media.placement?.order ?? 0) ||
    a.media.createdAt.localeCompare(b.media.createdAt) || a.media.id.localeCompare(b.media.id));
}

export const InlineMediaExtension = Extension.create({
  name: "notebookInlineMedia",
  addProseMirrorPlugins() {
    return [new Plugin<MediaWidgetState>({
      key: widgetsKey,
      state: {
        init: () => ({ widgets: [], decorations: DecorationSet.empty }),
        apply(tr, previous) {
          const next = tr.getMeta(widgetsKey) as Widget[] | undefined;
          if (!tr.docChanged && !next) return previous;
          const widgets = next ?? previous.widgets;
          const hosts = new Map(widgets.map(widget => [widget.media.id, widget.host]));
          const decorations = DecorationSet.create(tr.doc, mediaFlow(tr.doc, widgets.map(widget => widget.media)).map(({ media, position }, order) =>
            Decoration.widget(position, hosts.get(media.id)!, { key: media.id, side: order + 1, ignoreSelection: true, stopEvent: () => true })));
          return { widgets, decorations };
        },
      },
      props: {
        decorations: state => widgetsKey.getState(state)?.decorations,
      },
    })];
  },
});

export function updateMediaWidgets(editor: Editor, widgets: Widget[]) {
  if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(widgetsKey, widgets));
}

// Reserve a gap between top-level blocks. Lists stay intact, and prose can be split at the caret.
export function reserveMediaGap(editor: Editor, requested: number, split = true) {
  const tr = editor.state.tr;
  let position = Math.max(0, Math.min(requested, tr.doc.content.size));
  const resolved = tr.doc.resolve(position);
  if (resolved.depth === 1 && resolved.parent.isTextblock) {
    if (!resolved.parentOffset) position = resolved.before();
    else if (resolved.parentOffset === resolved.parent.content.size || resolved.parent.attrs.textBox) position = resolved.after();
    else if (split && canSplit(tr.doc, position)) {
      tr.split(position);
      position++;
    }
  }
  const containing = blocks(tr.doc).find(block => block.start < position && position <= block.end);
  position = containing?.end ?? 0;
  let after = "start";
  if (containing) {
    if (containing.anchor) after = containing.anchor;
    else if (containing.anchorPos !== undefined) {
      after = uid();
      const node = tr.doc.nodeAt(containing.anchorPos)!;
      tr.setNodeMarkup(containing.anchorPos, undefined, { ...node.attrs, inkAnchor: after });
    } else {
      after = uid();
      const paragraph = editor.schema.nodes.paragraph.create({ inkAnchor: after });
      tr.insert(position, paragraph);
      position += paragraph.nodeSize;
    }
  }
  if (position === tr.doc.content.size) tr.insert(position, editor.schema.nodes.paragraph.create());
  if (tr.docChanged) editor.view.dispatch(tr);
  return { after, position };
}

export function adjacentMediaGap(doc: DocumentNode, position: number, step: -1 | 1) {
  const gaps = [0, ...blocks(doc).map(block => block.end)].filter(gap => gap <= endGap(doc));
  if (step < 0) return gaps.reverse().find(gap => gap < position);
  return gaps.find(gap => gap > position);
}
