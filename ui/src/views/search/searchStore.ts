// Torrent search: the searches on the backend, their results, and the plugins that run them.
// Results stream in through "search.results" events; whatever this page missed (it wasn't
// open, or the socket dropped) is fetched by offset.

import { create } from "zustand";
import { ApiError, api } from "../../api/client";
import type { SearchError, SearchPlugin, SearchResult, SearchStatus } from "../../api/types";
import { on } from "../../lib/events";
import { queueAdd, toast, toastError, useStore } from "../../store/store";

export interface SearchTab {
  id: string;
  query: string;
  category: string;
  status: SearchStatus;
  /** How many results the backend has. */
  total: number;
  /** The ones this page has, in the order they arrived: always a prefix of the backend's. */
  results: SearchResult[];
  errors: SearchError[];
  plugins: string[];
}

export type SortKey = "name" | "size" | "seeds" | "leechers" | "site" | "pubDate";

export interface ResultSort {
  key: SortKey;
  dir: 1 | -1;
}

export interface ResultFilter {
  text: string;
  /** null = every site */
  site: string | null;
  /** 0 = any */
  minSeeds: number;
  /** Bytes; 0 = no limit. */
  minSize: number;
  maxSize: number;
}

export const NO_FILTER: ResultFilter = { text: "", site: null, minSeeds: 0, minSize: 0, maxSize: 0 };

interface SearchState {
  tabs: Record<string, SearchTab>;
  /** Newest first. */
  order: string[];
  active: string | null;
  /** The backend's list has been fetched at least once. */
  listed: boolean;
  plugins: SearchPlugin[];
  categories: Record<string, string>;
  pluginsLoaded: boolean;
  pluginsError: string;
  // the search box
  query: string;
  category: string;
  /** "enabled", "all" or one plugin's name. */
  source: string;
  starting: boolean;
  formError: string;
  // the results
  filter: ResultFilter;
  sort: ResultSort | null;
  /** Links being fetched for the transfer list. */
  fetching: Record<string, true>;
  /** Torrent ids of results fetched from here, by link (to tell which are in the list). */
  resolved: Record<string, string>;
}

const PREFS_KEY = "promethea.search.v1";

function loadPrefs(): Pick<SearchState, "category" | "source" | "sort"> {
  const fallback = { category: "all", source: "enabled", sort: { key: "seeds", dir: -1 } as ResultSort };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null");
    if (!saved || typeof saved !== "object") return fallback;
    return {
      category: typeof saved.category === "string" ? saved.category : fallback.category,
      source: typeof saved.source === "string" ? saved.source : fallback.source,
      sort: saved.sort === null || (saved.sort && typeof saved.sort.key === "string") ? saved.sort : fallback.sort,
    };
  } catch {
    return fallback;
  }
}

export const useSearch = create<SearchState>()(() => ({
  tabs: {},
  order: [],
  active: null,
  listed: false,
  plugins: [],
  categories: { all: "All categories" },
  pluginsLoaded: false,
  pluginsError: "",
  query: "",
  starting: false,
  formError: "",
  filter: NO_FILTER,
  fetching: {},
  resolved: {},
  ...loadPrefs(),
}));

useSearch.subscribe((s, prev) => {
  if (s.category === prev.category && s.source === prev.source && s.sort === prev.sort) return;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ category: s.category, source: s.source, sort: s.sort }));
  } catch {
    /* storage unavailable: the choices just aren't remembered */
  }
});

const set = useSearch.setState;
const get = useSearch.getState;

