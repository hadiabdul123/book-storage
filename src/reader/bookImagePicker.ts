import type { Locator } from "../model";
import type { ReaderEvents } from "./types";

async function pictureFile(element: Element) {
  let image: HTMLImageElement;
  if (element.localName === "img") image = element as HTMLImageElement;
  else {
    const url = (element as SVGImageElement).href.baseVal;
    if (!/^(data:image\/|blob:)/i.test(url)) throw Error("This picture is unavailable.");
    image = new Image(); image.src = url;
  }
  await image.decode();
  const scale = Math.min(1, 1600 / Math.max(image.naturalWidth,image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth*scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight*scale));
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw Error("Could not read this picture.");
    ctx.drawImage(image,0,0,canvas.width,canvas.height);
    const blob = await new Promise<Blob>((resolve,reject) => canvas.toBlob(value =>
      value ? resolve(value) : reject(Error("Could not copy this picture.")),"image/png"));
    return new File([blob],"Book image.png",{type:"image/png"});
  } finally { canvas.width = canvas.height = 0; }
}

export function bindBookImagePicker(root: HTMLElement, host: HTMLElement, locate: (range:Range) => Locator, events: ReaderEvents) {
  let busy = false, active = true;
  const click = async (event: MouseEvent) => {
    if (!host.closest(".reader-shell[data-clipping-region][data-study-open]")) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const el = (event.target as Element).closest("img,image");
    if (!el || busy) return;
    busy = true;
    try {
      const range = root.ownerDocument.createRange(); range.selectNode(el);
      const locator = locate(range), file = await pictureFile(el);
      if (active && host.closest(".reader-shell[data-clipping-region][data-study-open]"))
        events.onBookImage?.(file,locator,el.getAttribute("alt")?.trim() || "Book image");
    } catch { if (active) events.onHint?.("Could not copy this book image. Try selecting it again."); }
    finally { busy = false; }
  };
  root.addEventListener("click", click, true);
  return () => { active = false; root.removeEventListener("click", click, true); };
}
