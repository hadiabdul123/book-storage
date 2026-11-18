import { useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { NotebookMedia, type MediaCue } from "./NotebookMedia";
import { updateMediaWidgets } from "./inlineMedia";
import type { NotebookMedia as Media } from "./notebookAssets";

export function NotebookMediaLayer({ editor, files, cue, onTimestamp, onMove }: {
  editor: Editor; files: Media[]; cue?: MediaCue;
  onTimestamp: (cue: MediaCue) => void;
  onMove: (id: string, direction: -1 | 1) => void;
}) {
  const hosts = useRef(new Map<string, HTMLElement>());
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
    updateMediaWidgets(editor, widgets);
    for (const id of hosts.current.keys()) if (!files.some(file => file.id === id)) hosts.current.delete(id);
  }, [editor, widgets]);
  return <>{widgets.map(({ media, host }) => createPortal(
    <NotebookMedia media={media} cue={cue?.id === media.id ? cue : undefined} onTimestamp={onTimestamp} onMove={direction => onMove(media.id, direction)} />,
    host, media.id,
  ))}</>;
}
