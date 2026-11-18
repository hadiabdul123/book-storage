import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { X } from "lucide-react";
import { db } from "./db";
import type { Book, Locator, Rect } from "./model";
import { pdfLibrary, pdfOpenError, pdfOptions } from "./pdf";
import { downloadBook } from "./sync";

export function HighlightPdfPreview({ book, locator, onClose }: { book: Book; locator: Extract<Locator, { type: "pdf" }>; onClose: () => void }) {
  const pages = [...new Set([locator.page, ...(locator.regions || []).map(region => region.page)])].sort((a, b) => a - b);
  const [number, setNumber] = useState(locator.page);
  const [width, setWidth] = useState(0);
  const [document, setDocument] = useState<PDFDocumentProxy>();
  const [status, setStatus] = useState("Opening PDF…");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [layout, setLayout] = useState<{ width: number; height: number; rects: Rect[] }>();
  const surface = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const root = surface.current;
    if (!root) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.min(950, Math.floor(entry.contentRect.width))));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    setDocument(undefined); setLayout(undefined); setError(""); setStatus("Opening PDF…");
    async function open() {
      if (book.hash !== locator.hash || book.format !== "pdf") throw new Error("The original PDF edition is unavailable.");
      let file = await db.files.get(book.id);
      if (!active) return;
      if (!file) {
        setStatus("Downloading the original PDF…");
        file = await downloadBook(book);
      }
      if (!active) return;
      const pdf = await pdfLibrary();
      const bytes = await file.source.arrayBuffer();
      if (!active) return;
      task = pdf.getDocument(pdfOptions(bytes));
      const loaded = await task.promise.catch(error => { throw pdfOpenError(error); });
      if (active) setDocument(loaded);
    }
    void open().catch(e => { if (active) { setStatus(""); setError(e.message); } });
    return () => { active = false; if (task) void task.destroy().catch(() => {}); };
  }, [book.id, book.hash, locator.hash, attempt]);

  useEffect(() => {
    if (!document || width < 1 || !canvas.current) return;
    const target = canvas.current;
    let active = true;
    let paint: RenderTask | undefined;
    setLayout(undefined); setError(""); setStatus(`Rendering page ${number}…`);
    async function renderPage() {
      const page = await document!.getPage(number);
      if (!active) return;
      const natural = page.getViewport({ scale: 1 });
      const view = page.getViewport({ scale: width / natural.width });
      const ratio = Math.min(devicePixelRatio || 1, 2, 2200 / Math.max(view.width, view.height));
      target.width = Math.max(1, Math.ceil(view.width * ratio));
      target.height = Math.max(1, Math.ceil(view.height * ratio));
      paint = page.render({ canvas: target, viewport: view, transform: [ratio, 0, 0, ratio, 0, 0] });
      await paint.promise;
      if (!active) return;
      const rects: Rect[] = (locator.regions || []).filter(region => region.page === number).flatMap(region => region.rects).map(rect => {
        const [x, y] = view.convertToViewportPoint(rect[0], rect[1]);
        const [otherX, otherY] = view.convertToViewportPoint(rect[2], rect[3]);
        return [Math.min(x, otherX), Math.min(y, otherY), Math.abs(x - otherX), Math.abs(y - otherY)];
      });
      setLayout({ width: view.width, height: view.height, rects }); setStatus("");
    }
    void renderPage().catch(e => { if (active) { setStatus(""); setError(e.message); } });
    return () => { active = false; paint?.cancel(); };
  }, [document, number, width, locator]);

  return <section className="highlight-pdf-preview" aria-label="Source PDF page">
    <header><h3>PDF page {number}</h3><button className="icon-button" aria-label="Close PDF page" onClick={onClose}><X size={18} /></button></header>
    {pages.length > 1 && <label>Highlighted page<select value={number} onChange={e => setNumber(Number(e.target.value))}>
      {pages.map(page => <option key={page} value={page}>Page {page}</option>)}
    </select></label>}
    {status && <p role="status">{status}</p>}
    {error && <p role="alert">{error} <button className="text-button" onClick={() => setAttempt(n => n + 1)}>Retry PDF preview</button></p>}
    <div ref={surface} className="highlight-pdf-surface">
      <canvas ref={canvas} role="img" aria-label={`Page ${number} of ${book.title}`} hidden={!layout} />
      {layout && <svg aria-hidden="true" viewBox={`0 0 ${layout.width} ${layout.height}`}>
        {layout.rects.map(([x, y, width, height], i) => <rect key={i} x={x} y={y} width={width} height={height} />)}
      </svg>}
    </div>
  </section>;
}
