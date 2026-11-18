import { csvCell } from "./anchors";
import type { Annotation, Book } from "./model";
import { markdown } from "./richText";
import { sourceMarkdown } from "./sourceReferences";
import type { InkStroke } from "./inkTypes";
import { priorities, type HighlightFollowup, type HighlightStudy } from "./highlightStudy";
export function downloadText(name: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
export function exportAnnotations(
  items: Annotation[],
  books: Book[],
  format: "md" | "csv" | "json",
  ink: InkStroke[] = [],
  studyData?: { study: HighlightStudy[]; followups: HighlightFollowup[] },
) {
  const ids = new Set(items.filter(item => item.type !== "page-note").map(item => item.id));
  const study = studyData?.study.filter(item => ids.has(item.id)) || [];
  const followups = studyData?.followups.filter(item => ids.has(item.annotationId)) || [];
  const priority = new Map(study.map(item => [item.id, priorities[item.priority]]));
  const notes = new Map<string, string[]>();
  for (const item of followups) {
    if (!notes.has(item.annotationId)) notes.set(item.annotationId, []);
    notes.get(item.annotationId)!.push(item.text);
  }
  const hasStudy = !!(study.length || followups.length);
  const title = (a: Annotation) =>
    books.find((b) => b.id === a.bookId)?.title || "Unknown book";
  const link = (a: Annotation) =>
    `${location.origin}${location.pathname}#/read/${a.bookId}?annotation=${a.id}`;
  let text = "";
  if (format === "json")
    text = JSON.stringify(
      {
        schema: "leafmark.annotations",
        version: hasStudy ? 5 : 4,
        exportedAt: new Date().toISOString(),
        books: books.map(({ id, title, author, hash, format }) => ({
          id,
          title,
          author,
          hash,
          format,
        })),
        annotations: items,
        ink: ink.filter(s => s.target.type === "pdf"),
        ...(hasStudy ? { study, followups } : {}),
      },
      null,
      2,
    );
  if (format === "csv")
    text = [
      `Book,Quote,Note,Color,Tags,Created,Passage,Page,Type${hasStudy ? ",Priority,Follow-up notes" : ""}`,
      ...items.map((a) =>
        [
          title(a),
          a.text,
          a.note,
          a.color,
          a.tags.join("; "),
          a.createdAt,
          link(a),
          a.locator.type === "pdf" ? String(a.locator.page) : "",
          a.type || "highlight",
          ...(hasStudy ? [priority.get(a.id) || "", (notes.get(a.id) || []).join("\n\n")] : []),
        ]
          .map(csvCell)
          .join(","),
      ),
    ].join("\r\n");
  if (format === "md")
    text =
      "# Reading notes\n\n" +
      items
        .map(
          (a) =>
            `## ${title(a).replaceAll("#", "")}\n\n${a.text
              .split("\n")
              .map((line) => `> ${line}`)
              .join(
                "\n",
              )}\n\n${a.type === "page-note" && a.content ? markdown(a.content.document) : a.note}\n\n${(a.sources || []).map(s => `Source: ${sourceMarkdown(s)}`).join("\n")}\n\n[Return to passage](${link(a)})\n\n${a.tags.length ? `Tags: ${a.tags.join(", ")}\n\n` : ""}${priority.has(a.id) ? `Priority: ${priority.get(a.id)}\n\n` : ""}${notes.has(a.id) ? `### Follow-up notes\n\n${notes.get(a.id)!.join("\n\n")}\n\n` : ""}---\n`,
        )
        .join("\n");
  downloadText(
    `leafmark-notes-${new Date().toISOString().slice(0, 10)}.${format}`,
    text,
    format === "json"
      ? "application/json"
      : format === "csv"
        ? "text/csv"
        : "text/markdown",
  );
}
