import { PDFDocument, rgb } from "pdf-lib";
import { inkPath } from "./ink";
import type { InkStroke } from "./inkTypes";
import type { Book } from "./model";
import { downloadBook } from "./sync";
export async function exportMarkedPdf(book: Book, strokes: InkStroke[]) {
  try {
    const file = await downloadBook(book);
    const pdf = await PDFDocument.load(await file.source.arrayBuffer());
    for (const stroke of strokes) {
      if (stroke.target.type !== "pdf" || stroke.target.bookId !== book.id || stroke.target.hash !== book.hash) continue;
      const page = pdf.getPage(stroke.target.page - 1), height = page.getHeight();
      const channels = [1, 3, 5].map(i => parseInt(stroke.color.slice(i, i + 2), 16) / 255);
      page.drawSvgPath(inkPath(stroke, (x, y) => [x, height - y]), { x: 0, y: height, color: rgb(channels[0], channels[1], channels[2]), opacity: stroke.tool === "highlighter" ? .3 : 1 });
    }
    const bytes = await pdf.save(), url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: "application/pdf" }));
    const link = document.createElement("a"); link.href = url; link.download = `${book.title.replace(/[<>:"/\\|?*]/g, "-")}-marked.pdf`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (cause) { throw new Error("This PDF could not be exported with drawings. Your original book and saved drawings are safe. Try an unlocked PDF copy.", { cause }); }
}
