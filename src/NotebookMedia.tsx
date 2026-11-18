import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { GripVertical, MoveDiagonal } from "lucide-react";
import type { DragEvent, PointerEvent } from "react";
import { db, get, save } from "./db";
import { cloud, subscribeSync, syncSnapshot, synchronize } from "./sync";
import { mediaKind, mediaTypes } from "./notebookAssets";
import { keepMediaOffline, originalMediaBytes, playbackUrl, resizeMedia, restoreOriginal } from "./notebookMediaStore";
import { ItemMenu, RenameItem } from "./ItemMenu";
import { Dialog } from "./components";
import type { NotebookMedia as Media } from "./notebookAssets";
import { mediaDragType } from "./inlineMedia";

export type MediaCue = { id: string; time: number };

export function mediaLabel(time: number) {
  const seconds = Math.floor(time);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function readCue(url: string, noteId: string): MediaCue | undefined {
  try {
    const [route, search] = new URL(url, location.href).hash.slice(1).split("?");
    const query = new URLSearchParams(search);
    const id = query.get("media"), time = Number(query.get("at"));
    if (route === "/notebooks" && query.get("note") === noteId && id && Number.isFinite(time) && time >= 0) return { id, time };
  } catch { /* Keep ordinary links usable. */ }
}

export function cueHref(noteId: string, cue: MediaCue) {
  const link = new URL(location.href);
  link.search = "";
  link.hash = `/notebooks?${new URLSearchParams({ note: noteId, media: cue.id, at: String(Math.round(cue.time * 10) / 10) })}`;
  return link.href;
}

export function NotebookMedia({ media, cue, selected, onTimestamp, onMove, onSelect, onFree, onDrag }: {
  media: Media; cue?: MediaCue; selected: boolean;
  onTimestamp: (cue: MediaCue) => void; onMove: (direction: -1 | 1) => void;
  onSelect: () => void; onFree: () => void; onDrag: (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  const [rename, setRename] = useState(false);
  const [visible, setVisible] = useState(false);
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [sizeDialog, setSizeDialog] = useState(false);
  const [previewWidth, setPreviewWidth] = useState<number>();
  const gesture = useRef<{ id: number; x: number; width: number; paper: number }>(undefined);
  const pendingSeek = useRef<number | undefined>(cue?.time);
  const refreshed = useRef(false);
  const player = useRef<HTMLMediaElement | null>(null);
  const block = useRef<HTMLElement>(null);
  const sync = useSyncExternalStore(subscribeSync, syncSnapshot);
  const local = useLiveQuery(() => db.mediaFiles.get(media.id), [media.id]);
  const transfer = sync.transfers?.[media.id];
  const image = mediaTypes[media.extension].startsWith("image/");
  const Player = mediaTypes[media.extension].startsWith("video/") ? "video" : "audio";

  useEffect(() => {
    if (!block.current || visible) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    observer.observe(block.current);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!cue) return;
    pendingSeek.current = cue.time;
    setVisible(true);
    block.current?.scrollIntoView({ block: "nearest" });
    seek();
  }, [cue]);

  useEffect(() => {
    setSource(""); setError("");
    if (!visible) return;
    let active = true;
    let objectUrl: string | undefined;
    void playbackUrl(media).then(result => {
      if (result.local) objectUrl = result.url;
      if (active) setSource(result.url); else if (objectUrl) URL.revokeObjectURL(objectUrl);
    }, failure => { if (active) setError(failure.message); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [media.id, visible, !!local, refresh]);

  function seek() {
    const element = player.current;
    if (!element || pendingSeek.current === undefined || element.readyState < 1) return;
    element.currentTime = Math.min(pendingSeek.current, Number.isFinite(element.duration) ? element.duration : pendingSeek.current);
    pendingSeek.current = undefined;
  }

  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  function failedPreview() {
    if (!local && !refreshed.current) {
      refreshed.current = true;
      pendingSeek.current ??= player.current?.currentTime;
      setRefresh(n => n + 1);
    } else setError(image ? "This image couldn’t open. Download the original file." : "This file couldn’t play. Check the format or download the original.");
  }

  async function change(patch: Partial<Media>, deleted = false) {
    const kind = mediaKind(media);
    const latest = await get(kind, media.id);
    if (!latest) throw new Error("This attachment was removed.");
    await save(kind, { ...latest, ...patch }, deleted);
  }

  async function downloadOriginal() {
    const bytes = await originalMediaBytes(media);
    const url = URL.createObjectURL(new Blob([bytes], { type: mediaTypes[media.extension] }));
    const a = document.createElement("a"); a.href = url; a.download = media.title; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  const floating = !!media.placement?.free;
  const free = media.placement?.free;
  const resizable = image || Player === "video";
  const maxWidth = free ? 1 - free.x : 1;
  const clampWidth = (width: number) => Math.min(maxWidth, Math.max(.16, width));
  const currentWidth = free?.width ?? media.displayWidth ?? 1;
  const shownWidth = previewWidth ?? currentWidth;
  function beginResize(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !block.current) return;
    const paper = block.current.closest(".notebook-paper")?.getBoundingClientRect().width;
    if (!paper) return;
    event.stopPropagation(); event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { id: event.pointerId, x: event.clientX, width: block.current.getBoundingClientRect().width / paper, paper };
  }
  function finishResize(event: PointerEvent<HTMLButtonElement>) {
    const start = gesture.current;
    if (!start || start.id !== event.pointerId) return;
    gesture.current = undefined;
    if (event.type === "pointerup" && Math.abs(event.clientX - start.x) > 2) {
      const width = clampWidth(start.width + (event.clientX - start.x) / start.paper);
      setPreviewWidth(width);
      void run(() => resizeMedia(media, width)).finally(() => setPreviewWidth(undefined));
    } else setPreviewWidth(undefined);
  }
  function startDrag(event: DragEvent<HTMLElement>) {
    event.dataTransfer.setData(mediaDragType, media.id);
    event.dataTransfer.effectAllowed = "move";
  }
  return <figure className={`note-media${image ? " is-image" : ""}${selected ? " is-selected" : ""}${previewWidth === undefined ? "" : " is-resizing"}`} ref={block} aria-label={`Attachment: ${media.title}`} data-media-id={media.id}
    data-sized={previewWidth !== undefined || media.displayWidth !== undefined ? "" : undefined}
    style={resizable ? { width: `${(free ? shownWidth / free.width : shownWidth) * 100}%` } : undefined}>
    <ItemMenu title={media.title} className="notebook-media-menu" touch actions={[
      { label: selected ? "Deselect attachment" : "Select attachment", run: onSelect },
      { label: floating ? "Return to text flow" : "Move freely", run: onFree },
      ...(resizable ? [{ label: "Display size", run: () => setSizeDialog(true) }] : []),
      ...(!floating ? [{ label: "Move up", run: () => onMove(-1) }, { label: "Move down", run: () => onMove(1) }] : []),
      ...(!image ? [{ label: `Play ${Player}`, disabled: !source || !!error, run: () => { if (player.current) void run(() => player.current!.play()); } }] : []),
      ...(!image ? [{ label: "Insert timestamp", disabled: !source || !!error, run: () => onTimestamp({ id: media.id, time: player.current?.currentTime ?? 0 }) }] : []),
      { label: local ? "Available offline" : "Keep offline", disabled: busy || !!local, run: () => void run(() => {
        pendingSeek.current = player.current?.currentTime;
        return keepMediaOffline(media);
      }) },
      { label: "Download original", disabled: busy, run: () => void run(downloadOriginal) },
      { label: "Rename", run: () => setRename(true) },
      { label: "Move to Trash", danger: true, run: () => { if (confirm(`Move “${media.title}” to Trash?`)) void run(() => change({}, true)); } },
    ]}><div className="note-media-player">
      {source && (image ? <img key={source} src={source} alt={media.title} draggable={!floating} onDragStart={startDrag} onError={failedPreview} /> :
        <Player key={source} ref={element => { player.current = element; }} controls preload="metadata" src={source} onLoadedMetadata={seek} onCanPlay={seek} onError={failedPreview} />)}
      {!source && visible && !error && <p role="status">Opening attachment…</p>}
      <button className="note-media-handle" type="button" aria-label={`Drag ${media.title}`}
        onPointerDown={onDrag} onClick={e => { e.stopPropagation(); if (!e.detail) onSelect(); }}><GripVertical size={17} /></button>
      {resizable && <button className="note-media-resize" type="button" aria-label={`Resize ${media.title}`}
        onPointerDown={beginResize} onPointerMove={event => {
          const start = gesture.current;
          if (start?.id === event.pointerId) setPreviewWidth(clampWidth(start.width + (event.clientX - start.x) / start.paper));
        }} onPointerUp={finishResize} onPointerCancel={finishResize} onLostPointerCapture={finishResize}
        onClick={event => { event.stopPropagation(); if (!event.detail) setSizeDialog(true); }}><MoveDiagonal size={16} /></button>}
    </div></ItemMenu>
    <div className="note-media-status">
      {transfer?.state === "uploading" && <progress aria-label="Attachment upload" value={transfer.percent} max={100} />}
      {transfer?.state === "error" && <p role="status">{transfer.message} <button className="text-button" onClick={() => void run(synchronize)}>Retry sync</button></p>}
      {cloud && local && !local.uploaded && !transfer && <small>Saved on this device. Upload pending.</small>}
      {error && <div role="status"><p>{error}</p><button className="text-button" onClick={() => { refreshed.current = false; setVisible(true); setRefresh(n => n + 1); }}>Retry preview</button>{!local && <label className="text-button">Restore original file<input type="file" onChange={e => { const file = e.currentTarget.files?.[0]; if (file) void run(() => restoreOriginal(media, file)); }} /></label>}</div>}
    </div>
    {rename && <RenameItem label="attachment" value={media.title} onClose={() => setRename(false)} onSave={title => change({ title })} />}
    {sizeDialog && <Dialog title="Display size" onClose={() => setSizeDialog(false)}><form className="clip-form" onSubmit={event => {
      event.preventDefault();
      const percent = Number(new FormData(event.currentTarget).get("width"));
      void run(async () => { await resizeMedia(media, clampWidth(percent / 100)); setSizeDialog(false); });
    }}>
      <label>Width (% of page)<input name="width" type="number" required min={16} max={Math.max(16, Math.floor(maxWidth * 100 + .000001))} defaultValue={Math.floor(currentWidth * 100 + .000001)} /></label>
      {error && <p role="alert">{error}</p>}
      <div className="button-row"><button className="primary" disabled={busy}>Apply size</button><button className="text-button" type="button" disabled={busy} onClick={() => void run(async () => { await resizeMedia(media); setSizeDialog(false); })}>Reset size</button></div>
    </form></Dialog>}
  </figure>;
}
