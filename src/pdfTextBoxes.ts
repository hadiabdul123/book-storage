import type { PageViewport } from "pdfjs-dist";
import type { Book, Rect } from "./model";

type Point = [number, number];
export type BoxRotation = 0 | 90 | 180 | 270;
export type PdfTextBox = {
  id: string;
  bookId: string;
  hash: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: BoxRotation;
  text: string;
  fontSize: number;
  tint: boolean;
  createdAt: string;
  updatedAt: string;
};

export const boxTextLimit = 4000;
export const boxFontSizes = [10, 12, 16, 20, 24, 32] as const;
export const boxFont = "Arial, sans-serif";
export const boxPadding = 6;
export const boxInk = "#232a32";
export const boxPaper = (tint: boolean) => tint ? "#fff0b7" : "#fffdf8";

const axes: Record<BoxRotation, [Point, Point]> = {
  0: [[1, 0], [0, -1]],
  90: [[0, 1], [1, 0]],
  180: [[-1, 0], [0, 1]],
  270: [[0, -1], [-1, 0]],
};
const project = ([x, y]: Point, [a, b]: Point) => x * a + y * b;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const numberWithin = (value: unknown, low: number, high: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;

export function validPdfTextBox(item: unknown): item is PdfTextBox {
  if (!item || typeof item !== "object") return false;
  const b = item as PdfTextBox;
  const id = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 100;
  const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
  return id(b.id) && id(b.bookId) && typeof b.hash === "string" && /^[a-f0-9]{64}$/.test(b.hash) &&
    Number.isInteger(b.page) && numberWithin(b.page, 1, 100000) &&
    numberWithin(b.x, -100000, 100000) && numberWithin(b.y, -100000, 100000) &&
    numberWithin(b.width, 1, 100000) && numberWithin(b.height, 1, 100000) &&
    [0, 90, 180, 270].includes(b.rotation) && numberWithin(b.fontSize, 10, 32) &&
    typeof b.text === "string" && !!b.text.trim() && b.text.length <= boxTextLimit &&
    typeof b.tint === "boolean" && date(b.createdAt) && date(b.updatedAt);
}

export function belongsToPdf(box: PdfTextBox, book: Book) {
  return book.format === "pdf" && box.bookId === book.id && box.hash === book.hash;
}

export function boxPoint(box: PdfTextBox, right: number, down: number): Point {
  const [u, v] = axes[box.rotation];
  return [box.x + u[0] * right + v[0] * down, box.y + u[1] * right + v[1] * down];
}

export function boxDelta(rotation: BoxRotation, from: Point, to: Point): Point {
  const [u, v] = axes[rotation];
  const delta: Point = [to[0] - from[0], to[1] - from[1]];
  return [project(delta, u), project(delta, v)];
}

export function fitPdfTextBox(box: PdfTextBox, bounds: Rect, keepAnchor = false): PdfTextBox {
  const [u, v] = axes[box.rotation];
  const a: Point = [bounds[0], bounds[1]], b: Point = [bounds[2], bounds[3]];
  const minRight = Math.min(project(a, u), project(b, u));
  const maxRight = Math.max(project(a, u), project(b, u));
  const minDown = Math.min(project(a, v), project(b, v));
  const maxDown = Math.max(project(a, v), project(b, v));
  const startRight = project([box.x, box.y], u), startDown = project([box.x, box.y], v);
  const w = maxRight - (keepAnchor ? clamp(startRight, minRight, maxRight - 1) : minRight);
  const h = maxDown - (keepAnchor ? clamp(startDown, minDown, maxDown - 1) : minDown);
  const width = clamp(box.width, Math.min(48, w), w);
  const height = clamp(box.height, Math.min(32, h), h);
  const right = clamp(startRight, minRight, maxRight - width);
  const down = clamp(startDown, minDown, maxDown - height);
  return { ...box, x: u[0] * right + v[0] * down, y: u[1] * right + v[1] * down, width, height };
}

export function boxTransform(box: PdfTextBox, viewport: PageViewport) {
  const [x, y] = viewport.convertToViewportPoint(box.x, box.y);
  const [ux, uy] = viewport.convertToViewportPoint(...boxPoint(box, 1, 0));
  const [vx, vy] = viewport.convertToViewportPoint(...boxPoint(box, 0, 1));
  return `matrix(${ux - x},${uy - y},${vx - x},${vy - y},${x},${y})`;
}

let measure: CanvasRenderingContext2D | undefined;
export function layoutBoxText(box: PdfTextBox) {
  measure ??= document.createElement("canvas").getContext("2d")!;
  measure.font = `${box.fontSize}px ${boxFont}`;
  const available = Math.max(1, box.width - boxPadding * 2);
  const fits = (value: string) => measure!.measureText(value).width <= available;
  const lines: string[] = [];
  for (const paragraph of box.text.replace(/\r\n?/g, "\n").split("\n")) {
    let line = "";
    for (let word of paragraph.split(/(\s+)/u)) {
      if (fits(line + word)) { line += word; continue; }
      if (line.trim()) lines.push(line.trimEnd());
      line = "";
      word = word.trimStart();
      if (fits(word)) { line = word; continue; }
      for (const character of word) {
        if (line && !fits(line + character)) { lines.push(line); line = ""; }
        line += character;
      }
    }
    lines.push(line.trimEnd());
  }
  const lineHeight = box.fontSize * 1.3;
  return { lines, lineHeight, height: lines.length * lineHeight + boxPadding * 2,
    widthFits: lines.every(fits) };
}

export function boxAppearance(box: PdfTextBox) {
  const { lines, lineHeight } = layoutBoxText(box);
  const canvas = document.createElement("canvas");
  const scale = Math.min(3, 4096 / Math.max(box.width, box.height), Math.sqrt(4_000_000 / (box.width * box.height)));
  canvas.width = Math.max(1, Math.ceil(box.width * scale));
  canvas.height = Math.max(1, Math.ceil(box.height * scale));
  const context = canvas.getContext("2d")!;
  context.scale(canvas.width / box.width, canvas.height / box.height);
  context.fillStyle = boxPaper(box.tint);
  context.fillRect(0, 0, box.width, box.height);
  context.fillStyle = boxInk;
  context.font = `${box.fontSize}px ${boxFont}`;
  context.textBaseline = "middle";
  lines.forEach((line, index) => context.fillText(line, boxPadding, boxPadding + (index + 0.5) * lineHeight));
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not render a text box.")), "image/png");
  }).finally(() => { canvas.width = canvas.height = 0; });
}
