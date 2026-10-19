// Adding torrents: from files, links, the clipboard and drag & drop.

import { api } from "../api/client";
import type { AddResult } from "../api/types";
import { queueAdd, toast, toastError, useStore } from "../store/store";
import { plural } from "./format";

function useDialog(): boolean {
  return useStore.getState().prefs?.downloads?.showAddDialog !== false;
}

function shortSource(s: string): string {
  if (/^magnet:/i.test(s)) {
    const dn = /[?&]dn=([^&]+)/i.exec(s);
    if (dn) {
      try {
        return decodeURIComponent(dn[1].replace(/\+/g, " "));
      } catch {
        return dn[1];
      }
    }
    return "magnet link";
  }
  const name = s.split(/[\\/]/).pop() || s;
  return name.length > 60 ? `${name.slice(0, 57)}…` : name;
}

/** Toasts for the outcome of a direct add. */
export function reportAdd(res: AddResult, { quiet = false } = {}): void {
  if (!quiet && res.added.length) {
    toast("success", res.added.length === 1 ? "Torrent added" : `Added ${plural(res.added.length, "torrent")}`, { ms: 2500 });
  }
  for (const d of res.duplicates) toast("info", d.error, { title: "Already added" });
  for (const e of res.errors) toast("error", e.error, { title: `Couldn't add ${shortSource(e.source)}` });
}

/** Pull magnet links, URLs and info hashes out of free text. */
export function extractSources(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const raw of line.trim().split(/\s+(?=magnet:|https?:\/\/)/i)) {
      const s = raw.trim().replace(/^<|>$/g, "");
      if (!s) continue;
      if (
        /^magnet:\?/i.test(s) ||
        /^https?:\/\/\S+$/i.test(s) ||
        /^[0-9a-f]{40}$/i.test(s) ||
        /^[0-9a-f]{64}$/i.test(s) ||
        /^[a-z2-7]{32}$/i.test(s)
      ) {
        out.push(s);
      }
    }
  }
  return [...new Set(out)];
}

/** Add magnet links / URLs / hashes (or local paths in the desktop app). */
export async function addSources(sources: string[]): Promise<void> {
  if (!sources.length) return;
  if (useDialog()) {
    const results = await Promise.allSettled(sources.map((s) => api.inspectText(s)));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") queueAdd(r.value);
      else toastError(r.reason, `Couldn't open ${shortSource(sources[i])}`);
    });
    return;
  }
  try {
    reportAdd(await api.addSources(sources));
  } catch (e) {
    toastError(e, "Couldn't add torrents");
  }
}

export function isTorrentFile(f: File): boolean {
  return /\.torrent$/i.test(f.name) || f.type === "application/x-bittorrent";
}

export async function addFiles(files: File[]): Promise<void> {
  const torrents = files.filter(isTorrentFile);
  if (!torrents.length) {
    toast("warning", "Only .torrent files can be added this way");
    return;
  }
  if (useDialog()) {
    for (const f of torrents) {
      try {
        queueAdd(await api.inspectFile(f, f.name));
      } catch (e) {
        toastError(e, `Couldn't read ${f.name}`);
      }
    }
    return;
  }
  try {
    reportAdd(await api.addFiles(torrents));
  } catch (e) {
    toastError(e, "Couldn't add torrents");
  }
}

/** "Add torrent…": the native file dialog in the desktop app, a file input elsewhere. */
export async function pickTorrentFiles(): Promise<void> {
  const app = useStore.getState().app;
  if (app?.desktop) {
    let paths: string[] = [];
    try {
      paths = await api.dialog({
        kind: "open",
        title: "Add torrent files",
        multiple: true,
        fileTypes: ["Torrent files (*.torrent)", "All files (*.*)"],
      });
    } catch (e) {
      toastError(e);
      return;
    }
    if (paths.length) await addSources(paths);
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".torrent,application/x-bittorrent";
  input.multiple = true;
  input.onchange = () => {
    const files = [...(input.files ?? [])];
    if (files.length) void addFiles(files);
  };
  input.click();
}
