export const readingPointerKey = "leafmark-reading-pointer-v1";
export type ReadingPointerSettings = {
  pointer: boolean;
  trail: boolean;
  shape: "arrow" | "dot" | "ring" | "underline";
  size: number;
  color: string;
  length: number;
  thickness: number;
  opacity: number;
  fade: number;
};
export const defaultReadingPointer: ReadingPointerSettings = {
  pointer: false, trail: false, shape: "arrow", size: 32, color: "#2684ff",
  length: 160, thickness: 4, opacity: 50, fade: 400,
};
export function normalizeReadingPointer(value: unknown): ReadingPointerSettings {
  const p = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const number = (key: keyof ReadingPointerSettings, min: number, max: number) =>
    typeof p[key] === "number" && Number.isFinite(p[key])
      ? Math.max(min, Math.min(max, Math.round(p[key] as number)))
      : defaultReadingPointer[key] as number;
  return {
    pointer: p.pointer === true, trail: p.trail === true,
    shape: ["arrow", "dot", "ring", "underline"].includes(p.shape as string)
      ? p.shape as ReadingPointerSettings["shape"] : "arrow",
    color: typeof p.color === "string" && /^#[\da-f]{6}$/i.test(p.color) ? p.color : defaultReadingPointer.color,
    size: number("size", 16, 64), length: number("length", 40, 400),
    thickness: number("thickness", 2, 16), opacity: number("opacity", 20, 80), fade: number("fade", 150, 1000),
  };
}
export function readReadingPointer(storage: Pick<Storage, "getItem">): ReadingPointerSettings {
  try {
    const saved = JSON.parse(storage.getItem(readingPointerKey) || "null");
    return normalizeReadingPointer(saved?.version === 1 ? saved.settings : null);
  } catch { return { ...defaultReadingPointer }; }
}
export function saveReadingPointer(storage: Pick<Storage, "setItem">, settings: ReadingPointerSettings) {
  storage.setItem(readingPointerKey, JSON.stringify({ version: 1, settings: normalizeReadingPointer(settings) }));
}

export type TrailPoint = { x: number; y: number; time: number };
/** Retain a bounded recent path, cutting the oldest segment at the length limit. */
export function trimReadingTrail(points: TrailPoint[], length: number, now: number, fade: number) {
  const recent = points.filter(p => now - p.time < fade).slice(-96);
  let distance = 0;
  for (let i = recent.length - 1; i > 0; i--) {
    const a = recent[i], b = recent[i - 1];
    const segment = Math.hypot(a.x - b.x, a.y - b.y);
    if (distance + segment > length) {
      const ratio = (length - distance) / segment;
      return [{ x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio,
        time: a.time + (b.time - a.time) * ratio }, ...recent.slice(i)];
    }
    distance += segment;
  }
  return recent;
}
