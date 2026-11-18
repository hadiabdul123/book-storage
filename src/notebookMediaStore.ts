import { db, get, list, save } from "./db";
import { now, uid } from "./model";
import { mediaKind, mediaLimitBytes, mediaObjectPath, mediaTypes, validFreeMedia, validMedia, validMediaWidth, type FreeMediaPosition, type MediaExtension, type MediaPlacement, type NotebookMedia } from "./notebookAssets";
import { cloud, synchronize, uploadLimitBytes } from "./sync";

async function mediaHash(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

export function attachmentExtension(file: File) {
  const extension = file.name.split(".").at(-1)?.toLowerCase() as MediaExtension;
  if (!Object.hasOwn(mediaTypes, extension)) throw new Error(`Unsupported file format: ${file.name}. Choose an image, video, or audio file in a supported format.`);
  const limit = Math.min(mediaLimitBytes, uploadLimitBytes);
  if (!file.size || file.size > limit) throw new Error(`Choose a file between 1 byte and ${Math.floor(limit / 1024 / 1024)} MB.`);
  return extension;
}

export async function attachMedia(noteId: string, file: File, placement?: MediaPlacement) {
  const extension = attachmentExtension(file);
  const bytes = await file.arrayBuffer();
  const media: NotebookMedia = { id: uid(), noteId, title: file.name.trim().slice(0, 200), extension, size: file.size, hash: await mediaHash(bytes), createdAt: now(), placement };
  await db.transaction("rw", [db.mediaFiles, db.rows, db.outbox, db.conflicts, db.meta], async () => {
    if (!(await get("notebook-note", noteId))) throw new Error("This notebook page has been removed.");
    await db.mediaFiles.add({ id: media.id, bytes, uploaded: false });
    await save(mediaKind(media), media);
  });
  return media;
}

export async function notebookMediaList() {
  const [media, images] = await Promise.all([list("notebook-media"), list("notebook-image")]);
  return [...media, ...images];
}

export async function resizeMedia(media: NotebookMedia, width?: number) {
  if (width !== undefined && !validMediaWidth(width)) throw new Error("Choose a width from 16 to 100 percent.");
  const kind = mediaKind(media);
  await db.transaction("rw", db.rows, db.outbox, db.conflicts, db.meta, async () => {
    const latest = await get(kind, media.id);
    if (!latest) throw new Error("This attachment was removed.");
    const free = latest.placement?.free;
    const displayWidth = width;
    if (free) {
      const nextWidth = Math.min(width ?? .45, 1 - free.x);
      await save(kind, { ...latest, displayWidth, placement: { ...latest.placement!, free: { ...free, width: nextWidth } } });
    } else await save(kind, { ...latest, displayWidth });
  });
}

export async function placeMedia(noteId: string, after: string, orderedIds: string[]) {
  await db.transaction("rw", [db.rows, db.outbox, db.conflicts, db.meta], async () => {
    for (const [order, id] of orderedIds.entries()) {
      const media = await get("notebook-media", id) || await get("notebook-image", id);
      if (media?.noteId === noteId && (media.placement?.after !== after || media.placement.order !== order || media.placement.free)) {
        await save(mediaKind(media), { ...media, placement: { after, order } });
      }
    }
  });
}

export async function positionMedia(noteId: string, positions: Map<string, FreeMediaPosition | undefined>) {
  await db.transaction("rw", [db.rows, db.outbox, db.conflicts, db.meta], async () => {
    for (const [id, free] of positions) {
      const media = await get("notebook-media", id) || await get("notebook-image", id);
      if (media?.noteId !== noteId) continue;
      if (free && !validFreeMedia(free)) throw new Error("This attachment is outside the notebook page.");
      const placement = { ...(media.placement || { after: "end", order: 0 }), free };
      await save(mediaKind(media), { ...media, placement });
    }
  });
}

// A pasted group gets new attachment IDs and its own originals. Commit the
// group together so a failed fetch cannot leave half a copy on the new page.
export async function copyMediaToNote(noteId: string, ids: string[], after: string, order: number) {
  const copies: { media: NotebookMedia; bytes: ArrayBuffer }[] = [];
  let size = 0;
  for (const id of ids) {
    const original = await get("notebook-media", id) || await get("notebook-image", id);
    if (!original) throw new Error("An attachment from the copied group is unavailable.");
    size += original.size;
    if (size > 100 * 1024 * 1024) throw new Error("Copy attachments in batches of up to 100 MB.");
    copies.push({ media: { ...original, id: uid(), noteId, createdAt: now(), placement: { after, order: order++ } }, bytes: await originalMediaBytes(original) });
  }
  await db.transaction("rw", [db.mediaFiles, db.rows, db.outbox, db.conflicts, db.meta], async () => {
    if (!(await get("notebook-note", noteId))) throw new Error("This notebook page has been removed.");
    for (const { media, bytes } of copies) {
      await db.mediaFiles.add({ id: media.id, bytes, uploaded: false });
      await save(mediaKind(media), media);
    }
  });
}

async function storageFile(media: NotebookMedia) {
  if (!validMedia(media) || !cloud) throw new Error("The original attachment is unavailable on this device.");
  const { data: { session } } = await cloud.auth.getSession();
  const owner = await db.meta.get("owner");
  if (!session || (owner && owner.value !== session.user.id)) throw new Error("Sign in to the attachment’s library.");
  return { bucket: cloud.storage.from("notebook-media"), path: mediaObjectPath(session.user.id, media) };
}

export async function playbackUrl(media: NotebookMedia) {
  const local = await db.mediaFiles.get(media.id);
  if (local) return { url: URL.createObjectURL(new Blob([local.bytes], { type: mediaTypes[media.extension] })), local: true };
  const { bucket, path } = await storageFile(media);
  const { data, error } = await bucket.createSignedUrl(path, 3600);
  if (error) throw new Error("Could not open the original attachment. Check the connection and try again.");
  return { url: data.signedUrl, local: false };
}

export async function originalMediaBytes(media: NotebookMedia) {
  const local = await db.mediaFiles.get(media.id);
  if (local) return local.bytes;
  const { bucket, path } = await storageFile(media);
  const { data, error } = await bucket.download(path);
  if (error || !data || data.size !== media.size) throw new Error("Could not download the complete original attachment.");
  const bytes = await data.arrayBuffer();
  if (await mediaHash(bytes) !== media.hash) throw new Error("The downloaded file did not match the original attachment.");
  return bytes;
}

export async function keepMediaOffline(media: NotebookMedia) {
  const bytes = await originalMediaBytes(media);
  await db.transaction("rw", [db.mediaFiles, db.rows], async () => {
    if (!(await get(mediaKind(media), media.id))) throw new Error("This attachment has been removed.");
    await db.mediaFiles.put({ id: media.id, bytes, uploaded: true });
  });
  return bytes;
}

export async function restoreOriginal(media: NotebookMedia, file: File) {
  if (file.size !== media.size || file.name.split(".").at(-1)?.toLowerCase() !== media.extension)
    throw new Error("Choose the original file with the same format and size.");
  const bytes = await file.arrayBuffer();
  if (await mediaHash(bytes) !== media.hash) throw new Error("This file does not match the original attachment.");
  await db.transaction("rw", [db.mediaFiles, db.rows, db.outbox, db.conflicts, db.meta], async () => {
    const latest = await get(mediaKind(media), media.id);
    if (!latest) throw new Error("The attachment was removed.");
    await db.mediaFiles.put({ id: media.id, bytes, uploaded: false });
    // The prior metadata may already exist remotely. Queue a fresh operation
    // so the restored file passes through the same upload path.
    await save(mediaKind(media), { ...latest, createdAt: now() });
  });
}

export async function purgeMedia(media: NotebookMedia) {
  const kind = mediaKind(media);
  const row = await db.rows.get(`${kind}:${media.id}`);
  if (!row?.deleted) throw new Error("Move the attachment to Trash first.");
  await save(kind, { ...media, purgedAt: media.purgedAt || now() }, true);
  if (cloud) {
    await synchronize();
    const confirmed = await db.rows.get(row.key);
    if (!confirmed?.deleted || !(confirmed.value as NotebookMedia).purgedAt ||
        await db.outbox.where("key").equals(row.key).count() || await db.conflicts.get(row.key))
      throw new Error("The deletion must sync first. Try again when connected.");
    const { bucket, path } = await storageFile(media);
    const { error } = await bucket.remove([path]);
    if (error) throw error;
  }
  await db.mediaFiles.delete(media.id);
}
