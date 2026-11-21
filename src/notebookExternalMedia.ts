import { mediaTypes, mediaLimitBytes } from "./notebookAssets";

export async function droppedMedia(url: string): Promise<File> {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    const header = url.slice(5, comma).toLowerCase();
    const [type, encoding] = header.split(";");
    const extension = Object.entries(mediaTypes).find(([, mime]) => mime === type)?.[0];
    if (!extension || encoding !== "base64" || comma < 0 || url.length - comma - 1 > Math.ceil(mediaLimitBytes / 3) * 4) {
      throw Error("Unsupported or oversized embedded media");
    }
    const binary = atob(url.slice(comma + 1));
    if (!binary.length || binary.length > mediaLimitBytes) throw Error("Invalid embedded media size");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], "Dropped media." + extension, { type });
  }
  const abort = new AbortController();
  const timeout = window.setTimeout(() => abort.abort(), 30_000);
  try {
    const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", signal: abort.signal });
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    const extension = Object.entries(mediaTypes).find(([, mime]) => mime === type)?.[0];
    if (!response.ok || !response.body || !extension || Number(response.headers.get("content-length")) > mediaLimitBytes) {
      throw Error("Unsupported or oversized media");
    }
    const reader = response.body.getReader();
    const chunks: ArrayBuffer[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > mediaLimitBytes) throw Error("Media exceeds the attachment limit");
      chunks.push(value.slice().buffer);
    }
    if (!size) throw Error("Empty media");
    const sourceName = /^https?:/i.test(url) && new URL(url).pathname.split("/").pop();
    const name = sourceName && sourceName.toLowerCase().endsWith("." + extension) ? sourceName : "Dropped media." + extension;
    return new File(chunks, name, { type });
  } finally {
    window.clearTimeout(timeout);
    abort.abort();
  }
}
