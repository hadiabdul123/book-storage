import { Extension, type Editor } from "@tiptap/react";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { ReplaceAroundStep } from "@tiptap/pm/transform";
import { uid, type RichNode } from "./model";

export type TextBox = { width: number; minHeight: number; tint: boolean; free?: { x: number; y: number } };
const defaults: TextBox = { width: 0.7, minHeight: 80, tint: false };
const between = (value: unknown, min: number, max: number) => typeof value === "number" &&
  Number.isFinite(value) && value >= min && value <= max;

export function validTextBox(value: unknown): value is TextBox {
  const box = value as TextBox;
  return !!box && Object.keys(box).every(key => ["width", "minHeight", "tint", "free"].includes(key)) &&
    between(box.width, 0.2, 1) && between(box.minHeight, 48, 800) && typeof box.tint === "boolean" &&
    (box.free === undefined || (!!box.free && Object.keys(box.free).length === 2 &&
      between(box.free.x, 0, 1 - box.width + 0.00001) && between(box.free.y, 0, 100)));
}

// Keep the stored representation of ordinary paragraphs compatible with earlier clients.
export function notebookJSON(node: RichNode): RichNode {
  if (node.attrs?.textBox === null) delete node.attrs.textBox;
  node.content?.forEach(notebookJSON);
  return node;
}

export function selectedTextBox(editor: Editor) {
  const { $from, $to } = editor.state.selection;
  if ($from.depth !== 1 || !$from.sameParent($to) || !validTextBox($from.parent.attrs.textBox)) return;
  return { at: $from.before(), node: $from.parent, box: $from.parent.attrs.textBox as TextBox };
}

export function insertTextBox(editor: Editor) {
  const tr = editor.state.tr;
  const { $to } = tr.selection;
  const at = $to.depth ? $to.after(1) : $to.pos;
  const paragraph = editor.schema.nodes.paragraph;
  tr.insert(at, paragraph.create({ textBox: defaults, inkAnchor: uid() }));
  if (at + 2 === tr.doc.content.size) tr.insert(at + 2, paragraph.create());
  editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView());
  editor.view.focus();
}

export const NotebookTextBoxes = Extension.create({
  name: "notebookTextBoxes",
  priority: 1100,
  addGlobalAttributes() {
    return [{ types: ["paragraph"], attributes: { textBox: {
      default: null,
      parseHTML: () => null,
      renderHTML: attrs => {
        const box = attrs.textBox;
        if (!validTextBox(box)) return {};
        const horizontal = box.free ? `left:${box.free.x * 100}%;--text-box-y:${box.free.y};` : "";
        return { "data-notebook-text-box": box.tint ? "tinted" : "paper", "data-free-box": box.free ? "true" : null,
          style: `width:${box.width * 100}%;min-height:${box.minHeight}px;${horizontal}` };
      },
    } } }];
  },
  addKeyboardShortcuts() {
    return {
      Enter: () => !!selectedTextBox(this.editor) && this.editor.commands.setHardBreak(),
      "Mod-Enter": () => {
        const selected = selectedTextBox(this.editor);
        if (!selected) return false;
        const at = selected.at + selected.node.nodeSize;
        const tr = this.editor.state.tr.insert(at, this.editor.schema.nodes.paragraph.create());
        this.editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView());
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction(transactions, _, state) {
        if (!transactions.some(transaction => transaction.steps.some(step => step instanceof ReplaceAroundStep))) return null;
        const tr = state.tr;
        // A list transform keeps the selected words like an ordinary list item.
        state.doc.descendants((node, at, parent) => {
          if (node.attrs.textBox && parent?.type.name !== "doc")
            tr.setNodeMarkup(at, undefined, { ...node.attrs, textBox: null });
        });
        return tr.docChanged ? tr : null;
      },
    })];
  },
});
