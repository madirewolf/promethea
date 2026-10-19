import { useMemo } from "react";
import type { Torrent } from "../../api/types";
import { matchesStatus, STATUS_FILTERS } from "../../lib/states";
import type { StatusFilter } from "../../lib/states";
import { useStore } from "../../store/store";
import type { Filter, SortSpec } from "../../store/store";
import { COLUMN_MAP } from "./columns";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareText(a: string, b: string): number {
  return collator.compare(a, b);
}

function matches(t: Torrent, f: Filter, words: string[], skip?: keyof Filter): boolean {
  if (skip !== "status" && !matchesStatus(t, f.status)) return false;
  if (skip !== "category" && f.category !== null && t.category !== f.category) return false;
  if (skip !== "tag" && f.tag !== null) {
    if (f.tag === "" ? t.tags.length > 0 : !t.tags.includes(f.tag)) return false;
  }
  if (skip !== "tracker" && f.tracker !== null) {
    if (f.tracker === "" ? t.trackerHosts.length > 0 : !t.trackerHosts.includes(f.tracker)) return false;
  }
  if (words.length) {
    const name = t.name.toLowerCase();
    for (const w of words) {
      if (!name.includes(w) && !(w.length >= 8 && t.id.startsWith(w))) return false;
    }
  }
  return true;
}

function filterWords(text: string): string[] {
  return text.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function sortTorrents(list: Torrent[], sort: SortSpec): Torrent[] {
  const def = COLUMN_MAP[sort.key] ?? COLUMN_MAP.addedOn;
  const value = def.sortValue ?? ((t: Torrent) => (t as unknown as Record<string, number | string>)[def.key]);
  const keyed = list.map((t) => ({ k: value(t), t }));
  const dir = sort.dir;
  keyed.sort((a, b) => {
    let c: number;
    if (typeof a.k === "string" || typeof b.k === "string") c = collator.compare(String(a.k ?? ""), String(b.k ?? ""));
    else c = (a.k ?? 0) - (b.k ?? 0);
    if (c !== 0) return c * dir;
    return collator.compare(a.t.name, b.t.name) || (a.t.id < b.t.id ? -1 : 1);
  });
  return keyed.map((x) => x.t);
}

/** Torrents shown in the transfer list, filtered and sorted. */
export function useVisibleTorrents(): Torrent[] {
  const torrents = useStore((s) => s.torrents);
  const filter = useStore((s) => s.filter);
  const sort = useStore((s) => s.sort);
  return useMemo(() => {
    const words = filterWords(filter.text);
    const out: Torrent[] = [];
    for (const id in torrents) {
      const t = torrents[id];
      if (matches(t, filter, words)) out.push(t);
    }
    return sortTorrents(out, sort);
  }, [torrents, filter, sort]);
}

export interface SidebarCounts {
  status: Record<StatusFilter, number>;
  categories: Record<string, number>;
  uncategorized: number;
  tags: Record<string, number>;
  untagged: number;
  trackers: Record<string, number>;
  trackerless: number;
  total: number;
}

/**
 * Counts for the sidebar. Each group is counted with the *other* groups' filters applied
 * (like qBittorrent), so the numbers always say what clicking an entry would show.
 */
export function useSidebarCounts(): SidebarCounts {
  const torrents = useStore((s) => s.torrents);
  const filter = useStore((s) => s.filter);
  return useMemo(() => {
    const status = Object.fromEntries(STATUS_FILTERS.map((f) => [f.key, 0])) as Record<StatusFilter, number>;
    const c: SidebarCounts = {
      status,
      categories: {},
      uncategorized: 0,
      tags: {},
      untagged: 0,
      trackers: {},
      trackerless: 0,
      total: 0,
    };
    const words = filterWords(filter.text);
    const base: Filter = { ...filter, text: "" };
    for (const id in torrents) {
      const t = torrents[id];
      c.total++;
      if (words.length && !matches(t, { ...base, status: "all", category: null, tag: null, tracker: null }, words)) continue;
      if (matches(t, base, [], "status")) {
        for (const f of STATUS_FILTERS) if (matchesStatus(t, f.key)) status[f.key]++;
      }
      if (matches(t, base, [], "category")) {
        if (t.category) c.categories[t.category] = (c.categories[t.category] ?? 0) + 1;
        else c.uncategorized++;
      }
      if (matches(t, base, [], "tag")) {
        if (t.tags.length) for (const tag of t.tags) c.tags[tag] = (c.tags[tag] ?? 0) + 1;
        else c.untagged++;
      }
      if (matches(t, base, [], "tracker")) {
        if (t.trackerHosts.length) for (const h of t.trackerHosts) c.trackers[h] = (c.trackers[h] ?? 0) + 1;
        else c.trackerless++;
      }
    }
    return c;
  }, [torrents, filter]);
}
