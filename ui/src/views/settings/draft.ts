// Settings: the unsaved changes. They stay until saved or discarded, also while other
// views are open, and the theme, accent and density preview from here.

import { create } from "zustand";
import { api } from "../../api/client";
import type { Prefs } from "../../api/types";
import { setView, toast, useStore } from "../../store/store";

export type SectionId = "general" | "downloads" | "connection" | "speed" | "bittorrent" | "rss" | "webui" | "advanced";

/** The preference section each settings section edits. */
export const PREF_SECTION: Record<SectionId, string> = {
  general: "behavior",
  downloads: "downloads",
  connection: "connection",
  speed: "speed",
  bittorrent: "bittorrent",
  rss: "rss",
  webui: "webui",
  advanced: "advanced",
};

interface DraftState {
  draft: Prefs;
  /** The section in view, for the list in the sidebar. */
  active: SectionId;
  /** Where to scroll once the settings view shows. */
  jump: SectionId | null;
  saving: boolean;
  error: string;
  /** What the settings search box holds; rows that don't match it hide. */
  query: string;
}

export const useDraft = create<DraftState>(() => ({ draft: {}, active: "general", jump: null, saving: false, error: "", query: "" }));

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? "") === JSON.stringify(b ?? "");
}

/** `draft` without the values that `keep` says to drop. */
function filterDraft(draft: Prefs, keep: (section: string, key: string, value: unknown) => boolean): Prefs {
  const out: Prefs = {};
  for (const [section, values] of Object.entries(draft)) {
    const kept = Object.entries(values).filter(([k, v]) => keep(section, k, v));
    if (kept.length) out[section] = Object.fromEntries(kept);
  }
  return out;
}

export function setPref(section: string, key: string, value: unknown): void {
  const saved = useStore.getState().prefs?.[section]?.[key];
  useDraft.setState((s) => {
    const values = { ...(s.draft[section] ?? {}) };
    if (same(value, saved)) delete values[key];
    else values[key] = value;
    const draft = { ...s.draft };
    if (Object.keys(values).length) draft[section] = values;
    else delete draft[section];
    return { draft, error: "" };
  });
}

/** A preference as shown here: the unsaved value if there is one, else the saved one, and whether it's unsaved. */
export function usePref<T>(section: string, key: string): [T, (value: T) => void, boolean] {
  const saved = useStore((s) => s.prefs?.[section]?.[key]) as T;
  const unsaved = useDraft((s) => s.draft[section]?.[key]) as T | undefined;
  const dirty = unsaved !== undefined;
  return [dirty ? (unsaved as T) : saved, (value: T) => setPref(section, key, value), dirty];
}

export function changeCount(draft: Prefs): number {
  return Object.values(draft).reduce((n, values) => n + Object.keys(values).length, 0);
}

export function discard(): void {
  useDraft.setState({ draft: {}, error: "" });
}

/** Save the unsaved changes; false when the server refused them (the error shows in the save bar). */
export async function save(): Promise<boolean> {
  // A number box being typed in commits when it loses focus.
  (document.activeElement as HTMLElement | null)?.blur?.();
  const { draft: sent, saving } = useDraft.getState();
  if (saving || !changeCount(sent)) return true;
  useDraft.setState({ saving: true, error: "" });
  try {
    const prefs = await api.setPrefs(sent);
    useStore.setState({ prefs });
    // Keep anything changed again while the request ran.
    useDraft.setState((s) => ({
      saving: false,
      draft: filterDraft(s.draft, (section, key, v) => !(section in sent && key in sent[section] && same(v, sent[section][key]))),
    }));
    if (sent.webui) {
      // Starting or moving the web UI can fail (port in use, bad certificate): the app info says why.
      api.app().then((app) => useStore.setState({ app }), () => undefined);
    }
    toast("success", "Settings saved", { ms: 2000 });
    return true;
  } catch (e) {
    useDraft.setState({ saving: false, error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/** Open the settings, scrolled to a section. */
export function openSettings(section?: SectionId): void {
  if (section) useDraft.setState({ jump: section, active: section });
  setView("settings");
}

// Settings saved elsewhere (another window, the speed dialog) can make unsaved values match again.
useStore.subscribe((s, prev) => {
  if (s.prefs === prev.prefs || !s.prefs) return;
  const prefs = s.prefs;
  const { draft } = useDraft.getState();
  const next = filterDraft(draft, (section, key, v) => !same(v, prefs[section]?.[key]));
  if (changeCount(next) !== changeCount(draft)) useDraft.setState({ draft: next });
});
