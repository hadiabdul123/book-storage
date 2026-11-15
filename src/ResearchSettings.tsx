import { useState } from "react";
import { cloud } from "./sync";
export function ResearchSettings() {
  const [status, setStatus] = useState("Groq explains selected excerpts. Tavily searches the web. New research needs a connection and available free allowance.");
  const [busy, setBusy] = useState(false);
  return <section className="settings-section"><h2>AI research</h2><p role="status">{status}</p><p className="muted">API keys stay in backend secrets. Questions run only when you ask; queued offline questions resume while Leafmark is open. Paid provider upgrades are not enabled by this app.</p>
    <button className="secondary" disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        if (!cloud) throw new Error("Connect Supabase to enable research.");
        const { data: { session } } = await cloud.auth.getSession();
        if (!session) throw new Error("Sign in to check research.");
        const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/research`, { headers: { Authorization: `Bearer ${session.access_token}`, apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY }, signal: AbortSignal.timeout(15000) });
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || "The research backend is not available yet.");
        setStatus(body.groq && body.tavily ? "Groq and Tavily are configured. Research is ready; provider quotas still apply." : "The backend is installed. Add GROQ_API_KEY and TAVILY_API_KEY in Supabase Edge Function Secrets.");
      } catch (e) { setStatus(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
    }}>{busy ? "Checking…" : "Check research connection"}</button>
  </section>;
}
