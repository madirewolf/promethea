// The log: what Promethea did (ports, moves, errors) and the connections it turned away.
// New lines arrive at the bottom; the list follows them unless you've scrolled up.

import { memo, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
import { ArrowDown, CircleX, Copy, Info, ListX, Menu as MenuIcon, ScrollText, SearchX, ShieldBan, TriangleAlert } from "lucide-react";
import type { BlockedPeer, LogEntry } from "../../api/types";
import { registerSidebarSection } from "../../components/shell/Sidebar";
import { Button, IconButton } from "../../components/ui/Button";
import { SearchInput } from "../../components/ui/Form";
import { openContextMenu } from "../../components/ui/Menu";
import type { MenuEntry } from "../../components/ui/Menu";
import { Empty, Spinner } from "../../components/ui/Misc";
import { copyText } from "../../lib/actions";
import { formatDate, formatTime, plural } from "../../lib/format";
import { useEvent, usePoll } from "../../lib/hooks";
import { toast, useStore } from "../../store/store";
import {
  clearLog,
  fetchBlocked,
  fetchLog,
  markLogSeen,
  setLogFilter,
  useLog,
  useLogCounts,
  visibleBlocked,
  visibleEntries,
} from "./logStore";
import type { LogFilter } from "./logStore";

const LEVELS: Record<LogEntry["level"], { icon: ReactNode; label: string }> = {
  info: { icon: <Info />, label: "Info" },
  warning: { icon: <TriangleAlert />, label: "Warning" },
  error: { icon: <CircleX />, label: "Error" },
};

const TITLES: Record<LogFilter, string> = {
  all: "Log",
  warning: "Warnings",
  error: "Errors",
  blocked: "Blocked IPs",
};

/** "2026-10-15 14:03:22", for copied lines. */
function stamp(t: number): string {
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function entryLine(e: LogEntry): string {
  return `${stamp(e.time)}  ${e.level.toUpperCase().padEnd(7)}  ${e.msg}`;
}

function blockedLine(b: BlockedPeer): string {
  return `${stamp(b.time)}  ${b.ip}  ${b.reason}${b.count > 1 ? ` (${b.count} times)` : ""}`;
}

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  for (let j = lower.indexOf(q); j >= 0; j = lower.indexOf(q, i)) {
    if (j > i) parts.push(text.slice(i, j));
    parts.push(<mark key={j}>{text.slice(j, j + q.length)}</mark>);
    i = j + q.length;
  }
  parts.push(text.slice(i));
  return <>{parts}</>;
}

const EventRow = memo(function EventRow({ entry, index, q }: { entry: LogEntry; index: number; q: string }) {
  const level = LEVELS[entry.level] ?? LEVELS.info;
  return (
    <div className={`log-row ${entry.level}`} data-i={index}>
      <time className="log-time" title={formatDate(entry.time)}>
        {formatTime(entry.time)}
      </time>
      <span className="log-icon" title={level.label} aria-label={level.label}>
        {level.icon}
      </span>
      <span className="log-msg">
        <Highlight text={entry.msg} q={q} />
      </span>
    </div>
  );
});

const BlockedRow = memo(function BlockedRow({ peer, index, q }: { peer: BlockedPeer; index: number; q: string }) {
  return (
    <div className="log-row blocked" data-i={index}>
      <time className="log-time" title={formatDate(peer.time)}>
        {formatTime(peer.time)}
      </time>
      <span className="log-icon" aria-hidden>
        <ShieldBan />
      </span>
      <span className="log-ip">
        <Highlight text={peer.ip} q={q} />
      </span>
      <span className="log-reason">
        <Highlight text={peer.reason} q={q} />
        {peer.count > 1 && (
          <span className="log-count" title={`Blocked ${peer.count} times, last at ${formatTime(peer.last)}`}>
            ×{peer.count.toLocaleString()}
          </span>
        )}
      </span>
    </div>
  );
});

/**
 * Keep the list at its end as lines arrive, unless the user scrolled up to read:
 * then count what arrived for the "new" button.
 */
function useFollow(ref: RefObject<HTMLDivElement | null>, count: number, list: string) {
  const atEnd = useRef(true);
  const prevCount = useRef(count);
  const [away, setAway] = useState(false);
  const [fresh, setFresh] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    const added = count - prevCount.current;
    prevCount.current = count;
    if (!el) return;
    if (atEnd.current) el.scrollTop = el.scrollHeight;
    else if (added > 0) setFresh((f) => f + added);
  }, [ref, count]);

  // Another list (filter or search): start at its end.
  useLayoutEffect(() => {
    atEnd.current = true;
    setAway(false);
    setFresh(0);
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ref, list]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const end = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    atEnd.current = end;
    setAway(!end);
    if (end) setFresh(0);
  };
  const toEnd = () => {
    const el = ref.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };
  return { onScroll, away, fresh, toEnd };
}

