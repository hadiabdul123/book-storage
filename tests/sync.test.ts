import "fake-indexeddb/auto";
import { beforeEach, expect, it, vi } from "vitest";
import { db, save } from "../src/db";
import type { Book, Operation } from "../src/model";

const fake = vi.hoisted(() => ({
  rpc: vi.fn(),
  session: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
  user: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getSession: fake.session, getUser: fake.user },
    rpc: fake.rpc,
    storage: { from: () => ({ download: (...args: unknown[]) => ({
      asStream: async () => {
        const result = await fake.download(...args);
        return { ...result, data: result.data?.stream() ?? null };
      },
    }) }) },
  }),
}));
vi.mock("tus-js-client", () => ({
  Upload: class {
    constructor(
      private file: Blob,
      private options: any,
    ) {}
    async findPreviousUploads() {
      return [];
    }
    start() {
      void Promise.resolve(fake.upload(this.file, this.options)).then(
        () => {
          this.options.onProgress(this.file.size, this.file.size);
          this.options.onSuccess();
        },
        (error) => this.options.onError(error),
      );
    }
  },
}));
vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "test-key");
vi.stubGlobal("window", new EventTarget());
vi.stubGlobal("navigator", { onLine: true });
const {
  synchronize,
  syncSnapshot,
  removeDownload,
  downloadBook,
  uploadLimitBytes,
} = await import("../src/sync");
const book = {
  id: "test-book",
  title: "Test book",
  format: "pdf",
  sourcePath: "test-book/source.pdf",
} as Book;
let revision = 0;
beforeEach(async () => {
  for (const table of db.tables) await table.clear();
  vi.stubGlobal("navigator", { onLine: true });
  fake.session.mockResolvedValue({
    data: { session: { user: { id: "owner" }, access_token: "test-token" } },
  });
  fake.upload.mockReset();
  fake.download.mockReset();
  fake.user.mockReset().mockResolvedValue({ data: { user: { id: "owner" } } });
  revision = 0;
  fake.rpc.mockReset().mockImplementation(async (name, args) => {
    if (name === "pull_changes") return { data: [], error: null };
    const op = args.p_operation as Operation;
    return {
      data: {
        row: {
          key: op.key,
          kind: op.kind,
          id: op.id,
          value: op.value,
          deleted: op.deleted,
          revision: ++revision,
          updatedAt: "",
        },
      },
      error: null,
    };
  });
});
async function addBook() {
  await db.files.put({
    id: book.id,
    source: new Blob(["sample"]),
    uploaded: false,
  });
  await save("book", book);
}
it("drains edits added during an upload before reporting Synced", async () => {
  await addBook();
  fake.upload.mockImplementationOnce(async () => {
    await save("collection", { id: "new", name: "Added during upload" });
  });
  await synchronize();
  expect(await db.outbox.count()).toBe(0);
  expect(syncSnapshot().message).toBe("Synced");
  expect((await db.rows.get("collection:new"))?.revision).toBeGreaterThan(0);
});
it("retains failed uploads and continues syncing independent changes", async () => {
  await addBook();
  await save("collection", { id: "new", name: "Independent" });
  fake.upload.mockRejectedValue(new Error("Connection lost"));
  await synchronize();
  expect(await db.files.get(book.id)).toBeDefined();
  expect(await db.outbox.count()).toBe(1);
  expect(syncSnapshot().transfers?.[book.id]?.state).toBe("error");
  await expect(removeDownload(book)).rejects.toThrow("only local copy");
  fake.upload.mockReset();
  await synchronize();
  expect(await db.outbox.count()).toBe(0);
  await removeDownload(book);
  expect(await db.files.get(book.id)).toBeUndefined();
});
it("does not allow removing an uploaded file before metadata is acknowledged", async () => {
  await addBook();
  fake.rpc.mockResolvedValue({
    error: new Error("Metadata failed"),
    data: null,
  });
  await synchronize();
  expect((await db.files.get(book.id))?.uploaded).toBe(true);
  await expect(removeDownload(book)).rejects.toThrow("only local copy");
});
it("retains queued work while offline or signed out", async () => {
  await addBook();
  vi.stubGlobal("navigator", { onLine: false });
  await synchronize();
  expect(syncSnapshot().state).toBe("offline");
  expect(fake.upload).not.toHaveBeenCalled();
  vi.stubGlobal("navigator", { onLine: true });
  fake.session.mockResolvedValue({ data: { session: null } });
  await synchronize();
  expect(syncSnapshot().message).toContain("Sign in");
  expect(await db.outbox.count()).toBe(1);
});
it("rejects a different owner without uploading the local library", async () => {
  await addBook();
  await db.meta.put({ key: "owner", value: "another-owner" });
  await synchronize();
  expect(syncSnapshot().message).toContain("another account");
  expect(fake.upload).not.toHaveBeenCalled();
});
it("keeps oversized originals locally and explains the cloud limit", async () => {
  await addBook();
  const source = new Blob(["sample"]);
  Object.defineProperty(source, "size", { value: uploadLimitBytes + 1 });
  const read = vi
    .spyOn(db.files, "get")
    .mockResolvedValueOnce({ id: book.id, source, uploaded: false });
  await synchronize();
  read.mockRestore();
  expect(syncSnapshot().transfers?.[book.id]?.message).toContain(
    "cloud upload limit",
  );
  expect(fake.upload).not.toHaveBeenCalled();
  expect(await db.files.get(book.id)).toBeDefined();
  expect(await db.outbox.count()).toBe(1);
});
it("verifies downloaded bytes before retaining an offline copy", async () => {
  const source = new Blob(["verified source"]);
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", await source.arrayBuffer()),
    ),
  )
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  fake.download.mockResolvedValue({ data: source, error: null });
  await expect(downloadBook({ ...book, hash: "incorrect" })).rejects.toThrow(
    "did not match",
  );
  expect(await db.files.count()).toBe(0);
  await downloadBook({ ...book, hash });
  expect(fake.download).toHaveBeenCalledWith(
    `owner/${book.sourcePath}`,
    { cacheNonce: expect.any(String) },
    { cache: "no-store" },
  );
  expect((await db.files.get(book.id))?.uploaded).toBe(true);
  fake.user.mockRejectedValue(new Error("Offline"));
  await expect(downloadBook({ ...book, hash })).resolves.toMatchObject({
    id: book.id,
  });
});
it("does not lose a newer remote change when the local upload failed", async () => {
  await addBook();
  fake.upload.mockRejectedValue(new Error("Offline"));
  fake.rpc.mockResolvedValue({
    data: [
      {
        key: `book:${book.id}`,
        id: book.id,
        kind: "book",
        value: { ...book, title: "Remote title" },
        revision: 9,
        deleted: false,
        updatedAt: "",
      },
    ],
    error: null,
  });
  await synchronize();
  expect((await db.conflicts.get(`book:${book.id}`))?.remote.revision).toBe(9);
  expect((await db.rows.get(`book:${book.id}`))?.value).toEqual(book);
  expect(await db.outbox.count()).toBe(1);
});
