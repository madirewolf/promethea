import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, PointerEvent as ReactPointerEvent, RefCallback, SetStateAction } from "react";
import { on } from "./events";

/** A ref that always holds the latest value (for stable callbacks). */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * Run `fn` now and then every `ms` while the page is visible. Calls never overlap.
 * Re-starts whenever `deps` change. `ms <= 0` runs it once.
 */
export function usePoll(fn: () => unknown | Promise<unknown>, ms: number, deps: unknown[]): void {
  const fnRef = useLatest(fn);
  useEffect(() => {
    let alive = true;
    let timer = 0;
    let running = false;
    const tick = async () => {
      if (!alive) return;
      if (document.hidden) {
        timer = window.setTimeout(tick, ms);
        return;
      }
      if (!running) {
        running = true;
        try {
          await fnRef.current();
        } catch {
          /* the caller shows its own errors */
        } finally {
          running = false;
        }
      }
      if (alive && ms > 0) timer = window.setTimeout(tick, ms);
    };
    void tick();
    const onVisible = () => {
      if (!document.hidden && alive) {
        window.clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}

/** Subscribe to a backend event for the lifetime of the component. */
export function useEvent(name: string, handler: (data: any) => void): void {
  const ref = useLatest(handler);
  useEffect(() => on(name, (d) => ref.current(d)), [name, ref]);
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Observe an element's content-box size. */
export function useSize<T extends HTMLElement>(): [RefCallback<T>, { width: number; height: number }] {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize((s) => (s.width === r.width && s.height === r.height ? s : { width: r.width, height: r.height }));
    });
    ro.observe(el);
    observer.current = ro;
  }, []);
  return [ref, size];
}

/**
 * Pointer-drag helper for splitters: calls `onMove(dx, dy)` relative to the pointer-down position.
 * Returns an onPointerDown handler.
 */
export function useDrag(
  onMove: (dx: number, dy: number) => void,
  onEnd?: () => void,
  cursor = "col-resize",
): (e: ReactPointerEvent) => void {
  const moveRef = useLatest(onMove);
  const endRef = useLatest(onEnd);
  return useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const x0 = e.clientX;
      const y0 = e.clientY;
      const prevCursor = document.body.style.cursor;
      document.body.style.cursor = cursor;
      document.body.classList.add("dragging");
      const move = (ev: PointerEvent) => moveRef.current(ev.clientX - x0, ev.clientY - y0);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        document.body.style.cursor = prevCursor;
        document.body.classList.remove("dragging");
        endRef.current?.();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [cursor, moveRef, endRef],
  );
}

/** Re-render every `ms` (for relative times like "3m ago"). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now() / 1000), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

/** Load data once (and again when deps change); exposes a reload function. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): {
  data: T | undefined;
  error: string;
  loading: boolean;
  reload: () => Promise<void>;
  setData: Dispatch<SetStateAction<T | undefined>>;
} {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const fnRef = useLatest(fn);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    try {
      const v = await fnRef.current();
      if (n === seq.current) {
        setData(v);
        setError("");
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [fnRef]);
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload, setData };
}

/** The press was on the element's own scroll bars (mousedown fires on the element for those). */
export function onScrollbar(e: { target: EventTarget; currentTarget: EventTarget; clientX: number; clientY: number }): boolean {
  const el = e.currentTarget as HTMLElement;
  if (e.target !== el) return false;
  const r = el.getBoundingClientRect();
  return e.clientX - r.left - el.clientLeft >= el.clientWidth || e.clientY - r.top - el.clientTop >= el.clientHeight;
}