function emptyState(filter: LogFilter): { icon: ReactNode; title: string; text: string } {
  switch (filter) {
    case "warning":
      return { icon: <TriangleAlert />, title: "No warnings", text: "Problems Promethea could work around show up here." };
    case "error":
      return { icon: <CircleX />, title: "No errors", text: "Problems that need you, like a full disk or a port that can't be opened, show up here." };
    case "blocked":
      return {
        icon: <ShieldBan />,
        title: "Nothing blocked",
        text: "Peers turned away by the IP filter, your banned IPs or the safeguards in Settings show up here.",
      };
    default:
      return { icon: <ScrollText />, title: "Nothing logged yet", text: "Promethea notes what it does here: ports it opens, files it moves, errors." };
  }
}

export function LogView() {
  const filter = useLog((s) => s.filter);
  const text = useLog((s) => s.text);
  const entries = useLog((s) => s.entries);
  const clearedId = useLog((s) => s.clearedId);
  const blocked = useLog((s) => s.blocked);
  const clearedAt = useLog((s) => s.clearedAt);
  const loaded = useLog((s) => s.loaded);
  const error = useLog((s) => s.error);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const q = useDeferredValue(text.trim().toLowerCase());
  const isBlocked = filter === "blocked";

  usePoll(fetchLog, 2000, []);
  // The sidebar counts them too, so they're fetched now and then even while showing events.
  usePoll(fetchBlocked, isBlocked ? 3000 : 10000, [isBlocked]);
  useEffect(() => {
    markLogSeen();
    return markLogSeen;
  }, []);
  useEvent("ui.focusFilter", () => {
    search.current?.focus();
    search.current?.select();
  });

  const events = useMemo(() => {
    const all = visibleEntries(entries, clearedId);
    const byLevel = filter === "warning" || filter === "error" ? all.filter((e) => e.level === filter) : all;
    return q ? byLevel.filter((e) => e.msg.toLowerCase().includes(q)) : byLevel;
  }, [entries, clearedId, filter, q]);

  const peers = useMemo(() => {
    const all = visibleBlocked(blocked, clearedAt);
    return q ? all.filter((b) => b.ip.toLowerCase().includes(q) || b.reason.toLowerCase().includes(q)) : all;
  }, [blocked, clearedAt, q]);

  const count = isBlocked ? peers.length : events.length;
  const follow = useFollow(list, count, `${filter}\n${q}`);

  const copyShown = () => {
    if (!count) return;
    const lines = isBlocked ? peers.map(blockedLine) : events.map(entryLine);
    void copyText(lines.join("\n"), lines.length === 1 ? "1 line" : `${lines.length.toLocaleString()} lines`);
  };

  const clear = () => {
    const undo = clearLog(isBlocked);
    toast("info", isBlocked ? "Cleared the blocked list" : "Cleared the log", {
      action: { label: "Undo", run: undo },
      ms: 5000,
    });
  };

  const onContextMenu = (e: ReactMouseEvent) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".log-row");
    const i = row ? Number(row.dataset.i) : -1;
    const selected = window.getSelection()?.toString() ?? "";
    const items: MenuEntry[] = [
      !!selected && { label: "Copy", icon: <Copy />, hint: "Ctrl+C", onSelect: () => void copyText(selected) },
      !selected && isBlocked && peers[i] && { label: "Copy IP address", icon: <Copy />, onSelect: () => void copyText(peers[i].ip, "IP address") },
      !selected && !isBlocked && events[i] && { label: "Copy this line", icon: <Copy />, onSelect: () => void copyText(entryLine(events[i]), "Line") },
      { label: "Copy everything shown", disabled: !count, onSelect: copyShown },
      { type: "separator" },
      { label: isBlocked ? "Clear the list" : "Clear the log", icon: <ListX />, disabled: !count, onSelect: clear },
    ];
    openContextMenu(e, items);
  };

  let body: ReactNode;
  if (!loaded && !isBlocked) {
    body = (
      <div className="log-center">
        <Spinner size={18} />
      </div>
    );
  } else if (error && !isBlocked && !entries.length) {
    body = (
      <Empty icon={<CircleX />} title="Couldn't load the log" actions={<Button onClick={() => void fetchLog()}>Try again</Button>}>
        {error}
      </Empty>
    );
  } else if (!count && q) {
    body = (
      <Empty
        icon={<SearchX />}
        title={`Nothing matches “${text.trim()}”`}
        actions={<Button onClick={() => useLog.setState({ text: "" })}>Clear the filter</Button>}
      />
    );
  } else if (!count) {
    const empty = emptyState(filter);
    body = (
      <Empty icon={empty.icon} title={empty.title}>
        {empty.text}
      </Empty>
    );
  } else {
    body = (
      <div className="log-list" ref={list} onScroll={follow.onScroll} onContextMenu={onContextMenu} role="log" aria-label={TITLES[filter]}>
        {isBlocked
          ? peers.map((p, i) => <BlockedRow key={`${p.time}-${p.ip}-${i}`} peer={p} index={i} q={q} />)
          : events.map((e, i) => <EventRow key={e.id} entry={e} index={i} q={q} />)}
      </div>
    );
  }

  return (
    <div className="logview">
      <header className="toolbar">
        <IconButton className="nav-toggle" label="Menu" onClick={() => useStore.setState((s) => ({ navOpen: !s.navOpen }))}>
          <MenuIcon />
        </IconButton>
        <div className="toolbar-title">
          <h1>{TITLES[filter]}</h1>
          {count > 0 && <span className="badge">{count.toLocaleString()}</span>}
        </div>
        <div className="spacer" />
        <SearchInput
          ref={search}
          value={text}
          onChange={(v) => useLog.setState({ text: v })}
          placeholder={isBlocked ? "Filter IPs" : "Filter the log"}
          hint="Ctrl+F"
          aria-label={isBlocked ? "Filter IPs" : "Filter the log"}
        />
        <IconButton label="Copy everything shown" onClick={copyShown} disabled={!count}>
          <Copy />
        </IconButton>
        <IconButton label={isBlocked ? "Clear the list" : "Clear the log"} onClick={clear} disabled={!count}>
          <ListX />
        </IconButton>
      </header>
      <div className="log-body">
        {body}
        {follow.away && count > 0 && (
          <button type="button" className="log-jump" onClick={follow.toEnd}>
            <ArrowDown />
            {follow.fresh ? plural(follow.fresh, isBlocked ? "new connection" : "new line") : "Latest"}
          </button>
        )}
      </div>
    </div>
  );
}

function LogNav() {
  const filter = useLog((s) => s.filter);
  const counts = useLogCounts();
  const item = (key: LogFilter, icon: ReactNode, label: string) => (
    <button
      type="button"
      className={`nav-item sm${filter === key ? " on" : ""}`}
      aria-current={filter === key ? "true" : undefined}
      onClick={() => {
        setLogFilter(key);
        useStore.setState({ navOpen: false });
      }}
    >
      {icon}
      <span className="nav-label">{label}</span>
      <span className="nav-count">{counts[key].toLocaleString()}</span>
    </button>
  );
  return (
    <>
      <div className="side-section">
        <div className="side-head">
          <span className="side-label">Events</span>
        </div>
        <div className="nav">
          {item("all", <ScrollText />, "Everything")}
          {item("warning", <TriangleAlert className="ic-warn" />, "Warnings")}
          {item("error", <CircleX className="ic-error" />, "Errors")}
        </div>
      </div>
      <div className="side-section">
        <div className="side-head">
          <span className="side-label">Peers</span>
        </div>
        <div className="nav">{item("blocked", <ShieldBan />, "Blocked IPs")}</div>
      </div>
    </>
  );
}

registerSidebarSection("log", () => <LogNav />);
