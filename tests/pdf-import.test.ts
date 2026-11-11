import "fake-indexeddb/auto";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { db, list } from "../src/db";
import { importBook } from "../src/import";
import { pdfLibrary, pdfOptions, pdfOpenError } from "../src/pdf";

vi.mock("../src/pdf", async (original) => ({
  ...await original<typeof import("../src/pdf")>(),
  pdfLibrary: vi.fn(),
}));

beforeEach(async () => {
  for (const table of db.tables) await table.clear();
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    document: { createElement: () => ({}) },
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(options: { loadError?: Error; metadataError?: Error; cleanupError?: Error } = {}) {
  const destroy = options.cleanupError
    ? vi.fn().mockRejectedValue(options.cleanupError)
    : vi.fn().mockResolvedValue(undefined);
  const document = {
    getMetadata: options.metadataError
      ? vi.fn().mockRejectedValue(options.metadataError)
      : vi.fn().mockResolvedValue({ info: { Title: "Valid book", Author: "Test author" } }),
    getPage: vi.fn().mockResolvedValue({
      getViewport: () => ({ width: 100, height: 100 }),
      render: () => ({ promise: Promise.reject(new Error("Thumbnail failed")) }),
    }),
  };
  const getDocument = vi.fn((_options: unknown) => ({
    promise: options.loadError ? Promise.reject(options.loadError) : Promise.resolve(document),
    destroy,
  }));
  vi.mocked(pdfLibrary).mockResolvedValue({ getDocument } as unknown as Awaited<ReturnType<typeof pdfLibrary>>);
  return { destroy, getDocument };
}
const file = () => new File(["%PDF-1.7\n test"], "original.pdf", { type: "application/pdf" });

describe("PDF import resilience", () => {
  it("keeps the readable book and durable operation when a cover fails", async () => {
    const { destroy, getDocument } = setup();
    const result = await importBook(file());
    expect(result.book.title).toBe("Valid book");
    expect(result.book.cover).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("cover");
    expect(await list("book")).toHaveLength(1);
    expect(await db.files.count()).toBe(1);
    expect(await db.outbox.count()).toBe(1);
    expect(getDocument.mock.calls[0][0]).toMatchObject({ wasmUrl: "/pdf-assets/wasm/", cMapPacked: true });
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("falls back to the filename when metadata also fails", async () => {
    setup({ metadataError: new Error("Bad metadata") });
    const result = await importBook(file());
    expect(result.book.title).toBe("original");
    expect(result.book.author).toBe("Unknown author");
    expect(result.warnings).toHaveLength(2);
  });
  it("rejects an unreadable PDF without saving orphan files or operations", async () => {
    const error = Object.assign(new Error("Internal error"), { name: "InvalidPDFException" });
    const { destroy } = setup({ loadError: error, cleanupError: new Error("cleanup failed") });
    await expect(importBook(file())).rejects.toThrow("damaged or incomplete");
    expect(await db.rows.count()).toBe(0);
    expect(await db.files.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("does not discard a saved import because worker cleanup failed", async () => {
    setup({ cleanupError: new Error("Worker already closed") });
    await expect(importBook(file())).resolves.toMatchObject({ book: { title: "Valid book" } });
    expect(await list("book")).toHaveLength(1);
  });
  it("uses the deployment base path for every auxiliary PDF asset", () => {
    vi.stubEnv("BASE_URL", "/book-storage/");
    try {
      expect(pdfOptions(new ArrayBuffer(1))).toMatchObject({
        wasmUrl: "/book-storage/pdf-assets/wasm/",
        cMapUrl: "/book-storage/pdf-assets/cmaps/",
        standardFontDataUrl: "/book-storage/pdf-assets/standard_fonts/",
      });
    } finally { vi.unstubAllEnvs(); }
  });
  it("explains password and internal failures without repeating internal exceptions", () => {
    expect(pdfOpenError({ name: "PasswordException" }).message).toContain("unlocked copy");
    const cause = new Error("UnknownError Internal error. UnknownError: Internal error.");
    const error = pdfOpenError(cause);
    expect(error.message).not.toContain("UnknownError");
    expect(error.cause).toBe(cause);
  });
});
