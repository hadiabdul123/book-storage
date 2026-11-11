import type { ReactNode } from "react";
import type { RichNode } from "./model";
export function RichTextView({ document }: { document: RichNode }) {
  function render(n: RichNode, key: number): ReactNode {
    const children = n.content?.map(render);
    if (n.type === "text") {
      let result: ReactNode = n.text;
      for (const mark of n.marks || [])
        result =
          mark.type === "bold" ? <strong>{result}</strong> : <em>{result}</em>;
      return <span key={key}>{result}</span>;
    }
    if (n.type === "hardBreak") return <br key={key} />;
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
