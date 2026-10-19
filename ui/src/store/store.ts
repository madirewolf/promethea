import { create } from "zustand";
import type {
  AppInfo,
  AuthState,
  Categories,
  HistoryPoint,
  InspectInfo,
  Prefs,
  ServerState,
  SocketMessage,
  Torrent,
} from "../api/types";
import { emit } from "../lib/events";
import { LAYOUTS, readLayout } from "../lib/layout";
import type { DetailsTab, Layout } from "../lib/layout";
import type { StatusFilter } from "../lib/states";

export type { DetailsTab } from "../lib/layout";

export type View = "transfers" | "search" | "rss" | "settings" | "log";

export interface Filter {
  status: StatusFilter;
  /** null = any category, "" = uncategorized */
  category: string | null;
  /** null = any tag, "" = untagged */
  tag: string | null;
  /** null = any tracker, "" = no tracker */
  tracker: string | null;
  text: string;
}

export interface SortSpec {
  key: string;
  dir: 1 | -1;
}

export interface ColumnState {
  order: string[];
  hidden: string[];
  widths: Record<string, number>;
}

export interface UiState {
  view: View;
  filter: Filter;
  sort: SortSpec;
  columns: ColumnState | null;
  detailsOpen: boolean;
  detailsTab: DetailsTab;
  detailsHeight: number;
  sidebarWidth: number;
  collapsed: Record<string, boolean>;
  layout: Layout;
}

export interface DialogSpec {
  type: string;
  [key: string]: any;
}

export interface OpenDialog {
  id: number;
  spec: DialogSpec;
}

export type ToastKind = "info" | "success" | "warning" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  title?: string;
  action?: { label: string; run: () => void };
}

/** One torrent waiting in the add dialog (a dropped file, a pasted magnet, ...). */
export interface PendingAdd {
  key: number;
  info: InspectInfo;
}

interface State extends UiState {
  // sync
  connected: boolean;
  synced: boolean;
  torrents: Record<string, Torrent>;
  server: ServerState | null;
  categories: Categories;
  tags: string[];
  history: HistoryPoint[];
  // app
  auth: AuthState | null;
  app: AppInfo | null;
  prefs: Prefs | null;
  // selection
  selected: ReadonlySet<string>;
  anchor: string | null;
  focused: string | null;
  // overlays
  /** Sidebar drawer on narrow windows. */
  navOpen: boolean;
  dialogs: OpenDialog[];
  toasts: Toast[];
  addQueue: PendingAdd[];
  /** Quit from this page: nothing to reconnect to. */
  quit: boolean;
}

const UI_KEY = "promethea.ui.v1";

const defaultUi: UiState = {
  view: "transfers",
  filter: { status: "all", category: null, tag: null, tracker: null, text: "" },
  sort: { key: "addedOn", dir: -1 },
  columns: null,
  detailsOpen: true,
  detailsTab: "general",
  detailsHeight: 300,
  sidebarWidth: 232,
  collapsed: {},
  layout: LAYOUTS.simple,
};

/** A filter on something the layout hides would narrow the list with nothing on screen saying so.
 * (Errored is the exception: it shows itself whenever it's picked or something has failed.) */
function fitFilter(f: Filter, l: Layout): Filter {
  return {
    ...f,
    status: f.status === "all" || f.status === "errored" || l.status.includes(f.status) ? f.status : "all",
    category: l.sections.includes("categories") ? f.category : null,
    tag: l.sections.includes("tags") ? f.tag : null,
    tracker: l.sections.includes("trackers") ? f.tracker : null,
  };
}

function loadUi(): UiState {
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (!raw) return defaultUi;
    const saved = JSON.parse(raw) as Partial<UiState>;
    const layout = readLayout(saved.layout);
    const tab = saved.detailsTab ?? defaultUi.detailsTab;
    return {
      ...defaultUi,
      ...saved,
      layout,
      filter: fitFilter({ ...defaultUi.filter, ...(saved.filter ?? {}), text: "" }, layout),
      detailsTab: layout.tabs.includes(tab) ? tab : layout.tabs[0],
      view: saved.view === "settings" ? "transfers" : saved.view ?? "transfers",
    };
  } catch {
    return defaultUi;
  }
}

