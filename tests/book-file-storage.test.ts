import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { db, saveBookFile } from "../src/db";
import { decodeBookFile, encodeBookFile, isBlobStorageError } from "../src/bookFileStorage";

afterEach(async () => { vi.restoreAllMocks(); await db.files.clear(); });

it("round trips file bytes and MIME types, including a converted document", async () => {
  const file = { id: "book", source: new Blob([new Uint8Array([0, 255, 17])], { type: "application/pdf" }),
    derived: new Blob(["<p>A note</p>"], { type: "text/html" }), uploaded: false };
  const stored = await encodeBookFile(file);
  expect(stored.source.data).toBeInstanceOf(ArrayBuffer);
  // Exercise the same storage/read hook used by WebKit, without a schema migration.
  await db.files.put(stored as unknown as typeof file);
  const read = (await db.files.get(file.id))!;
  expect(new Uint8Array(await read.source.arrayBuffer())).toEqual(new Uint8Array([0, 255, 17]));
  expect(read.source.type).toBe("application/pdf");
  expect(await read.derived!.text()).toBe("<p>A note</p>");
  expect(read.derived!.type).toBe("text/html");
  expect(read.uploaded).toBe(false);
});

it("reads existing Blob records without conversion", () => {
  const old = { id: "legacy", source: new Blob(["old book"]), uploaded: true };
  expect(decodeBookFile(old)).toBe(old);
});

it("does not retry quota or unrelated database failures as Blob errors", async () => {
  const quota = new Error("Storage quota exceeded");
  vi.spyOn(db.files, "put").mockRejectedValueOnce(quota);
  await expect(saveBookFile({ id: "book", source: new Blob(["data"]), uploaded: false })).rejects.toBe(quota);
  expect(isBlobStorageError(quota)).toBe(false);
});

it("falls back on Blob serialization failure and preserves upload updates", async () => {
  vi.spyOn(db.files, "put").mockRejectedValueOnce(new Error("UnknownError: Error preparing Blob/File data to be stored in object store"));
  const file = { id: "webkit", source: new Blob(["book bytes"], { type: "application/epub+zip" }), uploaded: false };
  await saveBookFile(file);
  const read = (await db.files.get(file.id))!;
  expect(await read.source.text()).toBe("book bytes");
  await db.files.update(file.id, { uploaded: true });
  expect(await db.files.toCollection().raw().first()).toHaveProperty("encoding", "array-buffer-v1");
  expect((await db.files.get(file.id))!.uploaded).toBe(true);
  expect(await (await db.files.get(file.id))!.source.text()).toBe("book bytes");
});
