import ePub from "epubjs";
import DOMPurify from "dompurify";
import JSZip from "jszip";
import { db, list, save } from "./db";
import { type Book, type Format, now, uid } from "./model";
import { pdfLibrary, pdfOptions, pdfOpenError } from "./pdf";

export type ImportResult = { book: Book; warnings: string[] };
export function sanitize(html: string) {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      "script",
      "iframe",
      "form",
      "input",
      "object",
      "embed",
      "video",
      "audio",
      "link",
      "meta",
      "style",
    ],
    FORBID_ATTR: ["srcset", "style"],
    ALLOW_DATA_ATTR: false,
  });
}
async function thumbnail(source: string): Promise<string> {
  const img = new Image();
  img.src = source;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = 240;
  canvas.height = Math.round((img.height * 240) / img.width);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/webp", 0.78);
}
export async function importBook(file: File): Promise<ImportResult> {
  const warnings: string[] = [];
  const format = file.name.split(".").pop()?.toLowerCase() as Format;
  if (!["epub", "pdf", "docx"].includes(format))
    throw new Error("Choose an EPUB, PDF, or DOCX file.");
  if (!file.size) throw new Error("This file is empty.");
  const buffer = await file.arrayBuffer();
  if (format === "pdf") {
    if (!new TextDecoder().decode(buffer.slice(0, 1024)).includes("%PDF-"))
      throw new Error("This file does not contain a valid PDF header.");
  } else {
    const archive = await JSZip.loadAsync(buffer);
    if (
      !archive.file(
        format === "epub" ? "META-INF/container.xml" : "word/document.xml",
      )
    )
      throw new Error(`This is not a valid ${format.toUpperCase()} document.`);
  }
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const duplicate = (await list("book")).find((b) => b.hash === hash);
  if (duplicate)
    throw new Error(`“${duplicate.title}” is already in your library.`);
  const id = uid();
  const book: Book = {
    id,
    title: file.name.replace(/\.[^.]+$/, ""),
    author: "Unknown author",
    description: "",
    format,
    filename: file.name,
    hash,
    bytes: file.size,
    tags: [],
    status: "unread",
    addedAt: now(),
    sourcePath: `${id}/source.${format}`,
  };
  let derived: Blob | undefined;
  if (format === "epub") {
    const epub = ePub(buffer);
    try {
      await epub.opened;
      const metadata = await epub.loaded.metadata;
      book.title = metadata.title || book.title;
      book.author = metadata.creator || book.author;
      book.description = DOMPurify.sanitize(metadata.description || "", {
        ALLOWED_TAGS: [],
      });
      const cover = await epub.coverUrl();
      if (cover) {
        try {
          book.cover = await thumbnail(cover);
        } catch (error) {
          console.warn("EPUB cover generation failed", error);
          warnings.push("Book added, but its cover could not be created. You can still read it.");
        }
      }
    } finally {
      epub.destroy();
    }
  } else if (format === "pdf") {
    const pdf = await pdfLibrary(),
      task = pdf.getDocument(pdfOptions(buffer.slice(0)));
    try {
      const document = await task.promise.catch((error: unknown) => {
        console.error("PDF document loading failed", error);
        throw pdfOpenError(error);
      });
      try {
        const metadata = await document.getMetadata();
        const info = metadata.info as { Title?: string; Author?: string };
        book.title = info.Title || book.title;
        book.author = info.Author || book.author;
      } catch (error) {
        console.warn("PDF metadata extraction failed", error);
        warnings.push("Book added using its filename because its metadata could not be read.");
      }
      try {
        const page = await document.getPage(1),
          viewport = page.getViewport({ scale: 0.4 });
        const canvas = window.document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvas, viewport }).promise;
        book.cover = await thumbnail(canvas.toDataURL());
      } catch (error) {
        console.warn("PDF cover generation failed", error);
        warnings.push("Book added, but its cover could not be created. You can still open it to read the available pages.");
      }
    } finally {
      // Cleanup must not discard a successfully loaded book or mask its error.
      await task.destroy().catch((error: unknown) => console.warn("PDF import cleanup failed", error));
    }
  } else {
    const mammoth = await import("mammoth");
    const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
    derived = new Blob([sanitize(result.value)], { type: "text/html" });
    book.derivedPath = `${id}/reading-v1.html`;
  }
  await db.files.put({ id, source: file, derived, uploaded: false });
  try {
    await save("book", book);
  } catch (error) {
    await db.files.delete(id);
    throw error;
  }
  await navigator.storage?.persist?.().catch(() => false);
  return { book, warnings };
}
