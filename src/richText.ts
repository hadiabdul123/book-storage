import type { RichNode } from "./model";
export const emptyDocument = (): RichNode => ({
  type: "doc",
  content: [{ type: "paragraph" }],
});
export const paragraph = (text: string): RichNode => ({
  type: "paragraph",
  content: text ? [{ type: "text", text }] : [],
});
export function plainText(node: RichNode): string {
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  return (node.content || [])
    .map(plainText)
    .join(["paragraph", "heading"].includes(node.type) ? "" : "\n");
}
export function markdown(node: RichNode): string {
  const children = () => (node.content || []).map(markdown).join("");
  if (node.type === "text") {
    let text = (node.text || "").replace(/([\\`*_\[\]<>])/g, "\\$1");
    for (const mark of node.marks || [])
      text = mark.type === "bold" ? `**${text}**` : `*${text}*`;
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
        n.marks.some((m: any) => !m || !["bold", "italic"].includes(m.type)))
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
      doc: ["paragraph", "heading", "bulletList", "orderedList", "taskList"],
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