export const useStore = create<State>()(() => ({
  ...loadUi(),
  connected: false,
  synced: false,
  torrents: {},
  server: null,
  categories: {},
  tags: [],
  history: [],
  auth: null,
  app: null,
  prefs: null,
  selected: new Set<string>(),
  anchor: null,
  focused: null,
  navOpen: false,
  dialogs: [],
  toasts: [],
  addQueue: [],
  quit: false,
}));

// Persist the UI layout (per browser) whenever it changes.
let saveTimer = 0;
useStore.subscribe((s, prev) => {
  if (
    s.view === prev.view &&
    s.filter === prev.filter &&
    s.sort === prev.sort &&
    s.columns === prev.columns &&
    s.detailsOpen === prev.detailsOpen &&
    s.detailsTab === prev.detailsTab &&
    s.detailsHeight === prev.detailsHeight &&
    s.sidebarWidth === prev.sidebarWidth &&
    s.collapsed === prev.collapsed &&
    s.layout === prev.layout
  )
    return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const { view, filter, sort, columns, detailsOpen, detailsTab, detailsHeight, sidebarWidth, collapsed, layout } =
      useStore.getState();
    try {
      localStorage.setItem(
        UI_KEY,
        JSON.stringify({ view, filter, sort, columns, detailsOpen, detailsTab, detailsHeight, sidebarWidth, collapsed, layout }),
      );
    } catch {
      /* storage unavailable (private mode): layout just isn't remembered */
    }
  }, 300);
});

const set = useStore.setState;
const get = useStore.getState;

function historyLimit(): number {
  const minutes = get().prefs?.advanced?.speedHistoryMinutes ?? 30;
  return Math.max(60, minutes * 60);
}

// ------------------------------------------------------------------ sync
export function applyMessage(msg: SocketMessage): void {
  if (msg.t === "full") {
    const limit = historyLimit();
    set((s) => ({
      synced: true,
      torrents: msg.torrents,
      server: msg.server,
      categories: msg.categories,
      tags: msg.tags,
      history: msg.history.slice(-limit),
      ...pruneSelection(s, msg.torrents),
    }));
    return;
  }
  if (msg.t === "delta") {
    set((s) => {
      const patch: Partial<State> = {};
      if (msg.torrents || msg.removed) {
        const next = { ...s.torrents };
        if (msg.torrents) {
          for (const id in msg.torrents) next[id] = { ...next[id], ...msg.torrents[id] } as Torrent;
        }
        if (msg.removed?.length) {
          for (const id of msg.removed) delete next[id];
          Object.assign(patch, pruneSelection(s, next));
        }
        patch.torrents = next;
      }
      if (msg.server) patch.server = { ...(s.server as ServerState), ...msg.server };
      if (msg.categories) patch.categories = msg.categories;
      if (msg.tags) patch.tags = msg.tags;
      if (msg.hist) {
        const limit = historyLimit();
        const h = s.history.length >= limit ? s.history.slice(s.history.length - limit + 1) : s.history.slice();
        h.push(msg.hist);
        patch.history = h;
      }
      return patch;
    });
    return;
  }
  if (msg.t === "event") {
    if (msg.name === "prefs") set({ prefs: msg.data });
    emit(msg.name, msg.data);
  }
}

function pruneSelection(s: State, torrents: Record<string, Torrent>): Partial<State> {
  let changed = false;
  const sel = new Set<string>();
  for (const id of s.selected) {
    if (torrents[id]) sel.add(id);
    else changed = true;
  }
  const out: Partial<State> = {};
  if (changed) out.selected = sel;
  if (s.focused && !torrents[s.focused]) out.focused = sel.size ? [...sel][sel.size - 1] : null;
  if (s.anchor && !torrents[s.anchor]) out.anchor = null;
  return out;
}

// ------------------------------------------------------------------ selection
/** Row order currently shown in the transfer list (used for shift-click ranges). */
let visibleOrder: string[] = [];
export function setVisibleOrder(ids: string[]): void {
  visibleOrder = ids;
}
export function getVisibleOrder(): string[] {
  return visibleOrder;
}

