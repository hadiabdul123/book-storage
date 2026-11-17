import { afterEach, expect, it, vi } from "vitest";
import { createWorker } from "tesseract.js";
import { PageOcr } from "../src/reader/ocr";

vi.mock("tesseract.js", () => ({ createWorker: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it("releases an in-flight recognition promise when its worker owner closes", async () => {
  vi.stubGlobal("location", { origin: "http://localhost" });
  const recognize = vi.fn(() => new Promise<never>(() => {})), terminate = vi.fn().mockResolvedValue(undefined);
  vi.mocked(createWorker).mockResolvedValue({ recognize, terminate } as any);
  const ocr = new PageOcr();
  const result = ocr.recognize({} as HTMLCanvasElement, () => {});
  await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());
  const stopped = expect(result).rejects.toMatchObject({ name: "AbortError" });
  ocr.destroy();
  await stopped;
  await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
  await expect(ocr.recognize({} as HTMLCanvasElement, () => {})).rejects.toMatchObject({ name: "AbortError" });
});
