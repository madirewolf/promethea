import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { ArrowDown, ArrowUp, Check, FilePlus, Inbox, Link, Pause, Play, SearchX } from "lucide-react";
import type { Torrent } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { openContextMenu, openMenu } from "../../components/ui/Menu";
import type { MenuEntry } from "../../components/ui/Menu";
import { Empty } from "../../components/ui/Misc";
import * as A from "../../lib/actions";
import { onScrollbar } from "../../lib/hooks";
import { stateInfo } from "../../lib/states";
import { pickTorrentFiles } from "../../lib/add";
import {
  openDialog,
  selectAll,
  selectedIds,
  selectOnly,
  selectRange,
  setFilter,
  setSort,
  setVisibleOrder,
  toggleSelect,
  useStore,
} from "../../store/store";
import type { ColumnState } from "../../store/store";
import { COLUMN_MAP, COLUMNS, DEFAULT_HIDDEN, DEFAULT_ORDER } from "./columns";
import type { ColumnDef } from "./columns";
import { torrentMenu } from "./torrentMenu";

interface VisibleColumn {
  def: ColumnDef;
  width: number;
}

const HEADER_H = 34;
const NAME_FLOOR = 200;

// ------------------------------------------------------------------ column state
function currentColumns(): ColumnState {
  return useStore.getState().columns ?? { order: DEFAULT_ORDER, hidden: DEFAULT_HIDDEN, widths: {} };
}

function updateColumns(fn: (c: ColumnState) => ColumnState): void {
  useStore.setState({ columns: fn(currentColumns()) });
}

function normalizedOrder(order: string[] | undefined): string[] {
  const known = (order ?? DEFAULT_ORDER).filter((k) => COLUMN_MAP[k]);
  for (const k of DEFAULT_ORDER) if (!known.includes(k)) known.splice(DEFAULT_ORDER.indexOf(k), 0, k);
  return known;
}

function useColumnLayout(viewport: number): { cols: VisibleColumn[]; total: number } {
  const columns = useStore((s) => s.columns);
  return useMemo(() => {
    const order = normalizedOrder(columns?.order);
    const hidden = new Set(columns?.hidden ?? DEFAULT_HIDDEN);
    hidden.delete("name");
    const widths = columns?.widths ?? {};
    const cols = order
      .filter((k) => !hidden.has(k))
      .map((k) => {
        const def = COLUMN_MAP[k];
        return { def, width: Math.max(def.min ?? 40, Math.round(widths[k] ?? def.width)) };
      });
    // Name is the elastic column: it takes up spare room, and gives some back (down to
    // NAME_FLOOR) before the table has to scroll sideways.
    const sum = cols.reduce((a, c) => a + c.width, 0);
    const slack = Math.floor(viewport) - sum;
    const i = cols.findIndex((c) => c.def.key === "name");
    if (viewport > 0 && i >= 0 && slack !== 0) {
      const w = cols[i].width;
      const give = slack < 0 ? Math.max(slack, Math.min(0, NAME_FLOOR - w)) : slack;
      cols[i] = { ...cols[i], width: w + give };
      return { cols, total: sum + give };
    }
    return { cols, total: sum };
  }, [columns, viewport]);
}

function columnsMenu(): MenuEntry[] {
  const c = currentColumns();
  const hidden = new Set(c.hidden);
  return [
    { type: "label", label: "Columns" },
    ...COLUMNS.filter((d) => d.key !== "name").map((d) => ({
      label: d.label === "#" ? "Queue position" : d.label,
      checked: !hidden.has(d.key),
      keepOpen: true,
      onSelect: () =>
        updateColumns((s) => ({
          ...s,
          hidden: s.hidden.includes(d.key) ? s.hidden.filter((k) => k !== d.key) : [...s.hidden, d.key],
        })),
    })),
    { type: "separator" },
    { label: "Reset columns", onSelect: () => useStore.setState({ columns: null }) },
  ];
}

// ------------------------------------------------------------------ header
interface HeaderProps {
  cols: VisibleColumn[];
  total: number;
}