function patchTab(id: string, patch: Partial<SearchTab>): void {
  set((s) => (s.tabs[id] ? { tabs: { ...s.tabs, [id]: { ...s.tabs[id], ...patch } } } : s));
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ------------------------------------------------------------------ plugins
export async function loadPlugins(): Promise<void> {
  try {
    const { plugins, categories } = await api.searchPlugins();
    set((s) => ({
      plugins,
      categories,
      pluginsLoaded: true,
      pluginsError: "",
      // The plugin picked to search with is gone: back to all the enabled ones.
      source: s.source === "enabled" || s.source === "all" || plugins.some((p) => p.name === s.source) ? s.source : "enabled",
    }));
  } catch (e) {
    set({ pluginsLoaded: true, pluginsError: message(e) });
  }
}

export async function setPluginEnabled(name: string, enabled: boolean): Promise<void> {
  set((s) => ({ plugins: s.plugins.map((p) => (p.name === name ? { ...p, enabled } : p)) }));
  try {
    await api.enablePlugin(name, enabled);
  } catch (e) {
    toastError(e, "Couldn't change the plugin");
    void loadPlugins();
  }
}

/** Categories the chosen plugins can search in. */
export function categoryOptions(s: Pick<SearchState, "categories" | "plugins" | "source">): { value: string; label: string }[] {
  const plugin = s.plugins.find((p) => p.name === s.source);
  return Object.entries(s.categories)
    .filter(([key]) => key === "all" || !plugin || plugin.categories.includes(key))
    .map(([value, label]) => ({ value, label }));
}

// ------------------------------------------------------------------ searches
export async function listSearches(): Promise<void> {
  let list;
  try {
    list = await api.searches();
  } catch {
    return; // keep what's shown; the next visit or event tries again
  }
  set((s) => {
    const tabs: Record<string, SearchTab> = {};
    for (const item of list) {
      const old = s.tabs[item.id];
      tabs[item.id] = old
        ? { ...old, status: item.status, total: Math.max(old.total, item.total) }
        : { ...item, results: [], errors: [], plugins: [] };
    }
    // The backend lists the oldest first.
    const order = list.map((item) => item.id).reverse();
    const active = s.active && tabs[s.active] ? s.active : order[0] ?? null;
    return { tabs, order, active, listed: true };
  });
  const { active, tabs } = get();
  if (active && tabs[active].results.length < Math.max(1, tabs[active].total)) void fetchMissing(active);
}

const inflight = new Set<string>();
const again = new Set<string>();

/** Fetch the results (and the errors, status) this page doesn't have yet. */
export async function fetchMissing(id: string): Promise<void> {
  if (inflight.has(id)) {
    again.add(id);
    return;
  }
  const tab = get().tabs[id];
  if (!tab) return;
  inflight.add(id);
  const offset = tab.results.length;
  try {
    const d = await api.getSearch(id, offset);
    const cur = get().tabs[id];
    if (!cur) return;
    // Events may have brought some of these meanwhile; the list only ever grows at the end.
    const fresh = d.results.slice(Math.max(0, cur.results.length - offset));
    patchTab(id, {
      results: fresh.length ? cur.results.concat(fresh) : cur.results,
      total: d.total,
      status: d.status,
      errors: d.errors,
      plugins: d.plugins,
    });
  } catch (e) {
    // Gone (Promethea restarted, or another window closed it).
    if (e instanceof ApiError && e.status === 404) dropTab(id);
  } finally {
    inflight.delete(id);
    if (again.delete(id)) void fetchMissing(id);
  }
}

function dropTab(id: string): void {
  set((s) => {
    if (!s.tabs[id]) return s;
    const tabs = { ...s.tabs };
    delete tabs[id];
    const i = s.order.indexOf(id);
    const order = s.order.filter((x) => x !== id);
    const active = s.active === id ? order[Math.min(i, order.length - 1)] ?? null : s.active;
    return { tabs, order, active };
  });
}

export function setResultFilter(patch: Partial<ResultFilter>): void {
  set((s) => ({ filter: { ...s.filter, ...patch } }));
}

/** Click on a column: flip the direction, or sort by it (text A→Z, numbers high to low first). */
export function setResultSort(key: SortKey): void {
  set((s) => ({
    sort: s.sort?.key === key ? { key, dir: s.sort.dir === 1 ? -1 : 1 } : { key, dir: key === "name" || key === "site" ? 1 : -1 },
  }));
}

export function selectSearch(id: string): void {
  const tab = get().tabs[id];
  if (!tab) return;
  set({ active: id, filter: { ...get().filter, site: null } });
  if (tab.results.length < tab.total || !tab.plugins.length) void fetchMissing(id);
}

/** `replace`: a past search this one takes over from (it's closed once the new one starts). */
async function runSearch(query: string, category: string, plugins: string[] | null, replace?: string): Promise<void> {
  if (get().starting) return;
  set({ starting: true, formError: "" });
  try {
    const { id } = await api.startSearch(query, category, plugins);
    const tab: SearchTab = { id, query, category, status: "running", total: 0, results: [], errors: [], plugins: [] };
    set((st) => ({
      tabs: { ...st.tabs, [id]: st.tabs[id] ?? tab },
      order: [id, ...st.order.filter((x) => x !== id)],
      active: id,
      starting: false,
      filter: NO_FILTER,
    }));
    if (replace && replace !== id) closeSearch(replace);
    void fetchMissing(id); // which plugins it runs, and anything they found already
  } catch (e) {
    set({ starting: false });
    toastError(e, "Couldn't search");
  }
}

/** Search for what's in the search box. */
export function startSearch(): void {
  const s = get();
  const query = s.query.replace(/\s+/g, " ").trim();
  if (!query) {
    set({ formError: "Type what to search for" });
    return;
  }
  void runSearch(query, s.category, s.source === "enabled" ? null : s.source === "all" ? ["all"] : [s.source]);
}

/** Run a past search again (the same words, category and sites), in its place. */
export function repeatSearch(id: string): void {
  const tab = get().tabs[id];
  if (!tab) return;
  set({ query: tab.query });
  void runSearch(tab.query, tab.category, tab.plugins.length ? tab.plugins : null, id);
}

export async function stopSearch(id: string): Promise<void> {
  try {
    await api.stopSearch(id);
  } catch (e) {
    toastError(e, "Couldn't stop the search");
  }
}

export function closeSearch(id: string): void {
  dropTab(id);
  api.removeSearch(id).catch(() => {
    /* already gone */
  });
}

export function closeSearches(which: "all" | "finished"): void {
  for (const id of [...get().order]) {
    const tab = get().tabs[id];
    if (which === "all" || tab.status !== "running") closeSearch(id);
  }
}

// Results arrive in batches; each says how many the search has with it.
on("search.results", (d: { id: string; results: SearchResult[]; total: number }) => {
  const tab = get().tabs[d.id];
  if (!tab) {
    // Started in another window (or just now, before the start request returned).
    if (get().listed) void listSearches();
    return;
  }
  const start = d.total - d.results.length;
  const have = tab.results.length;
  if (have < start) {
    void fetchMissing(d.id); // a batch went missing
    return;
  }
  if (have >= d.total) return;
  patchTab(d.id, { results: tab.results.concat(d.results.slice(have - start)), total: d.total });
});

on("search.status", (d: { id: string; status: SearchStatus; total: number; errors: SearchError[] }) => {
  const tab = get().tabs[d.id];
  if (!tab) {
    if (get().listed) void listSearches();
    return;
  }
  patchTab(d.id, { status: d.status, errors: d.errors, total: Math.max(tab.total, d.total) });
  if (tab.results.length < d.total) void fetchMissing(d.id);
});

on("search.plugins", () => {
  if (get().pluginsLoaded) void loadPlugins();
});

// Events were missed while the connection was down.
useStore.subscribe((s, prev) => {
  if (!s.connected || prev.connected || !get().listed) return;
  void listSearches();
  void loadPlugins();
});

// ------------------------------------------------------------------ downloading
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * The torrent id a magnet link stands for: its v1 info hash in lowercase hex, or for a
 * v2-only magnet the first 40 hex digits of the v2 hash (what Promethea uses as the id then).
 */
export function magnetHash(link: string): string | null {
  if (!/^magnet:/i.test(link)) return null;
  const v1 = /[?&]xt=urn:btih:([0-9a-z]+)/i.exec(link)?.[1];
  if (v1 && /^[0-9a-f]{40}$/i.test(v1)) return v1.toLowerCase();
  if (v1 && v1.length === 32) {
    let bits = "";
    for (const c of v1.toUpperCase()) {
      const v = BASE32.indexOf(c);
      if (v < 0) return null;
      bits += v.toString(2).padStart(5, "0");
    }
    let hex = "";
    for (let i = 0; i < 160; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
  }
  // multihash: 0x12 (sha2-256), 0x20 (32 bytes), then the hash
  const v2 = /[?&]xt=urn:btmh:1220([0-9a-f]{64})/i.exec(link)?.[1];
  return v2 ? v2.slice(0, 40).toLowerCase() : null;
}

const hashes = new WeakMap<SearchResult, string | null>();

/** The torrent a result is, when known. */
export function resultTorrentId(r: SearchResult, resolved: Record<string, string>): string | null {
  const known = resolved[r.link];
  if (known) return known;
  let h = hashes.get(r);
  if (h === undefined) {
    h = magnetHash(r.link);
    hashes.set(r, h);
  }
  return h;
}

function remember(link: string, id: string | undefined): void {
  if (id) set((s) => ({ resolved: { ...s.resolved, [link]: id } }));
}

export function wantsDialog(): boolean {
  return useStore.getState().prefs?.downloads?.showAddDialog !== false;
}

async function downloadOne(r: SearchResult, dialog: boolean): Promise<void> {
  if (get().fetching[r.link]) return;
  set((s) => ({ fetching: { ...s.fetching, [r.link]: true } }));
  try {
    if (dialog) {
      const info = await api.searchInspect(r.plugin, r.link);
      remember(r.link, info.id);
      queueAdd(info);
    } else {
      const { id } = await api.searchAdd(r.plugin, r.link);
      remember(r.link, id);
      toast("success", r.name, { title: "Torrent added", ms: 2500 });
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      remember(r.link, (e.data as { id?: string } | null)?.id);
      toast("info", e.message, { title: "Already added" });
    } else {
      toastError(e, `Couldn't get “${r.name}”`);
    }
  } finally {
    set((s) => {
      const fetching = { ...s.fetching };
      delete fetching[r.link];
      return { fetching };
    });
  }
}

/** Add results to the transfer list (through the add dialog when that's the preference). */
export function downloadResults(results: SearchResult[], opts: { dialog?: boolean } = {}): void {
  const dialog = opts.dialog ?? wantsDialog();
  for (const r of results) void downloadOne(r, dialog);
}
