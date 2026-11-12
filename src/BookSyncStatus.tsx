import { useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import { cloud, subscribeSync, syncSnapshot, synchronize } from "./sync";

/** Cloud confirmation and offline availability are deliberately separate. */
export function BookSyncStatus({ id }: { id: string }) {
  const sync = useSyncExternalStore(subscribeSync, syncSnapshot);
  const saved = useLiveQuery(async () => {
    const [file, row, pending, conflict] = await Promise.all([
      db.files.get(id),
      db.rows.get(`book:${id}`),
      db.outbox.where("key").equals(`book:${id}`).count(),
      db.conflicts.get(`book:${id}`),
    ]);
    return {
      local: !!file,
      uploaded: file?.uploaded,
      revision: row?.revision,
      pending,
      conflict: !!conflict,
    };
  }, [id]);
  if (!saved) return null;
  const transfer = sync.transfers?.[id];
  const confirmed =
    !!saved.revision &&
    !saved.pending &&
    !saved.conflict &&
    (!saved.local || saved.uploaded);
  const label = !cloud
    ? "Saved on this device"
    : saved.conflict
      ? "Sync conflict · review in Settings"
      : confirmed
        ? "Synced"
        : transfer?.state === "error"
          ? "Upload failed"
          : transfer?.state === "uploading"
            ? `Uploading · ${transfer.percent ?? 0}%`
            : "Waiting to upload";
  return (
    <div
      className="book-sync-status"
      data-state={confirmed ? "synced" : transfer?.state || "waiting"}
    >
      <span title={transfer?.message}>{label}</span>
      {cloud && (
        <span className="muted">
          {saved.local ? "Available offline" : "Download when opened"}
        </span>
      )}
      {!confirmed && transfer?.state === "error" && (
        <>
          <span className="sync-error-detail">{transfer.message}</span>
          <button
            type="button"
            className="text-button"
            onClick={() => void synchronize()}
          >
            Retry upload
          </button>
        </>
      )}
    </div>
  );
}
