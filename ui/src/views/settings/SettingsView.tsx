// Settings: one scrolling page of grouped cards. The sidebar lists its sections and follows
// the scroll; changes wait in a draft until saved (the bar at the bottom, or Ctrl+S).

import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { FolderDown, Gauge, Globe, Menu as MenuIcon, Network, Rss, Save, SearchX, Share2, SlidersHorizontal, Undo2, Wrench } from "lucide-react";
import { registerSidebarSection } from "../../components/shell/Sidebar";
import { Button, IconButton } from "../../components/ui/Button";
import { SearchInput } from "../../components/ui/Form";
import { useEvent } from "../../lib/hooks";
import { useStore } from "../../store/store";
import { changeCount, discard, PREF_SECTION, save, useDraft } from "./draft";
import type { SectionId } from "./draft";
import { AdvancedSection } from "./sections/Advanced";
import { BitTorrentSection } from "./sections/BitTorrent";
import { ConnectionSection } from "./sections/Connection";
import { DownloadsSection } from "./sections/Downloads";
import { GeneralSection } from "./sections/General";
import { RssSection } from "./sections/Rss";
import { SpeedSection } from "./sections/Speed";
import { WebUiSection } from "./sections/WebUi";

const SECTIONS: { id: SectionId; label: string; icon: ReactNode }[] = [
  { id: "general", label: "General", icon: <SlidersHorizontal /> },
  { id: "downloads", label: "Downloads", icon: <FolderDown /> },
  { id: "connection", label: "Connection", icon: <Network /> },
  { id: "speed", label: "Speed", icon: <Gauge /> },
  { id: "bittorrent", label: "BitTorrent", icon: <Share2 /> },
  { id: "rss", label: "RSS", icon: <Rss /> },
  { id: "webui", label: "Web UI", icon: <Globe /> },
  { id: "advanced", label: "Advanced", icon: <Wrench /> },
];

/** While a scroll we started runs, the scroll position doesn't pick the active section. */
let spyPausedUntil = 0;

function sectionEl(id: SectionId): HTMLElement | null {
  return document.getElementById(`settings-${id}`);
}

function scrollToSection(id: SectionId, smooth = true): void {
  const el = sectionEl(id);
  if (!el) return;
  // A section the search hides comes back by clearing the search.
  if (!el.getClientRects().length && useDraft.getState().query) {
    useDraft.setState({ query: "" });
    requestAnimationFrame(() => scrollToSection(id, false));
    return;
  }
  spyPausedUntil = performance.now() + (smooth ? 900 : 100);
  useDraft.setState({ active: id });
  el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
}

function useScrollSpy(ref: RefObject<HTMLDivElement | null>, query: string): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (performance.now() < spyPausedUntil) return;
      const top = el.getBoundingClientRect().top;
      const sections = [...el.querySelectorAll<HTMLElement>(".set-section")].filter((s) => s.getClientRects().length);
      if (!sections.length) return;
      let current = sections[0].dataset.section as SectionId;
      for (const s of sections) {
        if (s.getBoundingClientRect().top - top > 120) break;
        current = s.dataset.section as SectionId;
      }
      // Scrolled to the end: the last section counts, even when it's too short to reach the top.
      if (el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 4) current = sections[sections.length - 1].dataset.section as SectionId;
      if (current !== useDraft.getState().active) useDraft.setState({ active: current });
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const onEnd = () => {
      spyPausedUntil = 0;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("scrollend", onEnd);
    // A search changes what's on the page without necessarily scrolling it.
    onScroll();
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("scrollend", onEnd);
      cancelAnimationFrame(frame);
    };
  }, [ref, query]);
}

/** Opened with a section to show (Ctrl+, from a dialog's link): go there. */
function useJump(): void {
  const jump = useDraft((s) => s.jump);
  useEffect(() => {
    if (!jump) return;
    useDraft.setState({ jump: null });
    requestAnimationFrame(() => scrollToSection(jump, false));
  }, [jump]);
}

function useSaveShortcut(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "s") return;
      if (document.querySelector(".modal-scrim")) return;
      e.preventDefault();
      void save();
    };
    // Before the app's own shortcuts, which only keep the desktop window from saving the page.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

function SaveBar() {
  const count = useDraft((s) => changeCount(s.draft));
  const saving = useDraft((s) => s.saving);
  const error = useDraft((s) => s.error);
  if (!count && !error) return null;
  return (
    <div className={`set-savebar${error ? " failed" : ""}`} role="region" aria-label="Unsaved changes">
      <span className="set-savebar-text" role={error ? "alert" : undefined}>
        {error || `${count} unsaved change${count === 1 ? "" : "s"}`}
      </span>
      <Button variant="ghost" size="sm" icon={<Undo2 />} onClick={discard} disabled={saving}>
        Discard
      </Button>
      <Button variant="primary" size="sm" icon={<Save />} loading={saving} onClick={() => void save()} tip="Ctrl+S">
        Save
      </Button>
    </div>
  );
}

function NoMatch() {
  const query = useDraft((s) => s.query.trim());
  if (!query) return null;
  return (
    <div className="set-nomatch">
      <SearchX />
      <div>No settings match “{query}”</div>
      <Button size="sm" onClick={() => useDraft.setState({ query: "" })}>
        Clear the search
      </Button>
    </div>
  );
}

export function SettingsView() {
  const scroller = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const query = useDraft((s) => s.query);
  useScrollSpy(scroller, query);
  useJump();
  useSaveShortcut();
  useEvent("ui.focusFilter", () => {
    search.current?.focus();
    search.current?.select();
  });

  return (
    <div className="settings">
      <header className="toolbar">
        <IconButton className="nav-toggle" label="Menu" onClick={() => useStore.setState((s) => ({ navOpen: !s.navOpen }))}>
          <MenuIcon />
        </IconButton>
        <div className="toolbar-title">
          <h1>Settings</h1>
        </div>
        <div className="spacer" />
        <SearchInput
          ref={search}
          value={query}
          onChange={(q) => {
            useDraft.setState({ query: q });
            scroller.current?.scrollTo({ top: 0 });
          }}
          placeholder="Search settings"
          hint="Ctrl+F"
          aria-label="Search settings"
        />
      </header>
      <div className="set-scroll" ref={scroller}>
        <div className="set-page">
          <GeneralSection />
          <DownloadsSection />
          <ConnectionSection />
          <SpeedSection />
          <BitTorrentSection />
          <RssSection />
          <WebUiSection />
          <AdvancedSection />
          <NoMatch />
        </div>
      </div>
      <SaveBar />
    </div>
  );
}

function SettingsNav() {
  const active = useDraft((s) => s.active);
  const draft = useDraft((s) => s.draft);
  return (
    <div className="side-section">
      <div className="side-head">
        <span className="side-label">Sections</span>
      </div>
      {SECTIONS.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`nav-item sm${active === s.id ? " on" : ""}`}
          aria-current={active === s.id ? "location" : undefined}
          onClick={() => {
            scrollToSection(s.id);
            useStore.setState({ navOpen: false });
          }}
        >
          {s.icon}
          <span className="nav-label">{s.label}</span>
          {PREF_SECTION[s.id] in draft && <span className="nav-dot" title="Unsaved changes" aria-label="Unsaved changes" />}
        </button>
      ))}
    </div>
  );
}

registerSidebarSection("settings", () => <SettingsNav />);
