import { createClient } from "@supabase/supabase-js";
import { Upload } from "tus-js-client";
import { db, acceptRemote } from "./db";
import { type Book, type Row } from "./model";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
export const cloud =
  url && key && !url.includes("YOUR_PROJECT") ? createClient(url, key) : null;
export type SyncStatus = {
  state: "local" | "idle" | "syncing" | "offline" | "error";
  message: string;
  lastSync?: string;
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
  status = next;
  listeners.forEach((fn) => fn());
}
let running: Promise<void> | null = null;
let stopped = false;

async function upload(path: string, file: Blob) {
  if (!cloud || !url) return;
  const {
    data: { session },
  } = await cloud.auth.getSession();
  if (!session) throw new Error("Sign in to synchronize your saved changes.");
  await new Promise<void>((resolve, reject) => {
    const transfer = new Upload(file, {
      endpoint: `${url}/storage/v1/upload/resumable`,
      headers: {
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
  if (!session) return;
  const bound = await db.meta.get("owner");
  if (bound && bound.value !== session.user.id)
    throw new Error(
      "This local library belongs to another account. Sign out and clear local data first.",
    );
  await db.meta.put({ key: "owner", value: session.user.id });
  report({ state: "syncing", message: "Synchronizing…" });
  // Snapshot operation IDs; new changes remain queued for the next pass.
  const operations = await db.outbox.orderBy("sequence").toArray();
  const failures: string[] = [];
  const failedKeys = new Set<string>();
  for (const operation of operations) {
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
          await upload(`${session.user.id}/${book.sourcePath}`, file.source);
          if (file.derived && book.derivedPath)
            await upload(
              `${session.user.id}/${book.derivedPath}`,
              file.derived,
            );
          await db.files.update(book.id, { uploaded: true });
        }
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
    } catch (error: any) {
      failedKeys.add(operation.key);
      failures.push(
        `${operation.kind === "book" ? (operation.value as Book).title : operation.kind}: ${error.message || String(error)}`,
      );
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
      if (!failedKeys.has(row.key)) await acceptRemote(row);
      cursor = Math.max(cursor, row.revision);
    }
    await db.meta.put({ key: "cursor", value: String(cursor) });
    if (rows.length < 200) break;
  }
  const conflicts = await db.conflicts.count();
  report(
    failures.length
      ? { state: "error", message: failures[0] }
      : {
          state: "idle",
          message: conflicts
            ? `${conflicts} conflict${conflicts === 1 ? "" : "s"} to review`
            : "Synced",
          lastSync: new Date().toISOString(),
        },
  );
}
export function synchronize() {
  if (running) return running;
  running = (
    navigator.locks
      ? navigator.locks.request<void>("leafmark-sync", async () => {
          await runSync();
        })
      : runSync()
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
  window.addEventListener("leafmark-sync", listener);
  window.addEventListener("online", listener);
  window.addEventListener("focus", listener);
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
    if (channel) void cloud?.removeChannel(channel);
  };
}
export async function downloadBook(book: Book) {
  const existing = await db.files.get(book.id);
  if (existing) return existing;
  if (!cloud) throw new Error("This book is not downloaded on this device.");
  const {
    data: { user },
  } = await cloud.auth.getUser();
  if (!user) throw new Error("Sign in to download this book.");
  const source = await cloud.storage
    .from("library")
    .download(`${user.id}/${book.sourcePath}`);
  if (source.error) throw source.error;
  let derived: Blob | undefined;
  if (book.derivedPath) {
    const result = await cloud.storage
      .from("library")
      .download(`${user.id}/${book.derivedPath}`);
    if (result.error) throw result.error;
    derived = result.data;
  }
  const bytes = await source.data.arrayBuffer();
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  if (hash !== book.hash)
    throw new Error(
      "The downloaded file did not match this book. Retry the download.",
    );
  const file = { id: book.id, source: source.data, derived, uploaded: true };
  await db.files.put(file);
  return file;
}
