// Import and reading must use the same worker and local decoder/font assets.
export async function pdfLibrary() {
  const pdf = await import("pdfjs-dist");
  pdf.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).href;
  return pdf;
}

export function pdfOptions(data: ArrayBuffer) {
  const assets = `${import.meta.env.BASE_URL}pdf-assets/`;
  return {
    data,
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`,
    wasmUrl: `${assets}wasm/`,
  };
}

export function pdfOpenError(error: unknown): Error {
  const name = (error as { name?: string })?.name;
  const message = name === "PasswordException"
    ? "This PDF needs a password. Import an unlocked copy to read it in Leafmark."
    : name === "InvalidPDFException"
      ? "This PDF is damaged or incomplete. Try downloading the original file again."
      : "Leafmark could not open this PDF. Refresh the app and try importing it again. Your saved library has not been cleared.";
  return new Error(message, { cause: error });
}
