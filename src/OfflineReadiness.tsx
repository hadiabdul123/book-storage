import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, list } from "./db";

export async function checkOfflineAssets() {
  if (!("serviceWorker" in navigator) || !("caches" in window)) return false;
  const registrations = await navigator.serviceWorker.getRegistrations();
  const active = registrations.some(r => r.active && location.href.startsWith(r.scope));
  const base = new URL(import.meta.env.BASE_URL, location.origin);
  const cached = active && await caches.match(new URL("index.html", base).href, { ignoreSearch: true });
  if (cached) await db.meta.put({ key: "offline-assets-ready", value: new Date().toISOString() });
  return !!cached;
}
export function OfflineReadiness() {
  const books = useLiveQuery(() => list("book"), []) || [];
  const files = useLiveQuery(() => db.files.toArray(), []) || [];
  const [ready, setReady] = useState(false), [status, setStatus] = useState("");
  useEffect(() => {
    let active = true;
    const check = () => { void checkOfflineAssets().then(value => { if (active) setReady(value); }).catch(() => {}); };
    check(); const timer = setInterval(check, 10000);
    navigator.serviceWorker?.addEventListener("controllerchange", check);
    return () => { active = false; clearInterval(timer); navigator.serviceWorker?.removeEventListener("controllerchange", check); };
  }, []);
  return <div className="offline-readiness"><p role="status">{ready ? "Reader tools are installed for offline use." : "Reader tools are not confirmed offline yet. Stay connected until installation finishes."}</p>
    <p>{files.filter(f => books.some(b => b.id === f.id && (b.format !== "docx" || !!f.derived))).length} of {books.length} books downloaded on this device.</p>
    <details><summary>Book download readiness</summary><ul>{books.map(b => <li key={b.id}>{b.title}: {files.some(f => f.id === b.id && (b.format !== "docx" || !!f.derived)) ? "Downloaded" : "Open online to download"}</li>)}</ul></details>
    <button className="text-button" onClick={async () => {
      try { setStatus("Checking reader installation…"); const registrations = await navigator.serviceWorker?.getRegistrations() || []; await Promise.all(registrations.map(r => r.update())); setReady(await checkOfflineAssets()); setStatus(registrations.length ? "Installation checked. Any missing update assets download while connected." : "Install the hosted HTTPS app to enable offline restart. Development mode does not install offline tools."); }
      catch { setStatus("Could not check installation. Reconnect and try again. Your downloads and writing are kept."); }
    }}>Check offline installation</button>{status && <p role="status">{status}</p>}
  </div>;
}
