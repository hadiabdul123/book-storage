export type TurnDirection = "next" | "previous";
export type TurnPoint = { x: number; y: number };
export type TurnSpread = { leaves: HTMLElement[]; width: number; height: number; columns: 1 | 2 };
export type TurnPreview = { outgoing: TurnSpread; incoming: TurnSpread; commit: () => Promise<void>; dispose: () => void };
export function surfaceCache(host: HTMLElement, width: number, height: number) {
  const cache = document.createElement("div");
  cache.className = "turn-surface-cache";
  cache.setAttribute("aria-hidden", "true"); cache.inert = true;
  Object.assign(cache.style, { width: `${width}px`, height: `${height}px` });
  (host.closest(".reader-shell") || host.parentElement!).append(cache);
  return cache;
}
export function blankLeaf(width: number, height: number) {
  const leaf = document.createElement("div"); leaf.className = "turn-leaf"; leaf.dataset.density = "soft";
  Object.assign(leaf.style, { width: `${width}px`, height: `${height}px`, position: "relative", overflow: "hidden" });
  return leaf;
}
export function canvasImage(canvas: HTMLCanvasElement, width: number, height: number) {
  const copy = document.createElement("canvas"), scale = Math.min(1.5, 1600 / Math.max(width, height));
  copy.width = Math.max(1, Math.round(width * scale)); copy.height = Math.max(1, Math.round(height * scale));
  copy.getContext("2d")!.drawImage(canvas, 0, 0, copy.width, copy.height);
  const image = document.createElement("img"); image.src = copy.toDataURL("image/png"); image.alt = ""; image.draggable = false;
  Object.assign(image.style, { width: `${width}px`, height: `${height}px`, display: "block" });
  copy.width = copy.height = 0;
  return image;
}
export async function waitForSurfaces(root: ParentNode) {
  await Promise.all([...root.querySelectorAll("img")].map(img => img.decode().catch(() => {})));
  await Promise.all([...root.querySelectorAll("iframe")].map(frame => new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); frame.removeEventListener("load", finish); resolve(); };
    const timer = setTimeout(finish, 1500); frame.addEventListener("load", finish, { once: true });
    if (frame.contentDocument?.URL === "about:srcdoc" && frame.contentDocument.readyState === "complete") finish();
  }).then(() => frame.contentDocument?.fonts?.ready)));
}
