import type { Session } from "@supabase/supabase-js";
import { repairSignIn, withDeadline } from "./authRecovery";
import { UpdateNotice } from "./UpdateNotice";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  HashRouter,
  NavLink,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import {
  BookOpen,
  LibraryBig,
  Highlighter,
  Settings2,
  Cloud,
  CloudOff,
  RefreshCw,
  X,
  ArrowRight,
} from "lucide-react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  cloud,
  startSync,
  subscribeSync,
  syncSnapshot,
  synchronize,
} from "./sync";
import { db } from "./db";
import { Library } from "./Library";
import { Notes } from "./Notes";
import { Settings } from "./Settings";
import { Reader } from "./Reader";
import { messageOf } from "./components";

export default function App() {
  return <HashRouter><AccessGate /><UpdateNotice /></HashRouter>;
}
function AccessGate() {
  const [authenticated, setAuthenticated] = useState(!cloud);
  const [checking, setChecking] = useState(!!cloud);
  const [authError, setAuthError] = useState("");
  const generation = useRef(0);
  const authorizedUser = useRef<string | null>(null);
  const verify = useCallback(async (session: Session | null) => {
    const request = ++generation.current;
    try {
      const bound = await db.meta.get("owner");
      if (request !== generation.current) return;
      if (!navigator.onLine && bound?.value) {
        setAuthenticated(true);
        setAuthError("");
        return;
      }
      if (!session) { authorizedUser.current = null; setAuthenticated(false); return; }
      if (bound && bound.value !== session.user.id)
        throw new Error("This device contains another account's private library. Use the original account to keep your saved books.");
      const { data, error } = await cloud!.rpc("is_library_owner")
        .abortSignal(AbortSignal.timeout(12000));
      if (request !== generation.current) return;
      if (error) throw error;
      if (data !== true) throw new Error("This account is not the configured library owner.");
      await db.meta.put({ key: "owner", value: session.user.id });
      if (request !== generation.current) return;
      authorizedUser.current = session.user.id;
      setAuthError("");
      setAuthenticated(true);
    } catch (error) {
      if (request === generation.current) {
        authorizedUser.current = null;
        setAuthenticated(false);
        setAuthError(messageOf(error));
        throw error;
      }
    } finally {
      if (request === generation.current) setChecking(false);
    }
  }, []);
  useEffect(() => {
    if (!cloud) return;
    let active = true;
    const check = async () => {
      const started = generation.current;
      try {
        const bound = await db.meta.get("owner");
        if (!navigator.onLine && bound?.value) {
          if (active) await verify(null);
          return;
        }
        const { data: { session }, error } = await withDeadline(cloud!.auth.getSession());
        if (error) throw error;
        if (active && started === generation.current) await verify(session);
      } catch (error) {
        if (active && started === generation.current) { setAuthError(messageOf(error)); setChecking(false); }
      }
    };
    void check();
    const { data: { subscription } } = cloud.auth.onAuthStateChange((event, session) => {
      // Use the supplied session. Re-reading it after every event can race a
      // newer sign-in, and token refresh must not repeatedly gate the reader.
      if (event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED") return;
      if (event === "SIGNED_IN" && session?.user.id === authorizedUser.current) return;
      setTimeout(() => { if (active) void verify(session).catch(() => {}); }, 0);
    });
    window.addEventListener("online", check);
    return () => {
      active = false;
      generation.current++;
      subscription.unsubscribe();
      window.removeEventListener("online", check);
    };
  }, [verify]);
  useEffect(() => { if (authenticated) return startSync(); }, [authenticated]);
  if (checking) return <div className="boot"><BookOpen size={32} /><p>Opening your reading space…</p></div>;
  if (!authenticated) return <SignIn error={authError} setError={setAuthError} onSignIn={verify} />;
  return <Shell />;
}
function Shell() {
  const location = useLocation(),
    reading = location.pathname.startsWith("/read/");
  const sync = useSyncExternalStore(subscribeSync, syncSnapshot);
  const conflicts = useLiveQuery(() => db.conflicts.count(), []) || 0;
  const [toast, setToast] = useState("");
  const notify = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 6500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  return (
    <div className={reading ? "app reading" : "app"}>
      {!reading && (
        <aside className="sidebar">
          <NavLink to="/" className="brand">
            <span className="brand-icon">
              <BookOpen size={23} />
            </span>
            leafmark<span className="brand-dot">.</span>
          </NavLink>
          <nav>
            {[
              ["/", LibraryBig, "Library"],
              ["/notes", Highlighter, "Highlights & notes"],
              ["/settings", Settings2, "Reading & settings"],
            ].map(([path, Icon, label]) => {
              const I = Icon as typeof BookOpen;
              return (
                <NavLink
                  end={path === "/"}
                  key={String(path)}
                  to={String(path)}
                >
                  <I size={20} />
                  <span>{String(label)}</span>
                  {path === "/settings" && conflicts > 0 && (
                    <b className="nav-badge">{conflicts}</b>
                  )}
                </NavLink>
              );
            })}
          </nav>
          <div className="sidebar-bottom">
            <div className="quiet-quote">
              A place for every book.
              <br />A little time for you.
            </div>
            <button
              className={`sync-status ${sync.state}`}
              onClick={() => void synchronize()}
              title={sync.message}
            >
              {sync.state === "syncing" ? (
                <RefreshCw className="spin" size={16} />
              ) : sync.state === "offline" || sync.state === "local" ? (
                <CloudOff size={17} />
              ) : (
                <Cloud size={17} />
              )}
              <span>{sync.message}</span>
            </button>
          </div>
        </aside>
      )}
      <div className="app-content">
        <Routes>
          <Route path="/" element={<Library notify={notify} />} />
          <Route path="/notes" element={<Notes />} />
          <Route path="/settings" element={<Settings notify={notify} />} />
          <Route path="/read/:id" element={<Reader notify={notify} />} />
          <Route path="*" element={<Library notify={notify} />} />
        </Routes>
      </div>
      {!reading && (
        <nav className="mobile-nav">
          <NavLink to="/" end>
            <LibraryBig size={21} />
            <span>Library</span>
          </NavLink>
          <NavLink to="/notes">
            <Highlighter size={21} />
            <span>Notes</span>
          </NavLink>
          <NavLink to="/settings">
            <Settings2 size={21} />
            <span>Settings{conflicts ? " •" : ""}</span>
          </NavLink>
        </nav>
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={16} />
          </button>
        </div>
      )}

    </div>
  );
}
function SignIn({ error, setError, onSignIn }: {
  error: string;
  setError: (error: string) => void;
  onSignIn: (session: Session | null) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="brand">
          <span className="brand-icon">
            <BookOpen size={24} />
          </span>
          leafmark.
        </div>
        <h1>
          Your next chapter
          <br />
          is waiting.
        </h1>
        <p className="muted">
          Sign in to your private library. Your books, notes, and place will be
          right here.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            const form = new FormData(e.currentTarget);
            try {
              const { data, error } = await withDeadline(cloud!.auth.signInWithPassword({
                email: String(form.get("email")).trim(),
                password: String(form.get("password")),
              }));
              if (error) throw error;
              await onSignIn(data.session);
            } catch (e) {
              setError(messageOf(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Email
            <input type="email" name="email" autoComplete="username" required />
          </label>
          <label>
            Password
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? "Signing in…" : "Open my library"}
            <ArrowRight size={18} />
          </button>
        </form>
        <button type="button" className="text-button" disabled={busy} onClick={repairSignIn}>
          Repair sign-in on this device
        </button>
        <small>Repair keeps downloaded books and notes. You will sign in again.</small>
        <small>Private access · One reader · All your devices</small>
      </div>
    </main>
  );
}
