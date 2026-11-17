import type { PageViewport } from "pdfjs-dist";
import type { Rect } from "../model";

/** A cropped viewport keeps every consumer in original PDF coordinates. */
export function pageViewport(base: PageViewport, crop: Rect | undefined, scale: number, rotation: number): PageViewport {
  const Viewport = base.constructor as new (options: { viewBox: number[]; userUnit: number; scale: number; rotation: number }) => PageViewport;
  return new Viewport({ viewBox: crop ? [...crop] : [...base.viewBox], userUnit: base.userUnit, scale, rotation });
}
/** Conservative raster bounds include figures, page numbers and marginal notes. */
export function blankMargins(data: Uint8ClampedArray, width: number, height: number): Rect | undefined {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (data[i + 3] < 20 || Math.min(data[i], data[i + 1], data[i + 2]) >= 246) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (right < 0) return;
  const xpad = Math.ceil(width * .035), ypad = Math.ceil(height * .025);
  const result: Rect = [Math.max(0, Math.min(width * .12, left - xpad)), Math.max(0, Math.min(height * .12, top - ypad)), Math.min(width, Math.max(width * .88, right + 1 + xpad)), Math.min(height, Math.max(height * .88, bottom + 1 + ypad))];
  return result[0] + result[1] + width - result[2] + height - result[3] > 4 ? result : undefined;
}
