import { db, get, save } from "./db";
import { now, uid } from "./model";
import { mediaLimitBytes, mediaObjectPath, mediaTypes, validMedia, type MediaExtension, type NotebookMedia } from "./notebookAssets";
import { cloud, synchronize, uploadLimitBytes } from "./sync";

async function mediaHash(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

export async function attachMedia(noteId: string, file: File) {
  const extension = file.name.split(".").at(-1)?.toLowerCase() as MediaExtension;
  if (!Object.hasOwn(mediaTypes, extension)) throw new Error("Choose an MP4, WebM, MP3, M4A, WAV, or Ogg file.");
  const limit = Math.min(mediaLimitBytes, uploadLimitBytes);
  if (!file.size || file.size > limit) throw new Error(`Choose a file between 1 byte and ${Math.floor(limit / 1024 / 1024)} MB.`);
  const bytes = await file.arrayBuffer();
  const media: NotebookMedia = { id: uid(), noteId, title: file.name.trim().slice(0, 200), extension, size: file.size, hash: await mediaHash(bytes), createdAt: now() };
  await db.transaction("rw", [db.mediaFiles, db.rows, db.outbox, db.conflicts, db.meta], async () => {
    if (!(await get("notebook-note", noteId))) throw new Error("This notebook page has been removed.");
    await db.mediaFiles.add({ id: media.id, bytes, uploaded: false });
    await save("notebook-media", media);
  });
  return media;
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
    if (!(await get("notebook-media", media.id))) throw new Error("This attachment has been removed.");
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
    const latest = await get("notebook-media", media.id);
    if (!latest) throw new Error("The attachment was removed.");
    await db.mediaFiles.put({ id: media.id, bytes, uploaded: false });
    // The prior metadata may already exist remotely. Queue a fresh operation
    // so the restored file passes through the same upload path.
    await save("notebook-media", { ...latest, createdAt: now() });
  });
}

export async function purgeMedia(media: NotebookMedia) {
  const row = await db.rows.get(`notebook-media:${media.id}`);
  if (!row?.deleted) throw new Error("Move the attachment to Trash first.");
  await save("notebook-media", { ...media, purgedAt: media.purgedAt || now() }, true);
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
