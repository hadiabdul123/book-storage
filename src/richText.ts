import type { RichNode } from "./model";
import { validSourceRef, sourceMarkdown } from "./sourceReferences";
const safeColor = (v: unknown) => typeof v === "string" && (/^#[a-f0-9]{6}$/i.test(v) || /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/i.test(v));
export function validRichMark(m: any) {
  if (!m || typeof m !== "object") return false;
  if (["bold", "italic", "underline"].includes(m.type)) return m.attrs === undefined;
  if (m.type === "highlight" || m.type === "textStyle") return !!m.attrs && Object.keys(m.attrs).every(k => k === "color") && safeColor(m.attrs.color);
  if (m.type === "link") return !!m.attrs && typeof m.attrs.href === "string" && m.attrs.href.length <= 4000 && /^(https?:\/\/|mailto:)[^\s]+$/i.test(m.attrs.href) && Object.keys(m.attrs).every(k => ["href", "target", "rel", "class"].includes(k)) && (m.attrs.target == null || ["_blank", "_self"].includes(m.attrs.target)) && m.attrs.class == null;
  return false;
}
export const emptyDocument = (): RichNode => ({
  type: "doc",
  content: [{ type: "paragraph" }],
});
export const paragraph = (text: string): RichNode => ({
  type: "paragraph",
  content: text ? [{ type: "text", text }] : [],
});
export function plainText(node: RichNode): string {
  if (node.type === "drawing") return "[Drawing]";
  if (node.type === "citation") return validSourceRef(node.attrs?.source) ? `Source: ${node.attrs!.source.title}` : "";
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  return (node.content || [])
    .map(plainText)
    .join(["paragraph", "heading"].includes(node.type) ? "" : "\n");
}
export function markdown(node: RichNode): string {
  if (node.type === "drawing") return `![Drawing](drawings/${node.attrs?.blockId}.svg)\n\n`;
  if (node.type === "citation") return validSourceRef(node.attrs?.source) ? `Source: ${sourceMarkdown(node.attrs!.source)}\n\n` : "";
  const children = () => (node.content || []).map(markdown).join("");
  if (node.type === "text") {
    let text = (node.text || "").replace(/([\\`*_\[\]<>])/g, "\\$1");
    for (const mark of node.marks || []) {
      if (mark.type === "bold") text = `**${text}**`;
      if (mark.type === "italic") text = `*${text}*`;
      if (mark.type === "underline") text = `<u>${text}</u>`;
      if (mark.type === "highlight" && safeColor(mark.attrs?.color)) text = `<mark style="background-color:${mark.attrs!.color}">${text}</mark>`;
      if (mark.type === "textStyle" && safeColor(mark.attrs?.color)) text = `<span style="color:${mark.attrs!.color}">${text}</span>`;
      if (mark.type === "link" && validRichMark(mark)) text = `[${text}](${mark.attrs!.href.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
    }
    return text;
  }
  if (node.type === "hardBreak") return "  \n";
  if (node.type === "heading")
    return `${"#".repeat(node.attrs?.level || 2)} ${children()}\n\n`;
  if (node.type === "paragraph") return `${children()}\n\n`;
  if (["bulletList", "orderedList", "taskList"].includes(node.type))
    return (
      (node.content || [])
        .map((item, i) => {
          const prefix =
            node.type === "taskList"
              ? `- [${item.attrs?.checked ? "x" : " "}] `
              : node.type === "orderedList"
                ? `${(node.attrs?.start || 1) + i}. `
                : "- ";
          return prefix + markdown(item).trim().replace(/\n/g, "\n  ") + "\n";
        })
        .join("") + "\n"
    );
  return children();
}
export function validRichDocument(value: unknown): value is RichNode {
  let count = 0;
  const allowed = new Set([
    "doc",
    "paragraph",
    "text",
    "heading",
    "hardBreak",
    "bulletList",
    "orderedList",
    "listItem",
    "taskList",
    "taskItem",
    "citation",
    "drawing",
  ]);
  function check(n: any, depth: number): boolean {
    if (
      !n ||
      typeof n !== "object" ||
      depth > 30 ||
      ++count > 10000 ||
      !allowed.has(n.type)
    )
      return false;
    if (n.type === "citation") return n.text === undefined && n.content === undefined && n.marks === undefined &&
      !!n.attrs && Object.keys(n.attrs).length === 1 && validSourceRef(n.attrs.source);
    if (n.type === "drawing") return n.text === undefined && n.content === undefined && n.marks === undefined && !!n.attrs && Object.keys(n.attrs).every(k => ["blockId", "height"].includes(k)) && typeof n.attrs.blockId === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(n.attrs.blockId) && Number.isFinite(n.attrs.height) && n.attrs.height >= 140 && n.attrs.height <= 800;
    if (
      n.type === "text" &&
      (typeof n.text !== "string" || n.text.length > 100000)
    )
      return false;
    if (n.type === "text" && (!n.text.length || n.content !== undefined))
      return false;
    if (n.type !== "text" && n.text !== undefined) return false;
    if (n.type !== "text" && n.marks !== undefined) return false;
    if (
      n.marks !== undefined &&
      (!Array.isArray(n.marks) ||
        n.marks.some((m: any) => !validRichMark(m)))
    )
      return false;
    if (n.attrs !== undefined) {
      if (!n.attrs || typeof n.attrs !== "object" || Array.isArray(n.attrs))
        return false;
      const keys: Record<string, string[]> = {
        heading: ["level"],
        orderedList: ["start", "type"],
        taskItem: ["checked"],
      };
      if (Object.keys(n.attrs).some((k) => !(keys[n.type] || []).includes(k)))
        return false;
      if (n.type === "heading" && ![1, 2, 3].includes(n.attrs.level))
        return false;
      if (n.type === "taskItem" && typeof n.attrs.checked !== "boolean")
        return false;
      if (
        n.type === "orderedList" &&
        (!Number.isInteger(n.attrs.start) || n.attrs.start < 1)
      )
        return false;
    }
    const children: Record<string, string[]> = {
      doc: ["paragraph", "heading", "bulletList", "orderedList", "taskList", "citation", "drawing"],
      paragraph: ["text", "hardBreak"],
      heading: ["text", "hardBreak"],
      bulletList: ["listItem"],
      orderedList: ["listItem"],
      taskList: ["taskItem"],
      listItem: [
        "paragraph",
        "heading",
        "bulletList",
        "orderedList",
        "taskList",
      ],
      taskItem: [
        "paragraph",
        "heading",
        "bulletList",
        "orderedList",
        "taskList",
      ],
    };
    return (
      n.content === undefined ||
      (Array.isArray(n.content) &&
        n.content.every(
          (c: any) =>
            c &&
            (children[n.type] || []).includes(c.type) &&
            check(c, depth + 1),
        ))
    );
  }
  return check(value, 0) && (value as RichNode).type === "doc";
}
export function combineDocuments(a: RichNode, b: RichNode): RichNode {
  return {
    type: "doc",
    content: [
      paragraph("This device"),
      ...(a.content || []),
      paragraph("Other device"),
      ...(b.content || []),
    ],
  };
}
