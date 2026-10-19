import { useRef } from "react";
import type { ReactNode } from "react";
import {
  ChevronDown,
  Ellipsis,
  FilePlus,
  Folder,
  FolderX,
  Globe,
  Link,
  Menu as MenuIcon,
  PanelBottom,
  Pause,
  Play,
  Plus,
  Tag,
  Trash,
  Wand,
  CircleSlash,
  Activity,
} from "lucide-react";
import type { Torrent } from "../../api/types";
import { Button, IconButton } from "../../components/ui/Button";
import { SearchInput } from "../../components/ui/Form";
import { openDropdown } from "../../components/ui/Menu";
import type { MenuEntry } from "../../components/ui/Menu";
import * as A from "../../lib/actions";
import { pickTorrentFiles } from "../../lib/add";
import { useEvent } from "../../lib/hooks";
import { isStopped, STATUS_FILTERS } from "../../lib/states";
import { openDialog, selectedIds, setFilter, useStore } from "../../store/store";
import type { Filter } from "../../store/store";
import { torrentMenu } from "./torrentMenu";

export function addMenu(): MenuEntry[] {
  // Making a torrent reads files on the machine Promethea runs on, so only from that machine.
  const local = !!useStore.getState().app?.local;
  return [
    { label: "Torrent files…", icon: <FilePlus />, hint: "Ctrl+O", onSelect: () => void pickTorrentFiles() },
    { label: "Magnet links or URLs…", icon: <Link />, hint: "Ctrl+U", onSelect: () => openDialog({ type: "addLinks" }) },
    local && { type: "separator" },
    local && { label: "Create torrent…", icon: <Wand />, hint: "Ctrl+N", onSelect: () => openDialog({ type: "creator" }) },
  ];
}

function statusTitle(status: Filter["status"]): string {
  if (status === "all") return "All torrents";
  return STATUS_FILTERS.find((f) => f.key === status)?.label ?? "Torrents";
}

function Chip({ icon, label, onClear }: { icon: ReactNode; label: string; onClear: () => void }) {
  return (
    <span className="chip">
      {icon}
      <span>{label}</span>
      <button type="button" className="chip-x" aria-label={`Clear ${label} filter`} onClick={onClear}>
        <svg viewBox="0 0 12 12" aria-hidden>
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </span>
  );
}

function FilterChips() {
  const filter = useStore((s) => s.filter);
  const chips: ReactNode[] = [];
  if (filter.category !== null) {
    chips.push(
      <Chip
        key="category"
        icon={filter.category ? <Folder /> : <FolderX />}
        label={filter.category || "Uncategorized"}
        onClear={() => setFilter({ category: null })}
      />,
    );
  }
  if (filter.tag !== null) {
    chips.push(
      <Chip
        key="tag"
        icon={filter.tag ? <Tag /> : <CircleSlash />}
        label={filter.tag || "Untagged"}
        onClear={() => setFilter({ tag: null })}
      />,
    );
  }
  if (filter.tracker !== null) {
    chips.push(
      <Chip
        key="tracker"
        icon={filter.tracker ? <Globe /> : <Activity />}
        label={filter.tracker || "Trackerless"}
        onClear={() => setFilter({ tracker: null })}
      />,
    );
  }
  return chips.length ? <div className="filter-chips">{chips}</div> : null;
}

export function TransfersToolbar({ count }: { count: number }) {
  const status = useStore((s) => s.filter.status);
  const text = useStore((s) => s.filter.text);
  const selected = useStore((s) => s.selected);
  const torrents = useStore((s) => s.torrents);
  const detailsOpen = useStore((s) => s.detailsOpen);
  const input = useRef<HTMLInputElement>(null);

  useEvent("ui.focusFilter", () => {
    input.current?.focus();
    input.current?.select();
  });

  const sel = [...selected].map((id) => torrents[id]).filter(Boolean) as Torrent[];
  const none = sel.length === 0;

  return (
    <header className="toolbar">
      <IconButton
        className="nav-toggle"
        label="Menu"
        onClick={() => useStore.setState((s) => ({ navOpen: !s.navOpen }))}
      >
        <MenuIcon />
      </IconButton>
      <div className="toolbar-title">
        <h1>{statusTitle(status)}</h1>
        <span className="badge">{count.toLocaleString()}</span>
        {sel.length > 1 && <span className="toolbar-sel">{sel.length.toLocaleString()} selected</span>}
      </div>
      <FilterChips />
      <div className="spacer" />
      <SearchInput
        ref={input}
        value={text}
        onChange={(v) => setFilter({ text: v })}
        placeholder="Filter by name"
        hint="Ctrl+F"
        aria-label="Filter torrents by name"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !text) input.current?.blur();
          if (e.key === "ArrowDown" || e.key === "Enter") {
            e.preventDefault();
            document.querySelector<HTMLElement>(".tt")?.focus();
          }
        }}
      />
      <div className="toolbar-group">
        <IconButton
          label="Start"
          disabled={none || !sel.some(isStopped)}
          onClick={() => A.start(selectedIds())}
        >
          <Play />
        </IconButton>
        <IconButton
          label="Stop"
          disabled={none || sel.every(isStopped)}
          onClick={() => A.stop(selectedIds())}
        >
          <Pause />
        </IconButton>
        <IconButton label="Remove" shortcut="Del" disabled={none} onClick={() => A.requestDelete(selectedIds())}>
          <Trash />
        </IconButton>
        <IconButton
          label="More actions"
          disabled={none}
          onClick={(e) => openDropdown(e.currentTarget, torrentMenu(selectedIds()), { align: "end" })}
        >
          <Ellipsis />
        </IconButton>
      </div>
      <IconButton
        label={detailsOpen ? "Hide details" : "Show details"}
        active={detailsOpen}
        onClick={() => useStore.setState((s) => ({ detailsOpen: !s.detailsOpen }))}
      >
        <PanelBottom />
      </IconButton>
      <Button
        variant="primary"
        className="toolbar-add"
        icon={<Plus />}
        onClick={(e) => openDropdown(e.currentTarget, addMenu(), { align: "end" })}
      >
        Add
        <ChevronDown className="btn-caret" />
      </Button>
    </header>
  );
}
