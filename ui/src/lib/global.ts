// App-wide wiring: backend events, paste & drop to add, keyboard shortcuts, window title.

import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { CreatorJob } from "../api/types";
import { openDialog, queueAdd, setView, toast, updatePendingAdd, useStore } from "../store/store";
import type { ToastKind } from "../store/store";
import { quitApp } from "./actions";
import { addFiles, addSources, extractSources, isTorrentFile, pickTorrentFiles } from "./add";
import { emit } from "./events";
import { formatSpeed } from "./format";
import { useEvent } from "./hooks";
import { baseName } from "./paths";

function behavior(): Record<string, any> {
  return useStore.getState().prefs?.behavior ?? {};
}

function modalOpen(): boolean {
  return !!document.querySelector(".modal-scrim");
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/** Toasts and add-dialog requests pushed by the backend. */
export function useBackendEvents(): void {
  useEvent("metadata", (d: { token: string; info: Record<string, unknown> }) => updatePendingAdd(d.token, d.info));
  useEvent("addDialog", (info) => queueAdd(info));
  useEvent("toast", (d: { kind?: ToastKind; message: string }) => toast(d.kind ?? "info", d.message));
  useEvent("torrent.finished", (d: { name: string }) => {
    if (behavior().notifyOnComplete !== false) toast("success", d.name, { title: "Download complete" });
  });
  useEvent("torrent.error", (d: { name: string; message: string }) => {
    if (behavior().notifyOnError !== false) toast("error", d.message, { title: d.name });
  });
  // The desktop window's close button or tray menu, when torrents are transferring: ask here.
  useEvent("app.quit", () => quitApp());
  // A torrent being created after its dialog was closed (the open dialog says so itself).
  useEvent("creator", (job: CreatorJob) => {
    if (job.status !== "done" && job.status !== "error") return;
    const st = useStore.getState();
    if (st.dialogs.some((d) => d.spec.type === "creator")) return;
    const name = baseName(job.output);
    if (job.status === "error") {
      toast("error", job.error.charAt(0).toUpperCase() + job.error.slice(1), { title: `Couldn't create ${name}` });
      return;
    }
    toast("success", name, {
      title: "Torrent created",
      action: st.app?.desktop ? { label: "Show in folder", run: () => void api.revealCreated(job.id).catch(() => {}) } : undefined,
    });
  });
}

/** Ctrl+V anywhere outside a text field adds the magnet links / URLs / .torrent files on the clipboard. */
export function useGlobalPaste(): void {
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isEditable(e.target) || modalOpen() || !e.clipboardData) return;
      const files = [...e.clipboardData.files].filter(isTorrentFile);
      if (files.length) {
        e.preventDefault();
        void addFiles(files);
        return;
      }
      const sources = extractSources(e.clipboardData.getData("text/plain"));
      if (sources.length) {
        e.preventDefault();
        void addSources(sources);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);
}

/** Drag .torrent files or links onto the window. Returns whether a drag is hovering. */
export function useDropTarget(): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    let depth = 0;
    let internal = false;
    const accepts = (e: DragEvent) => {
      if (internal) return false;
      const types = [...(e.dataTransfer?.types ?? [])];
      return types.includes("Files") || types.includes("text/uri-list") || types.includes("text/plain");
    };
    const onStart = () => {
      internal = true;
    };
    const onEnd = () => {
      internal = false;
    };
    const onEnter = (e: DragEvent) => {
      if (!accepts(e)) return;
      e.preventDefault();
      depth++;
      setActive(true);
    };
    const onOver = (e: DragEvent) => {
      if (!accepts(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!accepts(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setActive(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!accepts(e)) return;
      e.preventDefault();
      depth = 0;
      setActive(false);
      const dt = e.dataTransfer;
      if (!dt) return;
      const files = [...dt.files];
      if (files.length) {
        void addFiles(files);
        return;
      }
      const text = (dt.getData("text/uri-list") || dt.getData("text/plain"))
        .split(/\r?\n/)
        .filter((l) => !l.startsWith("#"))
        .join("\n");
      const sources = extractSources(text);
      if (sources.length) void addSources(sources);
      else toast("warning", "Drop .torrent files or magnet links to add them");
    };
    window.addEventListener("dragstart", onStart);
    window.addEventListener("dragend", onEnd);
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragstart", onStart);
      window.removeEventListener("dragend", onEnd);
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);
  return active;
}

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const st = useStore.getState();
      if (e.key === "Escape" && st.navOpen) {
        useStore.setState({ navOpen: false });
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl || e.altKey || modalOpen()) return;
      const key = e.key.toLowerCase();
      if (key === "o" && !e.shiftKey) {
        e.preventDefault();
        void pickTorrentFiles();
      } else if (key === "u" && !e.shiftKey) {
        e.preventDefault();
        openDialog({ type: "addLinks" });
      } else if (key === "n" && !e.shiftKey) {
        e.preventDefault();
        if (st.app?.local) openDialog({ type: "creator" });
      } else if (key === "f" && !e.shiftKey) {
        e.preventDefault();
        if (!["transfers", "search", "rss", "log", "settings"].includes(st.view)) setView("transfers");
        emit("ui.focusFilter", null);
      } else if (key === ",") {
        e.preventDefault();
        setView("settings");
      } else if (key === "p" || key === "r" || key === "s") {
        // Keep the embedded browser from printing, reloading or saving the page.
        if (st.app?.desktop) e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** "[D: 3.2 MiB/s, U: 120 KiB/s] Promethea" like qBittorrent, when enabled. */
export function useWindowTitle(): void {
  const enabled = useStore((s) => s.prefs?.behavior?.speedInTitle !== false);
  const dl = useStore((s) => s.server?.dlSpeed ?? 0);
  const ul = useStore((s) => s.server?.upSpeed ?? 0);
  useEffect(() => {
    document.title =
      enabled && (dl > 0 || ul > 0)
        ? `[D: ${formatSpeed(dl, "0 B/s")}, U: ${formatSpeed(ul, "0 B/s")}] Promethea`
        : "Promethea";
  }, [enabled, dl, ul]);
}
