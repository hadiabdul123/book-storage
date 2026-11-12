import { downloadFreshBlob } from "./bookDownload";
import { createClient } from "@supabase/supabase-js";
import { Upload } from "tus-js-client";
import { db, acceptRemote } from "./db";
import { type Book, type Row } from "./model";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
export const cloud =
  url && key && !url.includes("YOUR_PROJECT")
    ? createClient(url, key, {
        global: {
          fetch: (input, init) => {
            const requestUrl =
              typeof input === "string"
                ? input
                : input instanceof URL ? input.href : input.url;
            if (!requestUrl.includes("/auth/v1/")) return fetch(input, init);
            const timeout = AbortSignal.timeout(10000);
            return fetch(input, {
              ...init,
              signal: init?.signal
                ? AbortSignal.any([init.signal, timeout])
                : timeout,
            });
          },
        },
      })
    : null;
export type SyncStatus = {
  state: "local" | "idle" | "syncing" | "offline" | "error";
  message: string;
  lastSync?: string;
  pendingChanges?: number;
  transfers?: Record<
    string,
    { state: "uploading" | "error"; percent?: number; message?: string }
  >;
};
let status: SyncStatus = {
  state: cloud ? "idle" : "local",
  message: cloud ? "Ready to sync" : "On this device",
};
const listeners = new Set<() => void>();
export const subscribeSync = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const syncSnapshot = () => status;
function report(next: SyncStatus) {
  status = { ...next, transfers: next.transfers ?? status.transfers };
  listeners.forEach((fn) => fn());
}
let running: Promise<void> | null = null;
let stopped = false;
let requested = false;
export const uploadLimitBytes =
  (Number(import.meta.env.VITE_UPLOAD_LIMIT_MB) || 50) * 1024 * 1024;
function transferStatus(
  id: string,
  value?: NonNullable<SyncStatus["transfers"]>[string],
) {
  const transfers = { ...status.transfers };
  if (value) transfers[id] = value;
  else delete transfers[id];
  report({ ...status, transfers });
}

async function upload(
  path: string,
  file: Blob,
  progress: (sent: number) => void,
) {
  if (!cloud || !url) return;
  if (file.size > uploadLimitBytes)
    throw new Error(
      `This file exceeds the configured ${Math.round(uploadLimitBytes / 1024 / 1024)} MB cloud upload limit. Your local copy is safe.`,
    );
  const {
    data: { session },
  } = await cloud.auth.getSession();
  if (!session) throw new Error("Sign in to synchronize your saved changes.");
  await new Promise<void>((resolve, reject) => {
    const transfer = new Upload(file, {
      endpoint: `${url}/storage/v1/upload/resumable`,
      headers: {
        apikey: key!,
        authorization: `Bearer ${session.access_token}`,
        "x-upsert": "true",
      },
      metadata: {
        bucketName: "library",
        objectName: path,
        contentType: file.type || "application/octet-stream",
        cacheControl: "3600",
      },
      chunkSize: 6 * 1024 * 1024,
      retryDelays: [0, 1500, 3000, 6000],
      removeFingerprintOnSuccess: true,
      fingerprint: async () =>
        `leafmark:${session.user.id}:${path}:${file.size}`,
      onError: reject,
      onProgress: (sent) => progress(sent),
      onSuccess: () => resolve(),
    });
    transfer
      .findPreviousUploads()
      .then((previous) => {
        if (previous.length) transfer.resumeFromPreviousUpload(previous[0]);
        transfer.start();
      })
      .catch(reject);
  });
}

