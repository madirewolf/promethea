// Commands shared by the toolbar, context menus and keyboard shortcuts.

import { api } from "../api/client";
import type { TorrentAction } from "../api/client";
import { disconnect } from "../api/socket";
import type { Torrent } from "../api/types";
import { openDialog, selectedIds, toast, toastError, useStore } from "../store/store";
import { isActive, isCompleted, isStopped } from "./states";
import { plural } from "./format";

/** Run a request and turn failures into an error toast. */
export async function attempt<T>(fn: () => Promise<T>, errorPrefix?: string): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    toastError(e, errorPrefix);
    return undefined;
  }
}

export function prefs() {
  return useStore.getState().prefs ?? {};
}

export function torrent(id: string): Torrent | undefined {
  return useStore.getState().torrents[id];
}

/** Ids the toolbar acts on: the selection. */
export function targetIds(): string[] {
  return selectedIds();
}

export function act(action: TorrentAction, ids: string[], value?: boolean): void {
  if (!ids.length && action !== "startAll" && action !== "stopAll") return;
  void attempt(() => api.action(action, ids, value));
}

export const start = (ids: string[]) => act("start", ids);
export const stop = (ids: string[]) => act("stop", ids);
export const forceStart = (ids: string[]) => act("forceStart", ids);
export const reannounce = (ids: string[]) => act("reannounce", ids);

export function recheck(ids: string[]): void {
  if (!ids.length) return;
  openDialog({
    type: "confirm",
    title: ids.length === 1 ? "Recheck this torrent?" : `Recheck ${ids.length} torrents?`,
    message: "Promethea will verify every piece already on disk. Large torrents can take a while.",
    confirmLabel: "Recheck",
    onConfirm: () => act("recheck", ids),
  });
}

/** Start the stopped ones, stop the others (Space / double-click). */
export function toggle(ids: string[]): void {
  const ts = ids.map(torrent).filter(Boolean) as Torrent[];
  if (!ts.length) return;
  if (ts.every(isStopped)) start(ids);
  else stop(ids);
}

export function requestDelete(ids: string[], deleteFiles?: boolean): void {
  if (!ids.length) return;
  const behavior = prefs().behavior ?? {};
  const files = deleteFiles ?? !!behavior.deleteFilesDefault;
  if (behavior.confirmDelete === false && deleteFiles === undefined) {
    void attempt(() => api.remove(ids, files));
    return;
  }
  openDialog({ type: "delete", ids, deleteFiles: files });
}

export function setCategory(ids: string[], category: string): void {
  if (!ids.length) return;
  void attempt(() => api.set(ids, { category }));
}

export function setTags(ids: string[], tags: string[], mode: "add" | "remove" | "set"): void {
  if (!ids.length) return;
  void attempt(() => api.set(ids, { tags: { tags, mode } }));
}

export function setFlag(flag: "sequential" | "firstLast" | "superSeeding" | "autoTMM", ids: string[], value: boolean): void {
  act(flag, ids, value);
}

// ------------------------------------------------------------------ clipboard
export async function copyText(text: string, what = "Text"): Promise<void> {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // Plain-http remote UI: no async clipboard API, fall back to a hidden textarea.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
  }
  if (ok) toast("success", `${what} copied to clipboard`, { ms: 2200 });
  else toast("error", "Couldn't access the clipboard");
}

export async function copyField(ids: string[], field: "name" | "id" | "magnet" | "infohashV1" | "infohashV2" | "savePath"): Promise<void> {
  if (!ids.length) return;
  const labels = {
    name: "Name",
    id: "Torrent ID",
    magnet: "Magnet link",
    infohashV1: "Info hash",
    infohashV2: "Info hash v2",
    savePath: "Save path",
  } as const;
  let values: string[];
  if (field === "name" || field === "id" || field === "savePath") {
    values = ids.map((id) => torrent(id)?.[field] ?? "").filter(Boolean);
  } else {
    const props = await attempt(() => Promise.all(ids.map((id) => api.properties(id))));
    if (!props) return;
    values = props.map((p) => p[field]).filter(Boolean);
  }
  if (!values.length) {
    toast("info", `No ${labels[field].toLowerCase()} available`);
    return;
  }
  const what = values.length > 1 ? `${values.length} ${labels[field].toLowerCase()}s` : labels[field];
  await copyText(values.join("\n"), what);
}

// ------------------------------------------------------------------ files on disk
export async function exportTorrents(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const app = useStore.getState().app;
  if (app?.desktop) {
    const dirs = await attempt(() => api.dialog({ kind: "folder", title: "Export .torrent files to" }));
    if (!dirs?.length) return;
    const res = await attempt(() => api.exportTo(ids, dirs[0]));
    if (res) toast("success", `Exported ${plural(res.written.length, ".torrent file")}`);
    return;
  }
  for (const id of ids) {
    const a = document.createElement("a");
    a.href = api.exportUrl(id);
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

/** Open a web page in a browser tab (the default browser, from the desktop window). */
export function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  if (useStore.getState().app?.desktop) {
    void attempt(() => api.openUrl(url), "Couldn't open the link");
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function openContent(id: string): void {
  void attempt(() => api.openContent(id), "Couldn't open");
}

export function revealContent(id: string): void {
  void attempt(() => api.revealContent(id), "Couldn't open the folder");
}

/** Double-click on a row: finished torrents open their folder, others start/stop. */
export function defaultAction(id: string): void {
  const t = torrent(id);
  if (!t) return;
  const desktop = useStore.getState().app?.desktop;
  if (desktop && isCompleted(t)) revealContent(id);
  else toggle([id]);
}

// ------------------------------------------------------------------ app
/** Quit Promethea, asking first when torrents are transferring (if the settings say to) or when
 * this is another device, which can't start it again. The desktop window's close button and
 * tray menu come here too. */
export function quitApp(): void {
  const { app, torrents, dialogs } = useStore.getState();
  if (dialogs.some((d) => d.spec.quitting)) return;
  const go = () =>
    void attempt(async () => {
      await api.quit();
      disconnect();
      useStore.setState({ quit: true });
    }, "Couldn't quit");
  const busy = Object.values(torrents).filter(isActive).length;
  if (app?.local && !(busy && prefs().behavior?.confirmExitWithActive)) {
    go();
    return;
  }
  openDialog({
    type: "confirm",
    quitting: true,
    title: "Quit Promethea?",
    message: [
      busy ? `${busy === 1 ? "A torrent is" : `${busy} torrents are`} still transferring; they'll carry on next time.` : "",
      app?.local ? "" : "It can't be started again from this page.",
    ]
      .filter(Boolean)
      .join(" "),
    confirmLabel: "Quit",
    danger: !app?.local,
    onConfirm: go,
  });
}
