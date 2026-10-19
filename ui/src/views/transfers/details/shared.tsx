// Building blocks shared by the details tabs: polling, row selection, placeholders.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { CircleAlert } from "lucide-react";
import { Empty, Spinner } from "../../../components/ui/Misc";
import { useLatest, usePoll } from "../../../lib/hooks";
import { useStore } from "../../../store/store";

/** The UI refresh interval from the advanced settings (never faster than `min`). */
export function useRefreshMs(min = 1000): number {
  const ms = useStore((s) => s.prefs?.advanced?.uiRefreshInterval ?? 1000);
  return Math.max(min, Number(ms) || 1000);
}

/**
 * A counter that changes whenever the theme or accent on <html> changes (including the OS
 * flipping light/dark under "system"), so canvases can redraw with the new colors.
 */
export function useLookTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const obs = new MutationObserver(() => setTick((t) => t + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent"] });
    return () => obs.disconnect();
  }, []);
  return tick;
}

/** Read a color token from the stylesheet (canvas drawing can't use CSS variables directly). */
export function cssColor(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/**
 * Poll one torrent's details. Responses that arrive after a newer request (or after an
 * optimistic `mutate`) are dropped, so the view never jumps back to stale data.
 */
export function useTorrentPoll<T>(id: string, load: (id: string) => Promise<T>, ms: number, nonce: unknown = 0, enabled = true) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState("");
  const [bump, setBump] = useState(0);
  const seq = useRef(0);
  const holdUntil = useRef(0);
  usePoll(
    async () => {
      if (!enabled) return;
      const n = ++seq.current;
      const started = Date.now();
      try {
        const v = await load(id);
        if (n === seq.current && started >= holdUntil.current) {
          setData(v);
          setError("");
        }
      } catch (e) {
        if (n === seq.current) setError(e instanceof Error ? e.message : String(e));
      }
    },
    ms,
    [id, nonce, bump, enabled],
  );
  /** Fetch now (and end any hold: the backend says the data changed). */
  const refresh = useCallback(() => {
    holdUntil.current = 0;
    setBump((b) => b + 1);
  }, []);
  /**
   * Apply an optimistic change. `holdMs` also ignores polls for a while, for changes the
   * backend applies asynchronously and announces with an event (which calls `refresh`).
   */
  const mutate = useCallback((fn: (d: T) => T, holdMs = 0) => {
    seq.current++;
    if (holdMs > 0) holdUntil.current = Date.now() + holdMs;
    setData((d) => (d === undefined ? d : fn(d)));
  }, []);
  return { data, error, refresh, mutate };
}

/** `refresh`, debounced: backend events often come in bursts. */
export function useSoon(fn: () => void, ms = 150): () => void {
  const timer = useRef(0);
  const latest = useLatest(fn);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => latest.current(), ms);
  }, [ms, latest]);
}

/** Click / Ctrl+click / Shift+click selection for the simple tables in the details tabs. */
export function useRowSelection(keys: readonly string[]) {
  const [raw, setRaw] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  // Rows come and go with every poll; forget the ones that are gone.
  const selected = useMemo(() => {
    const live = new Set(keys);
    const kept = [...raw].filter((k) => live.has(k));
    return kept.length === raw.size ? raw : new Set(kept);
  }, [keys, raw]);

  const only = useCallback((key: string | null) => {
    setRaw(new Set(key ? [key] : []));
    anchor.current = key;
  }, []);

  const onRowMouseDown = (key: string, e: ReactMouseEvent) => {
    if (e.button === 2) {
      if (!selected.has(key)) only(key);
      return;
    }
    if (e.button !== 0) return;
    if (e.shiftKey && anchor.current && keys.includes(anchor.current)) {
      e.preventDefault();
      const a = keys.indexOf(anchor.current);
      const b = keys.indexOf(key);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const next = new Set(e.ctrlKey || e.metaKey ? selected : []);
      for (let i = lo; i <= hi; i++) next.add(keys[i]);
      setRaw(next);
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setRaw(next);
      anchor.current = key;
    } else only(key);
  };

  /** Arrow keys, Home/End and Ctrl+A. Returns true when the key was handled. */
  const onKeyDown = (e: ReactKeyboardEvent): boolean => {
    if (!keys.length) return false;
    const last = anchor.current && keys.includes(anchor.current) ? keys.indexOf(anchor.current) : -1;
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(keys.length - 1, last + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, last < 0 ? 0 : last - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = keys.length - 1;
    else if ((e.key === "a" || e.key === "A") && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setRaw(new Set(keys));
      return true;
    } else return false;
    e.preventDefault();
    only(keys[next]);
    return true;
  };

  return { selected, only, onRowMouseDown, onKeyDown, anchor: anchor.current };
}

export function TabLoading() {
  return (
    <div className="details-loading">
      <Spinner size={18} />
    </div>
  );
}

export function TabError({ message }: { message: string }) {
  return (
    <Empty icon={<CircleAlert />} title="Couldn't load this">
      {message}
    </Empty>
  );
}

/** "–" for the -1 the backend uses for "unknown". */
export function count(n: number | null | undefined): string {
  return n == null || n < 0 ? "–" : n.toLocaleString();
}
