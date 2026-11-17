import { inkPath } from "./ink";
import type { InkStroke } from "./inkTypes";
export function InkPreview({ strokes }: { strokes: InkStroke[] }) {
  const pdf = strokes[0]?.target.type === "pdf", project = (x: number, y: number) => [x, pdf ? -y : y];
  let left = 0, top = 0, right = 100, bottom = 100;
  for (const s of strokes) for (const point of s.points) { const [x, y] = project(point[0], point[1]); left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
  return <svg className="ink-preview" viewBox={`${left - 20} ${top - 20} ${right - left + 40} ${bottom - top + 40}`} role="img" aria-label="Drawing preview">{strokes.map(s => <path key={s.id} d={inkPath(s, project)} fill={s.color} opacity={s.tool === "highlighter" ? .3 : 1} />)}</svg>;
}