async function runSync() {
  if (!cloud || stopped) return;
  if (!navigator.onLine) {
    report({
      state: "offline",
      message: "Offline · changes saved on this device",
    });
    return;
  }
  const {
    data: { session },
  } = await cloud.auth.getSession();
  if (!session) {
    report({
      state: "error",
      message: "Sign in to synchronize your saved changes.",
    });
    return;
  }
  const bound = await db.meta.get("owner");
  if (bound && bound.value !== session.user.id)
    throw new Error(
      "This local library belongs to another account. Sign out and clear local data first.",
    );
  await db.meta.put({ key: "owner", value: session.user.id });
  report({ state: "syncing", message: "Synchronizing…" });
  const failures: string[] = [];
  const failedKeys = new Set<string>();
  const attempted = new Set<string>();
  // Drain newly queued work too, without repeatedly retrying failed operations.
  while (!stopped) {
    const operations = (await db.outbox.orderBy("sequence").toArray()).filter(
      (op) => !attempted.has(op.opId),
    );
    if (!operations.length) break;
    for (const operation of operations) {
      attempted.add(operation.opId);
      if (stopped) return;
      if (
        failedKeys.has(operation.key) ||
        (await db.conflicts.get(operation.key))
      )
        continue;
      try {
        if (operation.kind === "book" && !operation.deleted) {
          const book = operation.value as Book,
            file = await db.files.get(book.id);
          if (file && !file.uploaded) {
            const total = file.source.size + (file.derived?.size || 0);
            const progress = (sent: number) =>
              transferStatus(book.id, {
                state: "uploading",
                percent: Math.min(
                  100,
                  Math.round((sent / Math.max(1, total)) * 100),
                ),
              });
            progress(0);
            await upload(
              `${session.user.id}/${book.sourcePath}`,
              file.source,
              progress,
            );
            if (file.derived && book.derivedPath)
              await upload(
                `${session.user.id}/${book.derivedPath}`,
                file.derived,
                (sent) => progress(file.source.size + sent),
              );
            await db.files.update(book.id, { uploaded: true });
          }
          if (!file && operation.baseRevision === 0)
            throw new Error(
              "The original file is missing on this device. Import it again before syncing.",
            );
        }
        // Earlier operations for the same record may have advanced its revision.
        const latest = await db.outbox.get(operation.opId);
        if (!latest) continue;
        const { data, error } = await cloud.rpc("apply_change", {
          p_operation: latest,
        });
        if (error) throw error;
        const remote = data.row as Row;
        if (data.conflict) {
          await acceptRemote(remote);
          continue;
        }
        await db.transaction("rw", [db.rows, db.outbox], async () => {
          await db.outbox.delete(operation.opId);
          const remaining = await db.outbox
            .where("key")
            .equals(operation.key)
            .toArray();
          for (const op of remaining)
            await db.outbox.update(op.opId, { baseRevision: remote.revision });
          if (remaining.length)
            await db.rows.update(operation.key, { revision: remote.revision });
          else await db.rows.put(remote);
        });
        if (operation.kind === "book") transferStatus(operation.id);
      } catch (error: any) {
        if (operation.kind === "book")
          transferStatus(operation.id, {
            state: "error",
            message: error.message || String(error),
          });
        failedKeys.add(operation.key);
        failures.push(
          `${operation.kind === "book" ? (operation.value as Book).title : operation.kind}: ${error.message || String(error)}`,
        );
      }
    }
  }
  let cursor = Number((await db.meta.get("cursor"))?.value || 0);
  while (!stopped) {
    const { data, error } = await cloud.rpc("pull_changes", {
      p_after: cursor,
    });
    if (error) throw error;
    const rows = data as Row[];
    for (const row of rows) {
      // Preserve remote revisions even when an upload failed; acceptRemote
      // retains pending local edits as conflicts instead of losing either side.
      await acceptRemote(row);
      cursor = Math.max(cursor, row.revision);
    }
    await db.meta.put({ key: "cursor", value: String(cursor) });
    if (rows.length < 200) break;
  }
  const conflicts = await db.conflicts.count();
  const pendingChanges = await db.outbox.count();
  report(
    failures.length
      ? { state: "error", message: failures[0], pendingChanges }
      : {
          state: "idle",
          message: conflicts
            ? `${conflicts} conflict${conflicts === 1 ? "" : "s"} to review`
            : pendingChanges
              ? `${pendingChanges} changes waiting to sync`
              : "Synced",
          pendingChanges,
          lastSync: pendingChanges ? status.lastSync : new Date().toISOString(),
        },
  );
}
export function synchronize() {
  requested = true;
  if (running) return running;
  const drain = async () => {
    do {
      requested = false;
      await runSync();
    } while (requested && !stopped && navigator.onLine);
  };
  running = (
    navigator.locks
      ? navigator.locks.request<void>("leafmark-sync", async () => {
          await drain();
        })
      : drain()
  )
    .catch((error) =>
      report({
        state: "error",
        message:
          error instanceof Error
            ? error.message
            : String(error.message || error),
      }),
    )
    .finally(() => {
      running = null;
    });
  return running;
}
export function startSync() {
  stopped = false;
  const listener = () => void synchronize();
  const offline = () =>
    report({
      state: "offline",
      message: "Offline · changes saved on this device",
    });
  const visible = () => {
    if (document.visibilityState === "visible") listener();
  };
  window.addEventListener("leafmark-sync", listener);
  window.addEventListener("online", listener);
  window.addEventListener("focus", listener);
  window.addEventListener("offline", offline);
  document.addEventListener("visibilitychange", visible);
  const timer = setInterval(listener, 15000);
  const channel = cloud
    ?.channel("library-changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "library_entries" },
      listener,
    )
    .subscribe();
  listener();
  return () => {
    stopped = true;
    clearInterval(timer);
    window.removeEventListener("leafmark-sync", listener);
    window.removeEventListener("online", listener);
    window.removeEventListener("focus", listener);
    window.removeEventListener("offline", offline);
    document.removeEventListener("visibilitychange", visible);
    if (channel) void cloud?.removeChannel(channel);
  };
}
export async function removeDownload(book: Book) {
  await db.transaction(
    "rw",
    [db.files, db.rows, db.outbox, db.conflicts],
    async () => {
      const row = await db.rows.get(`book:${book.id}`);
      const file = await db.files.get(book.id);
      if (
        !file?.uploaded ||
        !row?.revision ||
        (await db.outbox.where("key").equals(`book:${book.id}`).count()) ||
        (await db.conflicts.get(`book:${book.id}`))
      )
        throw new Error("Sync this book before removing its only local copy.");
      await db.files.delete(book.id);
    },
  );
}
export async function downloadBook(book: Book) {
  const existing = await db.files.get(book.id);
  if (existing) return existing;
  if (!cloud) throw new Error("This book is not downloaded on this device.");
  const {
    data: { user },
  } = await cloud.auth.getUser();
  if (!user) throw new Error("Sign in to download this book.");
  const download = (path: string) => downloadFreshBlob((nonce) =>
    cloud!.storage.from("library").download(
      `${user.id}/${path}`,
      { cacheNonce: nonce },
      // IndexedDB is the verified offline copy. Do not reuse Chrome's partial
      // HTTP-cache entries after an interrupted authenticated download.
      { cache: "no-store" },
    ),
  );
  const source = await download(book.sourcePath);
  let derived: Blob | undefined;
  if (book.derivedPath) {
    derived = await download(book.derivedPath);
  }
  const bytes = await source.arrayBuffer();
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  if (hash !== book.hash)
    throw new Error(
      "The downloaded file did not match this book. Retry the download.",
    );
  const file = { id: book.id, source, derived, uploaded: true };
  await db.files.put(file);
  return file;
}
