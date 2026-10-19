import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowDownUp, ChevronDown, Info, LogOut, Power, Rss, ScrollText, Search, Settings } from "lucide-react";
import { api } from "../../api/client";
import { disconnect } from "../../api/socket";
import { attempt, quitApp } from "../../lib/actions";
import { useDrag } from "../../lib/hooks";
import { openDialog, setView, useStore } from "../../store/store";
import type { View } from "../../store/store";
import { useLog } from "../../views/log/logStore";
import { useRssBadge } from "../../views/rss/rssStore";
import { changeCount, useDraft } from "../../views/settings/draft";
import { TransferFilters } from "../../views/transfers/TransferFilters";
import { openDropdown } from "../ui/Menu";
import type { MenuEntry } from "../ui/Menu";

export const SIDEBAR_MIN = 184;
export const SIDEBAR_MAX = 420;
const SIDEBAR_DEFAULT = 232;

export function BrandLogo() {
  return (
    <span className="brand-logo" aria-hidden>
      {/* The flame of public/favicon.svg: a dimmer left facet, a brighter right one. */}
      <svg viewBox="6 2.8 20 26">
        <path d="M16 3.8V17l-2.6 5 2.6 5.8-5.8-3.2L8 17.8l3.4-7.2Z" fillOpacity={0.67} />
        <path d="m16 3.8 4.6 6.8 3.4 7.2-2.2 6.8-5.8 3.2 2.6-5.8L16 17Z" />
      </svg>
    </span>
  );
}

/** The lower part of the sidebar belongs to the current view. */
const SECTIONS: Partial<Record<View, () => ReactNode>> = {
  transfers: () => <TransferFilters />,
};

export function registerSidebarSection(view: View, render: () => ReactNode): void {
  SECTIONS[view] = render;
}

interface NavItemProps {
  view: View;
  icon: ReactNode;
  label: string;
  badge?: number;
  badgeTone?: "warning" | "error";
  /** Something there needs attention (unsaved settings). */
  dot?: string;
}

function NavItem({ view, icon, label, badge, badgeTone, dot }: NavItemProps) {
  const on = useStore((s) => s.view === view);
  return (
    <button
      type="button"
      className={`nav-item${on ? " on" : ""}`}
      aria-current={on ? "page" : undefined}
      onClick={() => {
        setView(view);
        useStore.setState({ navOpen: false });
      }}
    >
      {icon}
      <span className="nav-label">{label}</span>
      {!!badge && <span className={`nav-unread${badgeTone ? ` ${badgeTone}` : ""}`}>{badge > 999 ? "999+" : badge}</span>}
      {dot && <span className="nav-dot" title={dot} aria-label={dot} />}
    </button>
  );
}

async function signOut(): Promise<void> {
  await attempt(() => api.logout(), "Couldn't sign out");
  disconnect();
  const auth = useStore.getState().auth;
  if (auth) useStore.setState({ auth: { ...auth, authenticated: false } });
}

function brandMenu(): MenuEntry[] {
  const { app } = useStore.getState();
  return [
    { label: "About Promethea", icon: <Info />, onSelect: () => openDialog({ type: "about" }) },
    { type: "separator" },
    { label: "Settings", icon: <Settings />, hint: "Ctrl+,", onSelect: () => setView("settings") },
    { label: "Log", icon: <ScrollText />, onSelect: () => setView("log") },
    { type: "separator" },
    // Signed in with a password (the web UI); the desktop app and local browsers don't sign in.
    app && !app.local && { label: "Sign out", icon: <LogOut />, onSelect: () => void signOut() },
    app?.canQuit && { label: "Quit Promethea", icon: <Power />, onSelect: quitApp },
  ];
}

function Brand() {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      className={`brand${open ? " open" : ""}`}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={(e) => {
        setOpen(true);
        openDropdown(e.currentTarget, brandMenu(), { onClose: () => setOpen(false) });
      }}
    >
      <BrandLogo />
      <span className="brand-name">Promethea</span>
      <ChevronDown className="brand-caret" />
    </button>
  );
}

export function Sidebar({ badges = {} }: { badges?: Partial<Record<View, number>> }) {
  const view = useStore((s) => s.view);
  const start = useRef(0);
  const drag = useDrag((dx) => {
    const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(start.current + dx)));
    useStore.setState({ sidebarWidth: w });
  });
  const section = SECTIONS[view];
  const unsaved = useDraft((s) => changeCount(s.draft));
  const unseen = useLog((s) => s.unseen);
  const unseenErrors = useLog((s) => s.unseenErrors);
  // Articles that came in since the RSS view was last open.
  const rssBadge = useRssBadge();

  return (
    <aside className="sidebar" aria-label="Navigation">
      <div className="brand-row">
        <Brand />
      </div>

      <nav className="nav">
        <NavItem view="transfers" icon={<ArrowDownUp />} label="Transfers" badge={badges.transfers} />
        <NavItem view="search" icon={<Search />} label="Search" badge={badges.search} />
        <NavItem view="rss" icon={<Rss />} label="RSS" badge={badges.rss ?? rssBadge} />
      </nav>

      <div className="sidebar-scroll">{section?.()}</div>

      <div className="side-footer">
        <NavItem view="settings" icon={<Settings />} label="Settings" dot={unsaved ? "Unsaved changes" : undefined} />
        <NavItem
          view="log"
          icon={<ScrollText />}
          label="Log"
          badge={badges.log ?? unseen}
          badgeTone={unseenErrors ? "error" : unseen ? "warning" : undefined}
        />
      </div>

      <div
        className="sidebar-resizer"
        onPointerDown={(e) => {
          start.current = useStore.getState().sidebarWidth;
          drag(e);
        }}
        onDoubleClick={() => useStore.setState({ sidebarWidth: SIDEBAR_DEFAULT })}
      />
    </aside>
  );
}
