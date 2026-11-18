import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Clock3, Download, GripVertical } from "lucide-react";
import { db, get, save } from "./db";
import { cloud, subscribeSync, syncSnapshot, synchronize } from "./sync";
import { mediaKind, mediaTypes } from "./notebookAssets";
import { keepMediaOffline, originalMediaBytes, playbackUrl, restoreOriginal } from "./notebookMediaStore";
import { ItemMenu, RenameItem } from "./ItemMenu";
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

export function NotebookMedia({ media, cue, onTimestamp, onMove }: { media: Media; cue?: MediaCue; onTimestamp: (cue: MediaCue) => void; onMove: (direction: -1 | 1) => void }) {
  const [rename, setRename] = useState(false);
  const [visible, setVisible] = useState(false);
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
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

  return <figure className="note-media" ref={block} aria-label={`Attachment: ${media.title}`} data-media-id={media.id}>
    <ItemMenu title={media.title} actions={[
      { label: "Move up", run: () => onMove(-1) },
      { label: "Move down", run: () => onMove(1) },
      { label: "Rename", run: () => setRename(true) },
      { label: "Move to Trash", danger: true, run: () => { if (confirm(`Move “${media.title}” to Trash?`)) void run(() => change({}, true)); } },
    ]}><button className="note-media-file" type="button" draggable onClick={() => setVisible(true)} onDragStart={e => {
      e.dataTransfer.setData(mediaDragType, media.id);
      e.dataTransfer.effectAllowed = "move";
    }}><GripVertical size={17} /><span>{media.title}</span></button></ItemMenu>
    <div className="note-media-player">
      {source && (image ? <img key={source} src={source} alt={media.title} draggable={false} onError={failedPreview} /> :
        <Player key={source} ref={element => { player.current = element; }} controls preload="metadata" src={source} onLoadedMetadata={seek} onCanPlay={seek} onError={failedPreview} />)}
      <div className="note-media-actions">
        {!image && <button className="text-button" disabled={!source || !!error} onMouseDown={e => e.preventDefault()} onClick={() => onTimestamp({ id: media.id, time: player.current?.currentTime ?? 0 })}><Clock3 size={16} />Insert timestamp</button>}
        <button className="text-button" disabled={busy || !!local} onClick={() => void run(() => {
          pendingSeek.current = player.current?.currentTime;
          return keepMediaOffline(media);
        })}>{local ? "Available offline" : "Keep offline"}</button>
        <button className="text-button" disabled={busy} onClick={() => void run(async () => {
          const bytes = await originalMediaBytes(media);
          const url = URL.createObjectURL(new Blob([bytes], { type: mediaTypes[media.extension] }));
          const a = document.createElement("a"); a.href = url; a.download = media.title; a.click();
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        })}><Download size={16} />Download original</button>
      </div>
      {transfer?.state === "uploading" && <progress aria-label="Attachment upload" value={transfer.percent} max={100} />}
      {transfer?.state === "error" && <p role="status">{transfer.message} <button className="text-button" onClick={() => void run(synchronize)}>Retry sync</button></p>}
      {cloud && local && !local.uploaded && !transfer && <small>Saved on this device. Upload pending.</small>}
      {error && <div role="status"><p>{error}</p><button className="text-button" onClick={() => { refreshed.current = false; setVisible(true); setRefresh(n => n + 1); }}>Retry preview</button>{!local && <label className="text-button">Restore original file<input type="file" onChange={e => { const file = e.currentTarget.files?.[0]; if (file) void run(() => restoreOriginal(media, file)); }} /></label>}</div>}
    </div>
    {rename && <RenameItem label="attachment" value={media.title} onClose={() => setRename(false)} onSave={title => change({ title })} />}
  </figure>;
}
