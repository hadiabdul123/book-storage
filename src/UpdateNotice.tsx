import { useEffect, useRef, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { db } from "./db";
import { useLocation } from "react-router-dom";

export function UpdateNotice() {
  const reading = useLocation().pathname.startsWith("/read/");
  const [offlineReady, setOfflineReady] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const registrationRef = useRef<ServiceWorkerRegistration | undefined>(undefined);
  const { needRefresh: [ready, setReady], updateServiceWorker } = useRegisterSW({
    onOfflineReady: () => setOfflineReady(true),
    onRegisteredSW: (_url, registration) => {
      registrationRef.current = registration;
      if (registration) void registration.update().catch(() => {});
    },
  });
  useEffect(() => {
    const failed = () => {
      setLoadFailed(true);
      // Keep the rejection visible to the reader; never reload over a draft.
      void registrationRef.current?.update().catch(() => {});
    };
    window.addEventListener("vite:preloadError", failed);
    return () => window.removeEventListener("vite:preloadError", failed);
  }, []);
  useEffect(() => {
    if (!offlineReady) return;
    const timer = setTimeout(() => setOfflineReady(false), 6500);
    return () => clearTimeout(timer);
  }, [offlineReady]);
  if (!ready && !loadFailed) return offlineReady ? <div className="toast" role="status">
    <span>Reader and dictionary are ready offline.</span>
    <button aria-label="Dismiss notification" onClick={() => setOfflineReady(false)}>Close</button>
  </div> : null;
  return <div className="update-banner" role="status">
    <span>{error || (loadFailed ? "A reading tool could not load. Connect to the internet and reload Leafmark. Your saved books and notes stay on this device." : "A new version is ready. Your saved library stays on this device.")}</span>
    {reading ? <a href="#/">{loadFailed ? "Back to library to reload" : "Back to library to update"}</a> : <button disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        // Wait for local writes, not cloud uploads. Outbox operations survive
        // reload and resume syncing with the new app.
        await db.transaction("rw", db.tables, async () => {});
        if (ready) await updateServiceWorker(true);
        else location.reload();
      } catch { setError("Could not update. Please try again."); setBusy(false); }
    }}>{busy ? "Updating…" : loadFailed ? "Reload Leafmark" : "Update"}</button>}
    <button aria-label="Dismiss update" onClick={() => { setReady(false); setLoadFailed(false); }}>×</button>
  </div>;
}
