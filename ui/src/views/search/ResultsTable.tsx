// Search results: a virtualized list like the transfer list, with its own selection.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, Globe } from "lucide-react";
import type { SearchPlugin, SearchResult } from "../../api/types";
import { openContextMenu, openMenu } from "../../components/ui/Menu";
import type { MenuEntry } from "../../components/ui/Menu";
import { Spinner } from "../../components/ui/Misc";
import { formatBytes, formatDate, formatShortDate } from "../../lib/format";
import { onScrollbar } from "../../lib/hooks";
import { useStore } from "../../store/store";
import type { ResultSort, SortKey } from "./searchStore";

interface Column {
  key: SortKey;
  label: string;
  width: number;
  right?: boolean;
  /** Dropped below this table width. */
  hideBelow?: number;
}

const COLUMNS: Column[] = [
  { key: "name", label: "Name", width: 0 },
  { key: "size", label: "Size", width: 96, right: true },
  { key: "seeds", label: "Seeds", width: 78, right: true },
  { key: "leechers", label: "Leechers", width: 86, right: true, hideBelow: 720 },
  { key: "site", label: "Site", width: 164, hideBelow: 540 },
  { key: "pubDate", label: "Published", width: 132, right: true, hideBelow: 860 },
];

const HEADER_H = 34;
/** Names get what the other columns leave, but never less than this (the list then scrolls sideways). */
const NAME_FLOOR = 140;

function num(n: number): string {
  return n < 0 ? "–" : n.toLocaleString();
}

export interface Selection {
  selected: ReadonlySet<string>;
  anchor: string | null;
  focused: string | null;
}

export const NO_SELECTION: Selection = { selected: new Set(), anchor: null, focused: null };

interface RowProps {
  r: SearchResult;
  cols: { col: Column; width: number }[];
  sel: boolean;
  foc: boolean;
  added: boolean;
  busy: boolean;
  site: SearchPlugin | undefined;
}

const Row = memo(function Row({ r, cols, sel, foc, added, busy, site }: RowProps) {
  const cell = (key: SortKey): ReactNode => {
    switch (key) {
      case "name":
        return (
          <div className="name-cell">
            <span className="name-text">{r.name}</span>
            {busy && <Spinner size={13} />}
            {added && !busy && (
              <span className="sv-added">
                <Check />
                Added
              </span>
            )}
          </div>
        );
      case "size":
        return formatBytes(r.size);
      case "seeds":
        return <span className={r.seeds > 0 ? "sv-seeds" : "faint"}>{num(r.seeds)}</span>;
      case "leechers":
        return <span className={r.leechers > 0 ? undefined : "faint"}>{num(r.leechers)}</span>;
      case "site":
        return (
          <span className="sv-site">
            {site?.icon ? <img src={site.icon} alt="" /> : <Globe />}
            <span>{site?.fullName || r.plugin}</span>
          </span>
        );
      case "pubDate":
        return r.pubDate > 0 ? formatShortDate(r.pubDate) : <span className="faint">–</span>;
    }
  };
  const tip = (key: SortKey): string | undefined => {
    if (key === "name") return r.name;
    if (key === "site") return r.engineUrl || undefined;
    if (key === "pubDate" && r.pubDate > 0) return formatDate(r.pubDate);
    return undefined;
  };
  return (
    <div className={`tr${sel ? " sel" : ""}${foc ? " foc" : ""}${added ? " sv-in" : ""}`} data-link={r.link} role="row" aria-selected={sel}>
      {cols.map(({ col, width }) => (
        <div key={col.key} className={col.right ? "td r" : "td"} style={{ width }} title={tip(col.key)}>
          {cell(col.key)}
        </div>
      ))}
    </div>
  );
});

