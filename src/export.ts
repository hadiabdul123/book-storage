import { csvCell } from "./anchors";
import type { Annotation, Book } from "./model";
import { markdown } from "./richText";
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
) {
  const title = (a: Annotation) =>
    books.find((b) => b.id === a.bookId)?.title || "Unknown book";
  const link = (a: Annotation) =>
    `${location.origin}${location.pathname}#/read/${a.bookId}?annotation=${a.id}`;
  let text = "";
  if (format === "json")
    text = JSON.stringify(
      {
        schema: "leafmark.annotations",
        version: 2,
        exportedAt: new Date().toISOString(),
        books: books.map(({ id, title, author, hash, format }) => ({
          id,
          title,
          author,
          hash,
          format,
        })),
        annotations: items,
      },
      null,
      2,
    );
  if (format === "csv")
    text = [
      "Book,Quote,Note,Color,Tags,Created,Passage,Page,Type",
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
              )}\n\n${a.type === "page-note" && a.content ? markdown(a.content.document) : a.note}\n\n[Return to passage](${link(a)})\n\n${a.tags.length ? `Tags: ${a.tags.join(", ")}\n\n` : ""}---\n`,
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