function Header({ cols, total }: HeaderProps) {
  const sort = useStore((s) => s.sort);
  const [drag, setDrag] = useState<{ key: string; dx: number; target: number; x: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const startResize = (e: ReactPointerEvent, col: VisibleColumn) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = col.width;
    const min = col.def.min ?? 40;
    document.body.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    const move = (ev: PointerEvent) => {
      const w = Math.max(min, w0 + ev.clientX - x0);
      updateColumns((s) => ({ ...s, widths: { ...s.widths, [col.def.key]: w } }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("dragging");
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startDrag = (e: ReactPointerEvent, col: VisibleColumn) => {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    const rects = [...(ref.current?.querySelectorAll<HTMLElement>(".th") ?? [])].map((el) => el.getBoundingClientRect());
    let dragging = false;
    let state = { key: col.def.key, dx: 0, target: -1, x: 0 };
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (!dragging && Math.abs(dx) < 5) return;
      if (!dragging) {
        dragging = true;
        document.body.classList.add("dragging");
      }
      // Drop position: before the first column whose centre is right of the pointer.
      let target = rects.findIndex((r) => ev.clientX < r.left + r.width / 2);
      if (target < 0) target = rects.length;
      const edge = target < rects.length ? rects[target].left : rects[rects.length - 1].right;
      const base = ref.current?.getBoundingClientRect().left ?? 0;
      state = { key: col.def.key, dx, target, x: edge - base };
      setDrag(state);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("dragging");
      setDrag(null);
      if (!dragging) {
        setSort(col.def.key);
        return;
      }
      const visibleKeys = cols.map((c) => c.def.key);
      const from = visibleKeys.indexOf(state.key);
      let to = state.target;
      if (to > from) to--;
      if (to === from || to < 0) return;
      // The visible column that will follow the dragged one (null = dropped at the end).
      const before = visibleKeys.filter((k) => k !== state.key)[to] ?? null;
      updateColumns((s) => {
        const order = normalizedOrder(s.order).filter((k) => k !== state.key);
        const at = before ? order.indexOf(before) : -1;
        order.splice(at < 0 ? order.length : at, 0, state.key);
        return { ...s, order };
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      ref={ref}
      className="tt-head"
      style={{ width: total }}
      onContextMenu={(e) => openContextMenu(e, columnsMenu)}
    >
      {cols.map((c) => {
        const active = sort.key === c.def.key;
        const Icon = sort.dir === 1 ? ArrowUp : ArrowDown;
        const dragged = drag?.key === c.def.key;
        return (
          <div
            key={c.def.key}
            className={["th", c.def.align === "right" && "r", active && "sorted", dragged && "dragging"].filter(Boolean).join(" ")}
            style={{ width: c.width, transform: dragged ? `translateX(${drag!.dx}px)` : undefined }}
            onPointerDown={(e) => startDrag(e, c)}
            role="columnheader"
            aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
          >
            {c.def.align === "right" && active && <Icon className="sort-ic" />}
            <span className="th-label">{c.def.label}</span>
            {c.def.align !== "right" && active && <Icon className="sort-ic" />}
            <div
              className="th-resize"
              onPointerDown={(e) => startResize(e, c)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                updateColumns((s) => {
                  const widths = { ...s.widths };
                  delete widths[c.def.key];
                  return { ...s, widths };
                });
              }}
            />
          </div>
        );
      })}
      {drag && drag.target >= 0 && <div className="th-drop" style={{ left: drag.x }} />}
    </div>
  );
}

// ------------------------------------------------------------------ rows
interface RowProps {
  t: Torrent;
  cols: VisibleColumn[];
  sel: boolean;
  foc: boolean;
}

const Row = memo(function Row({ t, cols, sel, foc }: RowProps) {
  const kind = stateInfo(t.state).kind;
  return (
    <div className={`tr st-${kind}${sel ? " sel" : ""}${foc ? " foc" : ""}`} data-id={t.id} role="row" aria-selected={sel}>
      {cols.map((c) => (
        <div
          key={c.def.key}
          className={c.def.align === "right" ? "td r" : "td"}
          style={{ width: c.width }}
          title={c.def.tip?.(t)}
        >
          {c.def.cell(t)}
        </div>
      ))}
    </div>
  );
});

// ------------------------------------------------------------------ table
export function TorrentTable({ rows }: { rows: Torrent[] }) {
  const el = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const selected = useStore((s) => s.selected);
  const focused = useStore((s) => s.focused);
  const density = useStore((s) => s.prefs?.behavior?.density);
  const hasTorrents = useStore((s) => Object.keys(s.torrents).length > 0);
  const synced = useStore((s) => s.synced);
  const rowH = density === "compact" ? 28 : 36;
  const { cols, total } = useColumnLayout(size.width);

  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const ro = new ResizeObserver(() => setSize({ width: node.clientWidth, height: node.clientHeight }));
    ro.observe(node);
    setSize({ width: node.clientWidth, height: node.clientHeight });
    return () => ro.disconnect();
  }, []);

  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  useEffect(() => setVisibleOrder(ids), [ids]);

  const overscan = 10;
  const start = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const end = Math.min(rows.length, Math.ceil((scrollTop + size.height) / rowH) + overscan);

  const scrollToIndex = useCallback(
    (i: number) => {
      const node = el.current;
      if (!node) return;
      const top = i * rowH;
      const view = node.clientHeight - HEADER_H;
      if (top < node.scrollTop) node.scrollTop = top;
      else if (top + rowH > node.scrollTop + view) node.scrollTop = top + rowH - view;
    },
    [rowH],
  );

  // Keep the focused row in view when it moves (keyboard, external selection).
  const lastFocused = useRef<string | null>(null);
  useEffect(() => {
    if (focused && focused !== lastFocused.current) {
      const i = ids.indexOf(focused);
      if (i >= 0) scrollToIndex(i);
    }
    lastFocused.current = focused;
  }, [focused, ids, scrollToIndex]);

  const rowFromEvent = (e: ReactMouseEvent) => (e.target as Element).closest<HTMLElement>("[data-id]")?.dataset.id ?? null;

  const onMouseDown = (e: ReactMouseEvent) => {
    if ((e.target as Element).closest(".tt-head") || onScrollbar(e)) return;
    const id = rowFromEvent(e);
    if (!id) {
      if (e.button === 0 && !e.ctrlKey && !e.shiftKey) selectOnly(null);
      return;
    }
    if (e.button === 2) {
      if (!useStore.getState().selected.has(id)) selectOnly(id);
      return;
    }
    if (e.button !== 0) return;
    if (e.shiftKey) {
      e.preventDefault();
      selectRange(id, e.ctrlKey || e.metaKey);
    } else if (e.ctrlKey || e.metaKey) toggleSelect(id);
    else selectOnly(id);
  };

  const onContextMenu = (e: ReactMouseEvent) => {
    if ((e.target as Element).closest(".tt-head")) return;
    const id = rowFromEvent(e);
    if (id) {
      openContextMenu(e, torrentMenu(selectedIds()));
      return;
    }
    openContextMenu(e, [
      { label: "Add torrent files…", icon: <FilePlus />, onSelect: () => void pickTorrentFiles() },
      { label: "Add magnet links…", icon: <Link />, onSelect: () => openDialog({ type: "addLinks" }) },
      { type: "separator" },
      { label: "Start all", icon: <Play />, onSelect: () => A.act("startAll", []) },
      { label: "Stop all", icon: <Pause />, onSelect: () => A.act("stopAll", []) },
      { type: "separator" },
      { label: "Select all", icon: <Check />, hint: "Ctrl+A", disabled: !rows.length, onSelect: selectAll },
    ]);
  };

  const onDoubleClick = (e: ReactMouseEvent) => {
    const id = rowFromEvent(e);
    if (id && !e.ctrlKey && !e.shiftKey) A.defaultAction(id);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const n = ids.length;
    const idx = focused ? ids.indexOf(focused) : -1;
    const page = Math.max(1, Math.floor((size.height - HEADER_H) / rowH) - 1);
    const ctrl = e.ctrlKey || e.metaKey;
    let next = -1;
    switch (e.key) {
      case "ArrowDown":
        next = idx < 0 ? 0 : Math.min(n - 1, idx + 1);
        break;
      case "ArrowUp":
        next = idx < 0 ? 0 : Math.max(0, idx - 1);
        break;
      case "PageDown":
        next = Math.min(n - 1, Math.max(0, idx) + page);
        break;
      case "PageUp":
        next = Math.max(0, idx - page);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = n - 1;
        break;
      case "a":
      case "A":
        if (ctrl) {
          e.preventDefault();
          selectAll();
        }
        return;
      case "Delete":
        e.preventDefault();
        A.requestDelete(selectedIds(), e.shiftKey ? true : undefined);
        return;
      case "Enter":
        if (focused) {
          e.preventDefault();
          A.defaultAction(focused);
        }
        return;
      case " ":
        e.preventDefault();
        if (ctrl && focused) toggleSelect(focused);
        else A.toggle(selectedIds());
        return;
      case "F2": {
        const sel = selectedIds();
        if (sel.length === 1) {
          e.preventDefault();
          openDialog({ type: "rename", id: sel[0] });
        }
        return;
      }
      case "Escape":
        if (useStore.getState().selected.size) {
          e.preventDefault();
          selectOnly(null);
        }
        return;
      case "ContextMenu":
      case "F10": {
        if (e.key === "F10" && !e.shiftKey) return;
        e.preventDefault();
        const sel = selectedIds();
        if (!sel.length) return;
        const row = el.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(focused ?? sel[0])}"]`);
        const r = row?.getBoundingClientRect() ?? el.current!.getBoundingClientRect();
        openMenu({ items: torrentMenu(sel), x: r.left + 40, y: r.top + r.height / 2 });
        return;
      }
      default:
        return;
    }
    if (next < 0 || n === 0) return;
    e.preventDefault();
    const id = ids[next];
    if (e.shiftKey) selectRange(id, ctrl);
    else if (ctrl) useStore.setState({ focused: id });
    else selectOnly(id);
    scrollToIndex(next);
  };

  const visible = rows.slice(start, end);

  return (
    <div
      ref={el}
      className="tt"
      tabIndex={0}
      role="grid"
      aria-rowcount={rows.length}
      aria-multiselectable
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      style={{ ["--row-h" as string]: `${rowH}px` }}
    >
      <Header cols={cols} total={total} />
      <div className="tt-body" style={{ height: rows.length * rowH, width: total }}>
        <div className="tt-rows" style={{ transform: `translateY(${start * rowH}px)` }}>
          {visible.map((t) => (
            <Row key={t.id} t={t} cols={cols} sel={selected.has(t.id)} foc={focused === t.id} />
          ))}
        </div>
      </div>
      {rows.length === 0 && synced && (
        <div className="tt-empty">{hasTorrents ? <NoMatches /> : <NoTorrents />}</div>
      )}
    </div>
  );
}

function NoTorrents() {
  return (
    <Empty
      icon={<Inbox />}
      title="No torrents yet"
      actions={
        <>
          <Button variant="primary" icon={<FilePlus />} onClick={() => void pickTorrentFiles()}>
            Add torrent
          </Button>
          <Button icon={<Link />} onClick={() => openDialog({ type: "addLinks" })}>
            Add magnet link
          </Button>
        </>
      }
    >
      Drop .torrent files anywhere in this window, or paste a magnet link with Ctrl+V.
    </Empty>
  );
}

function NoMatches() {
  return (
    <Empty
      icon={<SearchX />}
      title="Nothing matches"
      actions={
        <Button
          onClick={() => setFilter({ status: "all", category: null, tag: null, tracker: null, text: "" })}
        >
          Clear filters
        </Button>
      }
    >
      No torrents match the current filters.
    </Empty>
  );
}
