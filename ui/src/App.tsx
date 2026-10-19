import { useEffect, useState } from "react";
import type { ComponentType, CSSProperties } from "react";
import { CircleAlert, FileDown, RefreshCw, WifiOff } from "lucide-react";
import { api, onUnauthorized } from "./api/client";
import { connect, disconnect } from "./api/socket";
import { LoginPage } from "./components/shell/LoginPage";
import { BrandLogo, Sidebar } from "./components/shell/Sidebar";
import { StatusBar } from "./components/shell/StatusBar";
import { Button } from "./components/ui/Button";
import { MenuHost } from "./components/ui/Menu";
import { Spinner } from "./components/ui/Misc";
import { Toasts } from "./components/ui/Toasts";
import { TooltipHost } from "./components/ui/Tooltip";
import { DialogHost } from "./dialogs/DialogHost";
import { useBackendEvents, useDropTarget, useGlobalPaste, useGlobalShortcuts, useWindowTitle } from "./lib/global";
import { applyLook } from "./lib/look";
import { useStore } from "./store/store";
import type { View } from "./store/store";
import { LogView } from "./views/log/LogView";
import { RssView } from "./views/rss/RssView";
import { SearchView } from "./views/search/SearchView";
import { useDraft } from "./views/settings/draft";
import { SettingsView } from "./views/settings/SettingsView";
import { TransfersView } from "./views/transfers/TransfersView";

const VIEWS: Partial<Record<View, ComponentType>> = {
  transfers: TransfersView,
  search: SearchView,
  rss: RssView,
  settings: SettingsView,
  log: LogView,
};

async function boot(): Promise<void> {
  const auth = await api.authState();
  useStore.setState({ auth });
  if (!auth.authenticated) return;
  const [app, prefs] = await Promise.all([api.app(), api.prefs()]);
  useStore.setState({ app, prefs });
  connect();
}

/** A look preference: the unsaved value from the settings if there is one, so changes preview. */
function useLookPref(key: string, fallback: string): string {
  const saved = useStore((s) => s.prefs?.behavior?.[key]) as string | undefined;
  const unsaved = useDraft((s) => s.draft.behavior?.[key]) as string | undefined;
  return unsaved ?? saved ?? fallback;
}

/** Follow the theme, accent and density preferences (and the OS theme for "system"). */
function useLook(): void {
  const theme = useLookPref("theme", "system");
  const accent = useLookPref("accent", "violet");
  const density = useLookPref("density", "comfortable");
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () =>
      applyLook({ theme: theme === "light" || (theme === "system" && mq.matches) ? "light" : "dark", accent, density });
    apply();
    if (theme !== "system") return;
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme, accent, density]);
}

/** Shown when the socket has been down for more than a moment. */
function OfflineBanner() {
  const connected = useStore((s) => s.connected);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (connected) {
      setShow(false);
      return;
    }
    const t = window.setTimeout(() => setShow(true), 2500);
    return () => window.clearTimeout(t);
  }, [connected]);
  if (!show) return null;
  return (
    <div className="offline-banner" role="status">
      <WifiOff />
      Lost the connection to Promethea. Reconnecting…
    </div>
  );
}

function DropOverlay() {
  return (
    <div className="drop-overlay">
      <div className="drop-target">
        <FileDown />
        Drop to add
        <span>.torrent files and magnet links</span>
      </div>
    </div>
  );
}

function Shell() {
  const view = useStore((s) => s.view);
  const width = useStore((s) => s.sidebarWidth);
  const navOpen = useStore((s) => s.navOpen);
  const dropping = useDropTarget();
  useLook();
  useBackendEvents();
  useGlobalPaste();
  useGlobalShortcuts();
  useWindowTitle();

  const Main = VIEWS[view] ?? TransfersView;
  return (
    <div className={`app${navOpen ? " nav-open" : ""}`} style={{ "--sidebar-w": `${width}px` } as CSSProperties}>
      <Sidebar />
      <div className="nav-scrim" onClick={() => useStore.setState({ navOpen: false })} />
      <main className="main">
        <OfflineBanner />
        <Main />
      </main>
      <StatusBar />
      <DialogHost />
      <MenuHost />
      <TooltipHost />
      <Toasts />
      {dropping && <DropOverlay />}
    </div>
  );
}

function BootScreen({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  return (
    <div className="boot">
      <div className="boot-inner">
        <BrandLogo />
        {error ? (
          <>
            <div className="row muted" style={{ gap: 8 }}>
              <CircleAlert className="text-err" width={16} height={16} />
              {error}
            </div>
            <Button icon={<RefreshCw />} onClick={onRetry}>
              Try again
            </Button>
          </>
        ) : (
          <Spinner size={18} />
        )}
      </div>
    </div>
  );
}

function QuitScreen() {
  return (
    <div className="boot">
      <div className="boot-inner">
        <BrandLogo />
        <div className="muted">Promethea has quit. You can close this page.</div>
      </div>
    </div>
  );
}

export function App() {
  const auth = useStore((s) => s.auth);
  const ready = useStore((s) => !!s.app && !!s.prefs);
  const quit = useStore((s) => s.quit);
  const [error, setError] = useState("");

  const start = () => {
    setError("");
    boot().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    // The session ended (expired, logged out elsewhere, password changed): back to the login page.
    onUnauthorized(() => {
      disconnect();
      const current = useStore.getState().auth;
      if (current?.authenticated) useStore.setState({ auth: { ...current, authenticated: false } });
    });
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (quit) return <QuitScreen />;
  if (error) return <BootScreen error={error} onRetry={start} />;
  if (!auth) return <BootScreen />;
  if (!auth.authenticated) return <LoginPage passwordSet={auth.passwordSet} onLogin={start} />;
  if (!ready) return <BootScreen />;
  return <Shell />;
}