interface Props {
  rows: readonly SearchResult[];
  sort: ResultSort | null;
  onSort: (key: SortKey) => void;
  selection: Selection;
  onSelection: (s: Selection) => void;
  plugins: Record<string, SearchPlugin>;
  /** Links of results already in the transfer list. */
  added: ReadonlySet<string>;
  fetching: Record<string, true>;
  /** Context menu for the selected results. */
  menu: (rows: SearchResult[]) => MenuEntry[];
  /** Double-click or Enter. */
  onActivate: (rows: SearchResult[]) => void;
  /** Shown over the empty list. */
  empty?: ReactNode;
}

export function ResultsTable({ rows, sort, onSort, selection, onSelection, plugins, added, fetching, menu, onActivate, empty }: Props) {
  const el = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const density = useStore((s) => s.prefs?.behavior?.density);
  const rowH = density === "compact" ? 28 : 36;

  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const ro = new ResizeObserver(() => setSize({ width: node.clientWidth, height: node.clientHeight }));
    ro.observe(node);
    setSize({ width: node.clientWidth, height: node.clientHeight });
    return () => ro.disconnect();
  }, []);

  const { cols, total } = useMemo(() => {
    const shown = COLUMNS.filter((c) => !c.hideBelow || size.width === 0 || size.width >= c.hideBelow);
    const fixed = shown.reduce((a, c) => a + c.width, 0);
    const name = Math.max(NAME_FLOOR, Math.floor(size.width) - fixed);
    return { cols: shown.map((col) => ({ col, width: col.key === "name" ? name : col.width })), total: fixed + name };
  }, [size.width]);

  const links = useMemo(() => rows.map((r) => r.link), [rows]);
  const index = useMemo(() => new Map(links.map((l, i) => [l, i])), [links]);
  const { selected, anchor, focused } = selection;
  const selectedRows = () => rows.filter((r) => selected.has(r.link));

  const scrollToIndex = (i: number) => {
    const node = el.current;
    if (!node) return;
    const top = i * rowH;
    const view = node.clientHeight - HEADER_H;
    if (top < node.scrollTop) node.scrollTop = top;
    else if (top + rowH > node.scrollTop + view) node.scrollTop = top + rowH - view;
  };

  // Keep the focused row in view when it moves (keyboard); not when results arrive and re-sort.
  const lastFocused = useRef<string | null>(null);
  useEffect(() => {
    if (focused && focused !== lastFocused.current) {
      const i = index.get(focused);
      if (i !== undefined) scrollToIndex(i);
    }
    lastFocused.current = focused;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused]);

  const only = (link: string | null) => onSelection({ selected: new Set(link ? [link] : []), anchor: link, focused: link });
  const range = (link: string, additive: boolean) => {
    const a = anchor ? index.get(anchor) : undefined;
    const b = index.get(link);
    if (a === undefined || b === undefined) {
      only(link);
      return;
    }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const next = new Set(additive ? selected : []);
    for (let i = lo; i <= hi; i++) next.add(links[i]);
    onSelection({ selected: next, anchor, focused: link });
  };
  const toggle = (link: string) => {
    const next = new Set(selected);
    if (next.has(link)) next.delete(link);
    else next.add(link);
    onSelection({ selected: next, anchor: link, focused: link });
  };

  const linkFromEvent = (e: ReactMouseEvent) => (e.target as Element).closest<HTMLElement>("[data-link]")?.dataset.link ?? null;

  const onMouseDown = (e: ReactMouseEvent) => {
    if ((e.target as Element).closest(".tt-head") || onScrollbar(e)) return;
    const link = linkFromEvent(e);
    if (!link) {
      if (e.button === 0 && !e.ctrlKey && !e.shiftKey) only(null);
      return;
    }
    if (e.button === 2) {
      if (!selected.has(link)) only(link);
      return;
    }
    if (e.button !== 0) return;
    if (e.shiftKey) {
      e.preventDefault();
      range(link, e.ctrlKey || e.metaKey);
    } else if (e.ctrlKey || e.metaKey) toggle(link);
    else only(link);
  };

  const onContextMenu = (e: ReactMouseEvent) => {
    if ((e.target as Element).closest(".tt-head")) {
      e.preventDefault();
      return;
    }
    const link = linkFromEvent(e);
    if (!link) {
      e.preventDefault();
      return;
    }
    // The mousedown already selected the row when it wasn't.
    const sel = selected.has(link) ? selectedRows() : rows.filter((r) => r.link === link);
    openContextMenu(e, menu(sel));
  };

  const onDoubleClick = (e: ReactMouseEvent) => {
    const link = linkFromEvent(e);
    if (!link || e.ctrlKey || e.shiftKey) return;
    const r = rows[index.get(link) ?? -1];
    if (r) onActivate([r]);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const n = links.length;
    const idx = focused ? index.get(focused) ?? -1 : -1;
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
          onSelection({ selected: new Set(links), anchor: anchor ?? links[0] ?? null, focused: focused ?? links[0] ?? null });
        }
        return;
      case " ":
        if (ctrl && focused) {
          e.preventDefault();
          toggle(focused);
        }
        return;
      case "Enter": {
        const sel = selectedRows();
        if (sel.length) {
          e.preventDefault();
          onActivate(sel);
        }
        return;
      }
      case "Escape":
        if (selected.size) {
          e.preventDefault();
          e.stopPropagation();
          only(null);
        }
        return;
      case "ContextMenu":
      case "F10": {
        if (e.key === "F10" && !e.shiftKey) return;
        e.preventDefault();
        const sel = selectedRows();
        if (!sel.length) return;
        const row = el.current?.querySelector<HTMLElement>(`[data-link="${CSS.escape(focused ?? sel[0].link)}"]`);
        const r = row?.getBoundingClientRect() ?? el.current!.getBoundingClientRect();
        openMenu({ items: menu(sel), x: r.left + 40, y: r.top + r.height / 2 });
        return;
      }
      default:
        return;
    }
    if (next < 0 || n === 0) return;
    e.preventDefault();
    const link = links[next];
    if (e.shiftKey) range(link, ctrl);
    else if (ctrl) onSelection({ ...selection, focused: link });
    else only(link);
    scrollToIndex(next);
  };

  const overscan = 10;
  const start = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const end = Math.min(rows.length, Math.ceil((scrollTop + size.height) / rowH) + overscan);
  const visible = rows.slice(start, end);
  const Icon = sort?.dir === 1 ? ArrowUp : ArrowDown;

  return (
    <div
      ref={el}
      className="tt sv-table"
      tabIndex={0}
      role="grid"
      aria-label="Search results"
      aria-rowcount={rows.length}
      aria-multiselectable
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      style={{ ["--row-h" as string]: `${rowH}px` }}
    >
      <div className="tt-head" style={{ width: total }} role="row">
        {cols.map(({ col, width }) => {
          const active = sort?.key === col.key;
          return (
            <div
              key={col.key}
              className={["th", col.right && "r", active && "sorted"].filter(Boolean).join(" ")}
              style={{ width }}
              role="columnheader"
              aria-sort={active ? (sort?.dir === 1 ? "ascending" : "descending") : "none"}
              onClick={() => onSort(col.key)}
            >
              {col.right && active && <Icon className="sort-ic" />}
              <span className="th-label">{col.label}</span>
              {!col.right && active && <Icon className="sort-ic" />}
            </div>
          );
        })}
      </div>
      <div className="tt-body" style={{ height: rows.length * rowH, width: total }}>
        <div className="tt-rows" style={{ transform: `translateY(${start * rowH}px)` }}>
          {visible.map((r) => (
            <Row
              key={r.link}
              r={r}
              cols={cols}
              sel={selected.has(r.link)}
              foc={focused === r.link}
              added={added.has(r.link)}
              busy={!!fetching[r.link]}
              site={plugins[r.plugin]}
            />
          ))}
        </div>
      </div>
      {rows.length === 0 && empty && <div className="tt-empty">{empty}</div>}
    </div>
  );
}
