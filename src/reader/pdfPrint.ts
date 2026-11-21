import type { PDFPageProxy, PageViewport } from "pdfjs-dist";
import type { TextContent, TextItem } from "pdfjs-dist/types/src/display/api";
import type { PrintFace } from "../ReaderComfort";

const textOperations = [
  "save", "restore", "transform", "dependency", "beginText", "endText", "setFont", "setTextMatrix",
  "moveText", "setLeadingMoveText", "nextLine", "setLeading", "showText", "showSpacedText",
  "setFillRGBColor", "beginMarkedContent", "beginMarkedContentProps", "endMarkedContent",
];

// Use the gaps in the rendered ink to keep every word in its original position.
// If spacing within a word is indistinguishable from spacing between words, skip the line.
function inkRuns(strip: ImageData, wordCount: number) {
  const occupied = new Uint8Array(strip.width);
  let darkest = 255;
  for (let y = 0; y < strip.height; y++) {
    for (let x = 0; x < strip.width; x++) {
      const index = (y * strip.width + x) * 4;
      const shade = Math.min(strip.data[index], strip.data[index + 1], strip.data[index + 2]);
      if (strip.data[index + 3] !== 255) return;
      if (shade < 250 && (x === 0 || y === 0 || x === strip.width - 1 || y === strip.height - 1)) return;
      if (shade < 195) occupied[x] = 1;
      darkest = Math.min(darkest, shade);
    }
  }
  const start = occupied.indexOf(1), end = occupied.lastIndexOf(1);
  if (start < 0) return;
  const gaps: { left: number; right: number }[] = [];
  let left = start;
  for (let x = start + 1; x <= end; x++) {
    if (occupied[x - 1] && !occupied[x]) left = x;
    if (!occupied[x - 1] && occupied[x]) gaps.push({ left, right: x });
  }
  const length = (gap: typeof gaps[number]) => gap.right - gap.left;
  gaps.sort((a, b) => length(b) - length(a));
  if (gaps.length < wordCount - 1 || (gaps[wordCount - 1] && length(gaps[wordCount - 2]) <= length(gaps[wordCount - 1]) + 1)) return;
  const spaces = gaps.slice(0, wordCount - 1).sort((a, b) => a.left - b.left);
  return { darkest, words: [start, ...spaces.map(s => s.right)].map((x, i) => ({ x, width: (spaces[i]?.left ?? end + 1) - x })) };
}

// Only repaint plain prose on text-only pages. The PDF text layer, hit targets,
// annotations and source bytes continue to use the original coordinates.
export async function applyPrintFace(canvas: HTMLCanvasElement, page: PDFPageProxy, view: PageViewport,
  text: TextContent, face: PrintFace, ops: Record<string,number>, signal:AbortSignal) {
  if (face === "original" || view.rotation % 360 || text.items.length > 600) return;
  const items = text.items.filter((i):i is TextItem => "str" in i && !!i.str.trim());
  const prose = items.filter(i => {
    const [a,b,c,d] = i.transform;
    return i.dir === "ltr" && a > 0 && d > 0 && Math.abs(b)+Math.abs(c)<.01 &&
      i.height >= 7 && i.height <= 16 && i.width >= i.height*10 &&
      /^[\p{Script=Latin}\p{M}0-9\s,.;:!?'’‘“”"()—–-]+$/u.test(i.str) &&
      i.str.trim().split(/\s+/).length >= 5 && /[a-z]{2}/.test(i.str) && !/\s{3,}/.test(i.str);
  });
  if (prose.length < 2) return;
  const list = await page.getOperatorList();
  signal.throwIfAborted();
  const safe = new Set(textOperations.map(name => ops[name]));
  if (list.fnArray.some((op, i) => !safe.has(op) || (op === ops.setFillRGBColor &&
    !/^#([0-9a-f]{2})\1\1$/i.test(String(list.argsArray[i]?.[0]))))) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const ratio = canvas.width/view.width, sy = canvas.height/view.height;
  const target = face === "serif" ? "Georgia, serif" : "Arial, sans-serif";
  ctx.save();
  try {
    for (const line of prose) {
      const [,,,,x,y] = line.transform;
      const font = page.commonObjs.has(line.fontName) && page.commonObjs.get(line.fontName);
      if (!font || font.bold || font.black || font.italic || font.vertical || font.isType3Font || /bold|italic|oblique|symbol|math|mono/i.test(font.fallbackName || "")) continue;
      if (!prose.some(other => other !== line && other.fontName === line.fontName && Math.abs(other.height-line.height)<.1 &&
        Math.abs(other.transform[4]-x)<line.height*2 && Math.abs(other.transform[5]-y)>=line.height &&
        Math.abs(other.transform[5]-y)<line.height*1.9)) continue;
      // Split runs, equations and columns sharing this baseline are ambiguous.
      if (items.some(other=>other !== line && Math.abs(other.transform[5]-y)<line.height*.8)) continue;
      const [left,base] = view.convertToViewportPoint(x,y);
      const height = line.height * view.scale * sy, baseline = base*sy, start = left*ratio, width = line.width*view.scale*ratio;
      const x0=Math.floor(start)-3, x1=Math.ceil(start+width)+3;
      const y0=Math.floor(baseline-height), y1=Math.ceil(baseline+height*.28);
      if (x0<0 || x1>canvas.width || y0<0 || y1>canvas.height || (x1-x0)*(y1-y0)>450000) continue;
      ctx.font = height + "px " + target;
      const words = line.str.trim().split(/\s+/);
      const strip = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
      const ink = inkRuns(strip, words.length);
      if (!ink) continue;
      const fitted = words.map((word, i) => {
        const metrics = ctx.measureText(word);
        const scale = ink.words[i].width / (metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight);
        return { word, scale, x: x0 + ink.words[i].x + metrics.actualBoundingBoxLeft * scale };
      });
      if (fitted.some(({ scale }) => !Number.isFinite(scale) || scale < .72 || scale > 1.36)) continue;
      ctx.fillStyle = "#fff";
      ctx.fillRect(x0, y0, strip.width, strip.height);
      ctx.fillStyle = "rgb(" + ink.darkest + " " + ink.darkest + " " + ink.darkest + ")";
      for (const { word, scale, x } of fitted) {
        ctx.save();
        ctx.translate(x, baseline);
        ctx.scale(scale, 1);
        ctx.fillText(word, 0, 0);
        ctx.restore();
      }
      canvas.dataset.printFace = face;
    }
  } finally { ctx.restore(); }
}
