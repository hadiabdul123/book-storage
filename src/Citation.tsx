import { Node } from "@tiptap/react";
import type { SourceRef } from "./researchTypes";
import { sourceHref, sourceLabel, validSourceRef } from "./sourceReferences";

export const CitationExtension = Node.create({
  name: "citation", group: "block", atom: true, selectable: true,
  addAttributes: () => ({ source: { default: null, rendered: false } }),
  // Imported/pasted HTML never supplies trusted source metadata.
  parseHTML: () => [],
  renderHTML({ node }) {
    const source = node.attrs.source as SourceRef;
    if (!validSourceRef(source)) return ["p", {}, "Source unavailable"];
    return ["p", { class: "source-citation", contenteditable: "false" },
      ["a", { href: sourceHref(source), ...(source.kind === "web" ? { target: "_blank", rel: "noopener noreferrer" } : {}) }, sourceLabel(source)]];
  },
});
export function SourceLink({ source }: { source: SourceRef }) {
  if (!validSourceRef(source)) return <span>Source unavailable</span>;
  return <a className="source-citation" href={sourceHref(source)}
    {...(source.kind === "web" ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
    <span>{source.kind === "web" ? "Web" : source.kind === "book" ? "Book" : "Note"}</span> {sourceLabel(source)}
    {source.retrievedAt && <small> Retrieved {new Date(source.retrievedAt).toLocaleDateString()}</small>}
  </a>;
}
