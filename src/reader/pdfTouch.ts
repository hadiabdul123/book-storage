import { bindTouchSelection } from "./touchSelection";

/** PDF text preparation is the only format-specific part of touch selection. */
export function bindPdfTouch(host: HTMLElement, prepare: (page: HTMLElement) => Promise<void>, selected: (range: Range) => void, cleared: () => void, adjusting?: (active: boolean) => void) {
  return bindTouchSelection(host, {
    selected, cleared, adjusting,
    allowed: () => !host.classList.contains("drawing-mode") && !host.classList.contains("region-mode") && !host.classList.contains("pdf-zooming") && !host.dataset.pageTurning,
    prepare: async element => { const page = element.closest<HTMLElement>(".pdf-page"); if (page) await prepare(page); },
  });
}
