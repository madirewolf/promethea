// The table behind the Trackers, Peers and HTTP sources tabs: a sticky header, click /
// Ctrl / Shift selection, keyboard navigation and a context menu.

import { useMemo, useRef } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { openContextMenu, openMenu } from "../../../components/ui/Menu";
import type { MenuEntry } from "../../../components/ui/Menu";
import { useRowSelection } from "./shared";

export interface DtColumn<T> {
  key: string;
  label: ReactNode;
  /** Pixels; the column without a width takes the remaining space. */
  width?: number;
  right?: boolean;
  /** Header tooltip. */
  tip?: string;
  sortable?: boolean;
  cell: (row: T) => ReactNode;
  cellTip?: (row: T) => string | undefined;
}

export interface DtSort {
  key: string;
  dir: 1 | -1;
}

interface Props<T> {
  label: string;
  rows: readonly T[];
  rowKey: (row: T) => string;
  columns: readonly DtColumn<T>[];
  sort?: DtSort;
  onSort?: (key: string) => void;
  rowClass?: (row: T) => string | undefined;
  /** Context menu for the selected rows (empty when the click was on blank space). */
  menu?: (selected: T[]) => MenuEntry[];
  /** Double-click or Enter on a single row. */
  onActivate?: (row: T) => void;
  /** Extra keys (Delete, F2, Ctrl+C ...). Return true when handled. */
  onKey?: (e: ReactKeyboardEvent, selected: T[]) => boolean;
  empty?: ReactNode;
  minWidth?: number;
}

export function DetailTable<T>({
  label,
  rows,
  rowKey,
  columns,
  sort,
  onSort,
  rowClass,
  menu,
  onActivate,
  onKey,
  empty,
  minWidth = 720,
}: Props<T>) {
  const el = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const keys = useMemo(() => rows.map(rowKey), [rows]);
  const sel = useRowSelection(keys);
  const selectedRows = () => rows.filter((r) => sel.selected.has(rowKey(r)));

  const revealAnchor = () =>
    requestAnimationFrame(() => el.current?.querySelector("tbody tr.foc")?.scrollIntoView({ block: "nearest" }));

  const menuAtSelection = () => {
    if (!menu || !el.current) return;
    const row = el.current.querySelector<HTMLElement>("tbody tr.foc") ?? el.current.querySelector<HTMLElement>("tbody tr.sel");
    const r = (row ?? el.current).getBoundingClientRect();
    openMenu({ items: menu(selectedRows()), x: r.left + 32, y: row ? r.bottom : r.top + 40 });
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (sel.onKeyDown(e)) {
      revealAnchor();
      return;
    }
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      menuAtSelection();
      return;
    }
    const s = selectedRows();
    if (e.key === "Enter" && onActivate && s.length === 1) {
      e.preventDefault();
      onActivate(s[0]);
      return;
    }
    if (e.key === "Escape" && s.length) {
      e.stopPropagation();
      sel.only(null);
      return;
    }
    if (onKey?.(e, s)) e.preventDefault();
  };

  const onMouseDown = (e: ReactMouseEvent) => {
    const t = e.target as Element;
    if (t.closest("thead")) return;
    if (!t.closest("tbody tr") && e.button === 0 && !e.ctrlKey && !e.shiftKey) sel.only(null);
  };

  const onContextMenu = (e: ReactMouseEvent) => {
    if (!menu) return;
    if ((e.target as Element).closest("thead")) {
      e.preventDefault();
      return;
    }
    openContextMenu(e, menu(selectedRows()));
  };

  const style = { minWidth } as CSSProperties;
  return (
    <div
      ref={el}
      className="dt-scroll"
      tabIndex={0}
      aria-label={label}
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
    >
      <table className="grid-table fixed" style={style}>
        <colgroup>
          {columns.map((c) => (
            <col key={c.key} style={c.width ? { width: c.width } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              const Icon = sort?.dir === 1 ? ArrowUp : ArrowDown;
              const cls = [c.right && "r", c.sortable && onSort && "sortable", active && "sorted"].filter(Boolean).join(" ");
              return (
                <th
                  key={c.key}
                  className={cls || undefined}
                  data-tip={c.tip}
                  aria-sort={active ? (sort?.dir === 1 ? "ascending" : "descending") : undefined}
                  onClick={c.sortable && onSort ? () => onSort(c.key) : undefined}
                >
                  {c.right && active && <Icon className="sort-ic" />}
                  {c.label}
                  {!c.right && active && <Icon className="sort-ic" />}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const k = keys[i];
            const cls = [sel.selected.has(k) && "sel", sel.anchor === k && "foc", rowClass?.(r)].filter(Boolean).join(" ");
            return (
              <tr
                key={k}
                className={cls || undefined}
                onMouseDown={(e) => sel.onRowMouseDown(k, e)}
                onDoubleClick={onActivate ? () => onActivate(r) : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} className={c.right ? "r" : undefined} data-tip={c.cellTip?.(r)}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && empty && <div className="dt-empty">{empty}</div>}
    </div>
  );
}

/** Flip the direction when the same column is clicked again; numbers start high-to-low. */
export function nextSort(cur: DtSort, key: string, textKeys: readonly string[] = []): DtSort {
  if (cur.key === key) return { key, dir: cur.dir === 1 ? -1 : 1 };
  return { key, dir: textKeys.includes(key) ? 1 : -1 };
}
