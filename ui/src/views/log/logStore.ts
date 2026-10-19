// The execution log and the blocked connections, kept across visits to the Log view.

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { api } from "../../api/client";
import type { BlockedPeer, LogEntry } from "../../api/types";
import { on } from "../../lib/events";
import { useStore } from "../../store/store";

export type LogFilter = "all" | "warning" | "error" | "blocked";

interface LogState {
  entries: LogEntry[];
  lastId: number;
  /** "Clear" hides what's there so far, here only: entries up to this id... */
  clearedId: number;
  blocked: BlockedPeer[];
  /** ...and blocked connections up to this time. */
  clearedAt: number;
  filter: LogFilter;
  text: string;
  /** Warnings and errors logged while the Log view wasn't open. */
  unseen: number;
  unseenErrors: number;
  loaded: boolean;
  error: string;
}

/** The backend keeps as many. */
const MAX_ENTRIES = 3000;

export const useLog = create<LogState>()(() => ({
  entries: [],
  lastId: 0,
  clearedId: 0,
  blocked: [],
  clearedAt: 0,
  filter: "all",
  text: "",
  unseen: 0,
  unseenErrors: 0,
  loaded: false,
  error: "",
}));

// The backend pushes warnings and errors as they happen; count the ones nobody has looked at.
on("log", (item: LogEntry) => {
  if (useStore.getState().view === "log") return;
  useLog.setState((s) => ({ unseen: s.unseen + 1, unseenErrors: s.unseenErrors + (item.level === "error" ? 1 : 0) }));
});

export async function fetchLog(): Promise<void> {
  try {
    const items = await api.log(useLog.getState().lastId);
    useLog.setState((s) => {
      if (!items.length) return s.loaded && !s.error ? s : { loaded: true, error: "" };
      // Promethea restarted since the last look: its ids started over and this is its whole log.
      const restarted = items[0].id <= s.lastId;
      const entries = restarted ? items : s.entries.concat(items);
      return {
        entries: entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries,
        lastId: items[items.length - 1].id,
        clearedId: restarted ? 0 : s.clearedId,
        loaded: true,
        error: "",
      };
    });
  } catch (e) {
    useLog.setState({ error: e instanceof Error ? e.message : String(e), loaded: true });
  }
}

function blockedSignature(list: BlockedPeer[]): string {
  let hits = 0;
  for (const b of list) hits += b.count;
  return `${list.length}:${list[list.length - 1]?.time ?? 0}:${hits}`;
}

export async function fetchBlocked(): Promise<void> {
  const blocked = await api.blocked();
  useLog.setState((s) =>
    // Nothing new (the usual case): keep the same array so nothing re-renders.
    blockedSignature(s.blocked) === blockedSignature(blocked) ? s : { blocked },
  );
}

export function setLogFilter(filter: LogFilter): void {
  useLog.setState({ filter });
}

export function markLogSeen(): void {
  if (useLog.getState().unseen) useLog.setState({ unseen: 0, unseenErrors: 0 });
}

/** Hide everything shown so far (in this view only). Returns how to undo it. */
export function clearLog(blocked: boolean): () => void {
  const s = useLog.getState();
  if (blocked) {
    const prev = s.clearedAt;
    useLog.setState({ clearedAt: s.blocked.length ? s.blocked[s.blocked.length - 1].time : Date.now() / 1000 });
    return () => useLog.setState({ clearedAt: prev });
  }
  const prev = s.clearedId;
  useLog.setState({ clearedId: s.lastId });
  return () => useLog.setState({ clearedId: prev });
}

/** What "Clear" left. Ids and times only grow, so the hidden part is a prefix. */
export function visibleEntries(entries: LogEntry[], clearedId: number): LogEntry[] {
  let i = 0;
  while (i < entries.length && entries[i].id <= clearedId) i++;
  return i ? entries.slice(i) : entries;
}

export function visibleBlocked(blocked: BlockedPeer[], clearedAt: number): BlockedPeer[] {
  let i = 0;
  while (i < blocked.length && blocked[i].time <= clearedAt) i++;
  return i ? blocked.slice(i) : blocked;
}

export function useLogCounts(): Record<LogFilter, number> {
  return useLog(
    useShallow((s) => {
      let all = 0;
      let warning = 0;
      let error = 0;
      for (const e of s.entries) {
        if (e.id <= s.clearedId) continue;
        all++;
        if (e.level === "warning") warning++;
        else if (e.level === "error") error++;
      }
      return { all, warning, error, blocked: visibleBlocked(s.blocked, s.clearedAt).length };
    }),
  );
}
