export type NotebookOverlay = {
  id: string;
  noteId: string;
  anchor: string;
  x: number;
  y: number;
  scale: number;
  createdAt: string;
};

export const mediaTypes = {
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg",
  m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
} as const;
export type MediaExtension = keyof typeof mediaTypes;
export const mediaLimitBytes = 50 * 1024 * 1024;
export type FreeMediaPosition = { x: number; y: number; width: number };
export type MediaPlacement = { after: string; order: number; free?: FreeMediaPosition };
export type NotebookMedia = {
  id: string;
  noteId: string;
  title: string;
  extension: MediaExtension;
  size: number;
  hash: string;
  createdAt: string;
  placement?: MediaPlacement;
  purgedAt?: string;
};

export const assetId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(value);
export const validOverlay = (value: NotebookOverlay) => assetId(value.noteId) && (value.anchor === "paper" || assetId(value.anchor)) &&
  [value.x, value.y].every(n => Number.isFinite(n) && Math.abs(n) <= 100000) && Number.isFinite(value.scale) && value.scale >= .1 && value.scale <= 10;
export const validMedia = (value: NotebookMedia) => assetId(value.noteId) && assetId(value.id) &&
  typeof value.title === "string" && !!value.title.trim() && value.title.length <= 200 &&
  Object.hasOwn(mediaTypes, value.extension) && Number.isInteger(value.size) && value.size > 0 && value.size <= mediaLimitBytes &&
  typeof value.hash === "string" && /^[a-f0-9]{64}$/.test(value.hash) &&
  (value.placement === undefined || (value.placement && assetId(value.placement.after) &&
    Number.isSafeInteger(value.placement.order) && value.placement.order >= 0 &&
    (value.placement.free === undefined || validFreeMedia(value.placement.free)))) &&
  (value.purgedAt === undefined || (typeof value.purgedAt === "string" && Number.isFinite(Date.parse(value.purgedAt))));
export const mediaObjectPath = (owner: string, media: NotebookMedia) => `${owner}/${media.noteId}/${media.id}.${media.extension}`;
export const mediaKind = (media: NotebookMedia) => mediaTypes[media.extension].startsWith("image/") ? "notebook-image" : "notebook-media";
export const isMediaKind = (kind: string): kind is ReturnType<typeof mediaKind> => kind === "notebook-media" || kind === "notebook-image";

export function validFreeMedia(value: FreeMediaPosition) {
  return !!value && [value.x, value.y, value.width].every(Number.isFinite) && value.x >= 0 && value.y >= 0 && value.y <= 100 && value.width >= .16 && value.width <= 1 && value.x + value.width <= 1.00001;
}