export function selectOnly(id: string | null): void {
  set({ selected: new Set(id ? [id] : []), anchor: id, focused: id });
}

export function toggleSelect(id: string): void {
  const sel = new Set(get().selected);
  if (sel.has(id)) sel.delete(id);
  else sel.add(id);
  set({ selected: sel, anchor: id, focused: sel.has(id) ? id : sel.size ? [...sel][sel.size - 1] : null });
}

export function selectRange(id: string, additive = false): void {
  const { anchor, selected } = get();
  const order = visibleOrder;
  const a = anchor ? order.indexOf(anchor) : -1;
  const b = order.indexOf(id);
  if (a < 0 || b < 0) {
    selectOnly(id);
    return;
  }
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const sel = new Set(additive ? selected : []);
  for (let i = lo; i <= hi; i++) sel.add(order[i]);
  set({ selected: sel, focused: id });
}

export function selectAll(): void {
  const order = visibleOrder;
  set({ selected: new Set(order), focused: get().focused ?? order[0] ?? null });
}

export function selectedIds(): string[] {
  const { selected } = get();
  // Keep the on-screen order so queue moves behave predictably.
  return visibleOrder.filter((id) => selected.has(id)).concat([...selected].filter((id) => !visibleOrder.includes(id)));
}

// ------------------------------------------------------------------ ui
export function setView(view: View): void {
  set({ view });
}

export function setFilter(patch: Partial<Filter>): void {
  set((s) => ({ filter: { ...s.filter, ...patch } }));
}

export function setSort(key: string): void {
  set((s) => ({ sort: s.sort.key === key ? { key, dir: s.sort.dir === 1 ? -1 : 1 } : { key, dir: key === "name" ? 1 : -1 } }));
}

export function toggleCollapsed(section: string): void {
  set((s) => ({ collapsed: { ...s.collapsed, [section]: !s.collapsed[section] } }));
}

export function setLayout(patch: Partial<Layout>): void {
  set((s) => {
    const layout = { ...s.layout, ...patch };
    if (!layout.tabs.length) return {};
    // Hiding what's in use: go back to all torrents, or to the first tab left.
    const tab = layout.tabs.includes(s.detailsTab) ? s.detailsTab : layout.tabs[0];
    // A section that comes back should open, not stay folded away.
    const collapsed = { ...s.collapsed };
    for (const k of layout.sections) if (!s.layout.sections.includes(k)) delete collapsed[k];
    return { layout, filter: fitFilter(s.filter, layout), detailsTab: tab, collapsed };
  });
}

// ------------------------------------------------------------------ dialogs
let dialogSeq = 0;

export function openDialog(spec: DialogSpec): number {
  const id = ++dialogSeq;
  set((s) => ({ dialogs: [...s.dialogs, { id, spec }] }));
  return id;
}

export function closeDialog(id: number): void {
  set((s) => ({ dialogs: s.dialogs.filter((d) => d.id !== id) }));
}

// ------------------------------------------------------------------ toasts
let toastSeq = 0;

export function toast(kind: ToastKind, message: string, opts: { title?: string; action?: Toast["action"]; ms?: number } = {}): void {
  const id = ++toastSeq;
  set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, message, title: opts.title, action: opts.action }] }));
  const ms = opts.ms ?? (kind === "error" ? 8000 : 4500);
  window.setTimeout(() => dismissToast(id), ms);
}

export function dismissToast(id: number): void {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

/** Toast for a failed request. */
export function toastError(e: unknown, prefix?: string): void {
  const msg = e instanceof Error ? e.message : String(e);
  toast("error", prefix ? `${prefix}: ${msg}` : msg);
}

// ------------------------------------------------------------------ add queue
let addSeq = 0;

export function queueAdd(info: InspectInfo): void {
  set((s) => ({ addQueue: [...s.addQueue, { key: ++addSeq, info }] }));
}

export function updatePendingAdd(token: string, info: Partial<InspectInfo>): void {
  set((s) => ({
    addQueue: s.addQueue.map((p) => (p.info.token === token ? { ...p, info: { ...p.info, ...info } } : p)),
  }));
}

export function shiftAdd(key: number): void {
  set((s) => ({ addQueue: s.addQueue.filter((p) => p.key !== key) }));
}
