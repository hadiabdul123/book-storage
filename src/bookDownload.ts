/** Retry only interrupted transfers and temporary server failures. */
export async function downloadFreshBlob(
  download: (nonce: string) => PromiseLike<{ data: ReadableStream<Uint8Array> | null; error: unknown }>,
  type: string,
): Promise<Blob> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { data, error } = await download(crypto.randomUUID());
      if (error) throw error;
      if (!data) throw new Error("The download was empty.");
      // Some Chrome profiles fail in network Response.blob() even after
      // HTTP 200. Read bytes first, then construct the Blob;
      // this path recovered the owner's actual failing 14 MB Flow download.
      const bytes = await new Response(data).arrayBuffer();
      return new Blob([bytes], { type });
    } catch (error) {
      const e = error as { status?: number; statusCode?: string };
      const status = Number(e.statusCode || e.status || 0);
      const transient = !status || status === 408 || status === 429 || status >= 500;
      if (attempt === 0 && transient && navigator.onLine) {
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
      const message = status === 401 || status === 403
        ? "Your session cannot download this book. Sign in again with your library account."
        : status === 404
          ? "This book's cloud file could not be found. Your saved notes have not been changed."
          : "The book download was interrupted. Check your connection and choose Retry opening book. Your cloud copy and saved notes have not been changed.";
      throw new Error(message, { cause: error });
    }
  }
}
