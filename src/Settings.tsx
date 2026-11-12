import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Download,
  RefreshCw,
  LogOut,
  RotateCcw,
  BookOpen,
  Clock3,
  Check,
  AlertCircle,
} from "lucide-react";
import { db, list, save, clearPrivateData } from "./db";
import { cloud, synchronize } from "./sync";
import { type Book, type Annotation, readingSeconds, now } from "./model";
import { exportAnnotations } from "./export";
import { Dialog, messageOf } from "./components";
import { restoreAnnotationBackup } from "./backup";

export function Settings({ notify }: { notify: (m: string) => void }) {
  const books = useLiveQuery(() => list("book"), []) || [],
    sessions = useLiveQuery(() => list("session"), []) || [],
    trash =
      useLiveQuery(
        () =>
          db.rows
            .filter(
              (r) =>
                r.deleted && (r.kind === "book" || r.kind === "annotation"),
            )
            .toArray(),
        [],
      ) || [],
    pending = useLiveQuery(() => db.outbox.count(), []) || 0;
  const [storage, setStorage] = useState<StorageEstimate>({}),
    [account, setAccount] = useState(""),
    [backup, setBackup] = useState(false);
  async function purge(book: Book) {
    if (
      !confirm(
        "Permanently delete this book’s files from this device and Supabase? This cannot be undone. Export any notes you need first.",
      )
    )
      return;
    try {
      await save("book", { ...book, purgedAt: book.purgedAt || now() }, true);
      if (cloud) {
        await synchronize();
        if (
          (await db.outbox.where("key").equals(`book:${book.id}`).count()) ||
          (await db.conflicts.get(`book:${book.id}`))
        )
          throw new Error(
            "The deletion must synchronize first. Resolve pending changes, then retry deleting the files.",
          );
        const confirmed = await db.rows.get(`book:${book.id}`);
        if (!confirmed?.deleted || !(confirmed.value as Book).purgedAt)
          throw new Error("A newer book change was synced. Review the book before permanently deleting its files.");
        const {
          data: { session },
        } = await cloud.auth.getSession();
        if (!session) throw new Error("Sign in to delete cloud files.");
        const paths = [
          book.sourcePath,
          ...(book.derivedPath ? [book.derivedPath] : []),
        ].map((p) => `${session.user.id}/${p}`);
        const { error } = await cloud.storage.from("library").remove(paths);
        if (error) throw error;
      }
      await db.files.delete(book.id);
      notify(
        "Book files permanently deleted. Annotation exports remain available.",
      );
    } catch (e) {
      notify(messageOf(e));
    }
  }
  useEffect(() => {
    void navigator.storage?.estimate().then(setStorage);
    void cloud?.auth
      .getSession()
      .then(({ data }) => setAccount(data.session?.user.email || ""));
  }, []);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const day = 86400000;
  const days = Array.from({ length: 7 }, (_, i) => {
    const from = midnight.getTime() - (6 - i) * day;
    return {
      date: new Date(from),
      minutes: Math.round(readingSeconds(sessions, from, from + day) / 60),
    };
  });
  const max = Math.max(15, ...days.map((d) => d.minutes));
  return (
    <div className="settings-page">
      <header className="page-header">
        <div>
          <p className="page-kicker">Make room for reading</p>
          <h1>Reading & settings</h1>
        </div>
      </header>
      <section className="stats-grid">
        <div>
          <Clock3 size={21} />
          <strong>
            {Math.round(readingSeconds(sessions, midnight.getTime()) / 60)}
            <small> min</small>
          </strong>
          <span>Read today</span>
        </div>
        <div>
          <BookOpen size={21} />
          <strong>
            {Math.round((readingSeconds(sessions) / 3600) * 10) / 10}
            <small> hr</small>
          </strong>
          <span>Total reading time</span>
        </div>
        <div>
          <Check size={21} />
          <strong>{books.filter((b) => b.status === "finished").length}</strong>
          <span>Books finished</span>
        </div>
      </section>
      <section className="settings-section">
        <h2>A little reading, every day</h2>
        <div className="activity-chart">
          {days.map((d) => (
            <div key={d.date.toISOString()}>
              <span>{d.minutes ? `${d.minutes}m` : ""}</span>
              <div className="activity-track">
                <div
                  style={{ height: `${Math.max(3, (d.minutes / max) * 100)}%` }}
                />
              </div>
              <small>
                {d.date.toLocaleDateString(undefined, { weekday: "short" })}
              </small>
            </div>
          ))}
        </div>
      </section>
      <section className="settings-section">
        <h2>Account & synchronization</h2>
        {cloud ? (
          <>
            <p>{account}</p>
            <p className="muted">
              {pending
                ? `${pending} change${pending === 1 ? "" : "s"} waiting to synchronize.`
                : "Your local changes have been sent."}
            </p>
            <div className="button-row">
              <button className="secondary" onClick={() => void synchronize()}>
                <RefreshCw size={17} />
                Sync now
              </button>
              <button
                className="text-button"
                onClick={async () => {
                  if (!cloud) return;
                  if (pending) {
                    notify("Sync your pending changes before signing out.");
                    return;
                  }
                  if (
                    !confirm(
                      "Sign out and remove downloaded books and private data from this device?",
                    )
                  )
                    return;
                  try {
                    await clearPrivateData();
                    await cloud.auth.signOut({ scope: "local" });
                    location.reload();
                  } catch (e) {
                    notify(messageOf(e));
                  }
                }}
              >
                <LogOut size={17} />
                Sign out
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="notice">
              <AlertCircle size={18} />
              This library is currently stored only on this device.
            </p>
            <p className="muted">
              Connect your Supabase project using the setup instructions in the
              project README. Books and annotations will upload after you sign
              in. Until then, keep your original books and export your notes
              regularly.
            </p>
          </>
        )}
      </section>
      <section className="settings-section">
        <h2>Automatic saving and sync</h2>
        <p>Changes save on this device and sync automatically when connected.
          If the same item changes on two devices, the latest edit wins, including removals.</p>
      </section>
      <section className="settings-section">
        <h2>Offline storage</h2>
        <p>
          {((storage.usage || 0) / 1024 / 1024).toFixed(1)} MB used on this
          device
          {storage.quota
            ? ` of ${(storage.quota / 1024 / 1024 / 1024).toFixed(1)} GB available`
            : ""}
        </p>
        <p className="muted">
          Open a book to keep a local copy, or download it from Book details.
          Browser storage can be cleared by your device; cloud copies and
          exports are your backup.
        </p>
        <button
          className="secondary"
          onClick={async () => {
            const persisted = await navigator.storage?.persist?.();
            notify(
              persisted
                ? "Persistent storage is enabled."
                : "Your browser manages storage automatically.",
            );
          }}
        >
          Keep offline storage
        </button>
      </section>
      <section className="settings-section">
        <h2>Take your notes with you</h2>
        <p className="muted">
          Exports include original passages, your notes, and links back to the
          book. JSON also preserves exact location anchors.
        </p>
        <div className="button-row">
          {(["md", "csv", "json"] as const).map((format) => (
            <button
              key={format}
              className="secondary"
              onClick={async () =>
                exportAnnotations(await list("annotation"), books, format)
              }
            >
              <Download size={16} />
              {{ md: "Markdown", csv: "CSV", json: "JSON backup" }[format]}
            </button>
          ))}
        </div>
        <button className="text-button" onClick={() => setBackup(true)}>
          Restore annotations from JSON
        </button>
      </section>
      <section className="settings-section">
        <h2>Trash</h2>
        <p className="muted">
          Trashed books retain their files until you permanently delete them.
        </p>
        {trash.length ? (
          trash.map((row) => (
            <div className="trash-row" key={row.key}>
              <span>
                {row.kind === "book"
                  ? (row.value as Book).title
                  : (row.value as Annotation).text.slice(0, 85)}
                {row.kind === "book" && (row.value as Book).purgedAt
                  ? " · Permanently removed"
                  : ""}
              </span>
              <div className="button-row">
                {!(row.kind === "book" && (row.value as Book).purgedAt) && (
                  <button
                    className="text-button"
                    onClick={async () => {
                      try {
                        await save(row.kind, row.value, false);
                        notify("Restored.");
                      } catch (e) {
                        notify(messageOf(e));
                      }
                    }}
                  >
                    <RotateCcw size={15} />
                    Restore
                  </button>
                )}
                {row.kind === "book" && (
                  <button
                    className="text-button danger"
                    onClick={() => void purge(row.value as Book)}
                  >
                    {(row.value as Book).purgedAt
                      ? "Retry file cleanup"
                      : "Delete files"}
                  </button>
                )}
              </div>
            </div>
          ))
        ) : (
          <p className="muted">Nothing in the trash.</p>
        )}
      </section>
      <p className="app-version">Leafmark 0.1 · A personal reading space</p>
      {backup && (
        <Dialog title="Restore annotations" onClose={() => setBackup(false)}>
          <p>
            Import the original books first. Their file hashes must match the
            export. Existing annotations are left untouched.
          </p>
          <input
            aria-label="JSON annotation backup"
            type="file"
            accept=".json"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                const data = JSON.parse(await file.text());
                const { restored: count, skipped } = await restoreAnnotationBackup(data, books);
                notify(
                  `Restored ${count} annotations; skipped ${skipped} duplicates or missing books.`,
                );
                setBackup(false);
              } catch (e) {
                notify(messageOf(e));
              }
            }}
          />
        </Dialog>
      )}
    </div>
  );
}
