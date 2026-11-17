import type { ReactNode } from "react";
import type { RichNode } from "./model";
import { SourceLink } from "./Citation";
import { validSourceRef } from "./sourceReferences";
import { validRichMark } from "./richText";
export function RichTextView({ document }: { document: RichNode }) {
  function render(n: RichNode, key: number): ReactNode {
    if (n.type === "citation") return validSourceRef(n.attrs?.source) ? <p key={key}><SourceLink source={n.attrs!.source} /></p> : null;
    const children = n.content?.map(render);
    if (n.type === "text") {
      let result: ReactNode = n.text;
      for (const mark of n.marks || []) {
        if (!validRichMark(mark)) continue;
        if (mark.type === "bold") result = <strong>{result}</strong>;
        if (mark.type === "italic") result = <em>{result}</em>;
        if (mark.type === "underline") result = <u>{result}</u>;
        if (mark.type === "highlight") result = <mark style={{ backgroundColor: mark.attrs!.color }}>{result}</mark>;
        if (mark.type === "textStyle") result = <span style={{ color: mark.attrs!.color }}>{result}</span>;
        if (mark.type === "link") result = <a href={mark.attrs!.href} target="_blank" rel="noopener noreferrer">{result}</a>;
      }
      return <span key={key}>{result}</span>;
    }
    if (n.type === "hardBreak") return <br key={key} />;
    if (n.type === "drawing") return <p key={key}>Drawing — open the notebook page to view and edit it.</p>;
    if (n.type === "paragraph") return <p key={key}>{children}</p>;
    if (n.type === "heading") return <h3 key={key}>{children}</h3>;
    if (n.type === "orderedList")
      return (
        <ol key={key} start={n.attrs?.start}>
          {children}
        </ol>
      );
    if (n.type === "bulletList" || n.type === "taskList")
      return (
        <ul
          key={key}
          className={n.type === "taskList" ? "notebook-checklist" : undefined}
        >
          {children}
        </ul>
      );
    if (n.type === "listItem") return <li key={key}>{children}</li>;
    if (n.type === "taskItem")
      return (
        <li key={key}>
          <span aria-label={n.attrs?.checked ? "Completed" : "Incomplete"}>
            {n.attrs?.checked ? "☑" : "☐"}
          </span>
          <div>{children}</div>
        </li>
      );
    return <div key={key}>{children}</div>;
  }
  return <div className="rich-note">{render(document, 0)}</div>;
}
