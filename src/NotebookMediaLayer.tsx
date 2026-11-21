import { useLayoutEffect, useMemo, useRef, type PointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { NotebookMedia, type MediaCue } from "./NotebookMedia";
import { fitTextAroundMedia, updateMediaWidgets } from "./inlineMedia";
import type { FreeMediaPosition, NotebookMedia as Media } from "./notebookAssets";

export function NotebookMediaLayer({ editor, files, cue, paper, selected, onTimestamp, onMove, onSelect, onFree, onMoveFree, onDragInline }: {
  editor: Editor; files: Media[]; cue?: MediaCue;
  paper: RefObject<HTMLDivElement | null>; selected: ReadonlySet<string>;
  onTimestamp: (cue: MediaCue) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onSelect: (id: string) => void;
  onFree: (id: string) => void;
  onMoveFree: (positions: Map<string, FreeMediaPosition>) => void;
  onDragInline: (event: PointerEvent<HTMLButtonElement>, id: string) => void;
}) {
  const hosts = useRef(new Map<string, HTMLElement>());
  const layer = useRef<HTMLDivElement>(null);
  const requestFlow = useRef<() => void>(()=>{});
  const stopDrag = useRef<(() => void) | undefined>(undefined);
  const widgets = useMemo(() => files.map(media => {
    let host = hosts.current.get(media.id);
    if (!host) {
      host = document.createElement("div");
      host.className = "notebook-media-widget";
      host.contentEditable = "false";
      hosts.current.set(media.id, host);
    }
    return { media, host };
  }), [files]);
  useLayoutEffect(() => {
    const root = paper.current, float = layer.current;
    if (!root || !float) return;
    const free = widgets.filter(widget => widget.media.placement?.free);
    const inline = widgets.filter(widget => !widget.media.placement?.free);
    for (const { host } of inline) { host.className = "notebook-media-widget"; host.removeAttribute("style"); }
    updateMediaWidgets(editor, inline);
    let frame = 0;
    const schedule = () => { if (!frame) frame=requestAnimationFrame(sizeFreeMedia); };
    function sizeFreeMedia() {
      frame=0;
      const width = root!.clientWidth;
      let bottom = 0;
      for (const { host, media } of free) {
        const placement = media.placement!.free!;
        host.style.left = `${placement.x * 100}%`;
        host.style.top = `${placement.y * width}px`;
        host.style.width = `${placement.width * 100}%`;
        bottom = Math.max(bottom, placement.y * width + host.offsetHeight + 18);
      }
      root!.style.minHeight = bottom ? Math.ceil(bottom)+"px" : "";
      if (!editor.isDestroyed && (free.length || editor.view.dom.querySelector(".notebook-media-clear")))
        fitTextAroundMedia(editor, free.map(({host}) => host.getBoundingClientRect()));
    }
    for (const { host } of free) {
      host.className = "notebook-media-widget is-free";
      if (host.parentElement !== float) float.appendChild(host);
    }
    for (const [id, host] of hosts.current) if (!files.some(file => file.id === id)) { host.remove(); hosts.current.delete(id); }
    sizeFreeMedia();
    requestFlow.current = schedule;
    if (free.length) editor.on("transaction", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(root); observer.observe(editor.view.dom);
    for (const { host } of free) observer.observe(host);
    return () => { observer.disconnect(); editor.off("transaction",schedule); cancelAnimationFrame(frame); requestFlow.current=()=>{}; };
  }, [editor, widgets]);
  useLayoutEffect(() => () => stopDrag.current?.(), []);

  function dragFree(event: PointerEvent<HTMLButtonElement>, id: string) {
    const root = paper.current;
    if (!root || event.button !== 0 || stopDrag.current) return;
    const group = widgets.filter(widget => widget.media.placement?.free && (widget.media.id === id || selected.has(id) && selected.has(widget.media.id)));
    if (!group.length) return;
    event.preventDefault(); event.stopPropagation();
    const button = event.currentTarget, pointer = event.pointerId;
    const originX = event.clientX, originY = event.clientY;
    const width = root.getBoundingClientRect().width;
    if (!width) return;
    const left = Math.min(...group.map(({ media }) => media.placement!.free!.x));
    const top = Math.min(...group.map(({ media }) => media.placement!.free!.y));
    const right = Math.max(...group.map(({ media }) => media.placement!.free!.x + media.placement!.free!.width));
    const bottom = Math.max(...group.map(({ host, media }) => media.placement!.free!.y + host.getBoundingClientRect().height / width));
    const height = root.getBoundingClientRect().height / width;
    let dx = 0, dy = 0;
    button.setPointerCapture(pointer);
    function move(e: globalThis.PointerEvent) {
      if (e.pointerId !== pointer) return;
      dx = Math.max(-left, Math.min(1 - right, (e.clientX - originX) / width));
      dy = Math.max(-top, Math.min(Math.max(0, height - bottom), (e.clientY - originY) / width));
      for (const { host } of group) host.style.transform = `translate(${dx * root!.clientWidth}px, ${dy * root!.clientWidth}px)`;
      requestFlow.current();
    }
    function finish(e: globalThis.PointerEvent) {
      if (e.pointerId !== pointer) return;
      clean();
      if (e.type !== "pointerup" || (!dx && !dy)) return;
      onMoveFree(new Map(group.map(({ media }) => {
        const p = media.placement!.free!;
        return [media.id, { ...p, x: Math.max(0, p.x + dx), y: Math.max(0, Math.min(100, p.y + dy)) }];
      })));
    }
    function clean() {
      button.removeEventListener("pointermove", move); button.removeEventListener("pointerup", finish);
      button.removeEventListener("pointercancel", finish); button.removeEventListener("lostpointercapture", finish);
      for (const { host } of group) host.style.transform = "";
      requestFlow.current();
      stopDrag.current = undefined;
    }
    button.addEventListener("pointermove", move); button.addEventListener("pointerup", finish);
    button.addEventListener("pointercancel", finish); button.addEventListener("lostpointercapture", finish);
    stopDrag.current = clean;
  }

  return <><div className="notebook-free-media" ref={layer} />{widgets.map(({ media, host }) => createPortal(
    <NotebookMedia media={media} cue={cue?.id === media.id ? cue : undefined} selected={selected.has(media.id)} onTimestamp={onTimestamp} onMove={direction => onMove(media.id, direction)} onSelect={() => onSelect(media.id)} onFree={() => onFree(media.id)} onDrag={event => media.placement?.free ? dragFree(event, media.id) : onDragInline(event, media.id)} />,
    host, media.id,
  ))}</>;
}
