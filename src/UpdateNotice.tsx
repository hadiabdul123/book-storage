import { useEffect, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { db } from "./db";

export function UpdateNotice() {
  const [reading, setReading] = useState(location.hash.startsWith("#/read/"));
  const [offlineReady, setOfflineReady] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { needRefresh: [ready, setReady], updateServiceWorker } = useRegisterSW({
    onOfflineReady: () => setOfflineReady(true),
    onRegisteredSW: (_url, registration) => {
      if (registration) void registration.update().catch(() => {});
    },
  });
  useEffect(() => {
    const changed = () => setReading(location.hash.startsWith("#/read/"));
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    if (!offlineReady) return;
    const timer = setTimeout(() => setOfflineReady(false), 6500);
    return () => clearTimeout(timer);
  }, [offlineReady]);
  if (!ready) return offlineReady ? <div className="toast" role="status">
    <span>Reader and dictionary are ready offline.</span>
    <button aria-label="Dismiss notification" onClick={() => setOfflineReady(false)}>Close</button>
  </div> : null;
  return <div className="update-banner" role="status">
    <span>{error || "A new version is ready. Your saved library stays on this device."}</span>
    {reading ? <a href="#/">Back to library to update</a> : <button disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        // Wait for local writes, not cloud uploads. Outbox operations survive
        // reload and resume syncing with the new app.
        await db.transaction("rw", db.tables, async () => {});
        await updateServiceWorker(true);
      } catch { setError("Could not update. Please try again."); setBusy(false); }
    }}>{busy ? "Updating…" : "Update"}</button>}
    <button aria-label="Dismiss update" onClick={() => setReady(false)}>×</button>
  </div>;
}
