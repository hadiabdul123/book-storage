import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
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
import { useRegisterSW } from "virtual:pwa-register/react";
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
  const [authenticated, setAuthenticated] = useState(!cloud),
    [checking, setChecking] = useState(!!cloud),
    [authError, setAuthError] = useState("");
  useEffect(() => {
    if (!cloud) return;
    let active = true;
    const verify = async () => {
      const {
        data: { session },
      } = await cloud!.auth.getSession();
      if (!session) {
        if (active) {
          setAuthenticated(false);
          setChecking(false);
        }
        return;
      }
      const bound = await db.meta.get("owner");
      if (bound && bound.value !== session.user.id) {
        if (active) {
          setAuthError(
            "This device contains another account’s private library. Sign out before switching accounts.",
          );
          setAuthenticated(false);
          setChecking(false);
        }
        return;
      }
      if (!navigator.onLine && bound?.value === session.user.id) {
        if (active) {
          setAuthenticated(true);
          setChecking(false);
        }
        return;
      }
      const { data, error } = await cloud!.rpc("is_library_owner");
      if (active) {
        setAuthenticated(data === true && !error);
        setAuthError(
          error
            ? error.message
            : data !== true
              ? "This account is not the configured library owner."
              : "",
        );
        setChecking(false);
      }
      if (data === true && !error)
        await db.meta.put({ key: "owner", value: session.user.id });
    };
    void verify().catch((e) => {
      setAuthError(messageOf(e));
      setChecking(false);
    });
    const {
      data: { subscription },
    } = cloud.auth.onAuthStateChange(() => {
      setTimeout(
        () => void verify().catch((e) => setAuthError(messageOf(e))),
        0,
      );
    });
    window.addEventListener("online", verify);
    return () => {
      active = false;
      subscription.unsubscribe();
      window.removeEventListener("online", verify);
    };
  }, []);
  useEffect(() => {
    if (authenticated) return startSync();
  }, [authenticated]);
  if (checking)
    return (
      <div className="boot">
        <BookOpen size={32} />
        <p>Opening your reading space…</p>
      </div>
    );
  if (!authenticated) return <SignIn initialError={authError} />;
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  );
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
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError: (error) => console.error("Leafmark offline setup failed:", error),
  });
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
      {needRefresh && (
        <div className="update-banner">
          <span>A new version is ready.</span>
          <button
            onClick={async () => {
              if (await db.outbox.count()) {
                notify("Sync or export your pending changes before updating.");
                return;
              }
              await updateServiceWorker(true);
            }}
          >
            Update
          </button>
          <button
            aria-label="Dismiss update"
            onClick={() => setNeedRefresh(false)}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
function SignIn({ initialError }: { initialError: string }) {
  const [error, setError] = useState(initialError),
    [busy, setBusy] = useState(false);
  useEffect(() => setError(initialError), [initialError]);
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
              const { error } = await cloud!.auth.signInWithPassword({
                email: String(form.get("email")),
                password: String(form.get("password")),
              });
              if (error) throw error;
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
        <small>Private access · One reader · All your devices</small>
      </div>
    </main>
  );
}
