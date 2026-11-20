export type InkPoint = [number, number, number];
export type InkTarget = { type: "pdf"; bookId: string; hash: string; page: number } | { type: "notebook"; noteId: string; blockId: string };
export type InkStyle = { tool: "pen" | "highlighter" | "eraser" | "lasso"; color: string; width: number; penOnly?: boolean };
export type InkStroke = {
  id: string; target: InkTarget; tool: "pen" | "highlighter"; color: string; width: number;
  points: InkPoint[]; createdAt: string;
};
export const defaultInkStyle: InkStyle = { tool: "pen", color: "#315c86", width: 2 };
export function sameInkTarget(a: InkTarget, b: InkTarget) { return a.type === b.type && (a.type === "pdf" && b.type === "pdf" ? a.bookId === b.bookId && a.hash === b.hash && a.page === b.page : a.type === "notebook" && b.type === "notebook" && a.noteId === b.noteId && a.blockId === b.blockId); }
export function validInkStroke(v: any): v is InkStroke {
  return !!v && typeof v.id === "string" && v.id.length > 0 && v.id.length <= 100 &&
    typeof v.createdAt === "string" && Number.isFinite(Date.parse(v.createdAt)) &&
    ["pen", "highlighter"].includes(v.tool) && /^#[a-f0-9]{6}$/i.test(v.color) &&
    Number.isFinite(v.width) && v.width > 0 && v.width <= 40 &&
    Array.isArray(v.points) && v.points.length > 0 && v.points.length <= 10000 &&
    v.points.every((p: any) => Array.isArray(p) && p.length === 3 && p.every((n: any) => typeof n === "number" && Number.isFinite(n)) && Math.abs(p[0]) <= 100000 && Math.abs(p[1]) <= 100000 && p[2] >= 0 && p[2] <= 1) &&
    !!v.target && (v.target.type === "pdf" ? typeof v.target.bookId === "string" && /^[a-f0-9]{64}$/.test(v.target.hash) && Number.isInteger(v.target.page) && v.target.page > 0 : v.target.type === "notebook" && typeof v.target.noteId === "string" && typeof v.target.blockId === "string" && v.target.blockId.length > 0 && v.target.blockId.length <= 100);
}
