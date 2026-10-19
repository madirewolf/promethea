import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Captions,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Disc3,
  ExternalLink,
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileMusic,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  FolderSearch,
  Gauge,
  Pencil,
} from "lucide-react";
import { toast, useStore } from "../store/store";
import { formatBytes, formatPercent } from "../lib/format";
import { useLatest } from "../lib/hooks";
import { openContextMenu, openDropdown, openMenu } from "./ui/Menu";
import type { MenuEntry } from "./ui/Menu";
import { Checkbox } from "./ui/Form";
import { Progress } from "./ui/Misc";
import {
  PRIORITIES,
  defaultExpanded,
  expansionFor,
  fileKind,
  filesOf,
  filesUnder,
  flatten,
  moveExpansion,
  nameError,
  parentPath,
  priorityLabel,
  progressOf,
  remainingOf,
  syncTree,
} from "./treeModel";
import type { FileKind, TreeFile, TreeModel, TreeNode, TreeSort, TreeSortKey } from "./treeModel";

export type FileColumn = "progress" | "remaining" | "availability";

interface ColDef {
  key: TreeSortKey;
  label: string;
  width: string;
  min: number;
  right?: boolean;
}

const COLS: Record<TreeSortKey, ColDef> = {
  name: { key: "name", label: "Name", width: "minmax(220px, 1fr)", min: 220 },
  size: { key: "size", label: "Size", width: "92px", min: 92, right: true },
  progress: { key: "progress", label: "Progress", width: "150px", min: 150 },
  priority: { key: "priority", label: "Priority", width: "140px", min: 140 },
  remaining: { key: "remaining", label: "Remaining", width: "100px", min: 100, right: true },
  availability: { key: "availability", label: "Availability", width: "100px", min: 100, right: true },
};

const KIND_ICONS: Record<FileKind, typeof File> = {
  video: FileVideo,
  audio: FileMusic,
  image: FileImage,
  archive: FileArchive,
  disc: Disc3,
  subtitle: Captions,
  text: FileText,
  program: FileCog,
  code: FileCode,
  file: File,
};

const HEADER_H = 32;
const NO_COLUMNS: readonly FileColumn[] = [];

function commonPriority(files: readonly TreeFile[]): number {
  if (!files.length) return -1;
  const p = files[0].priority;
  return files.every((f) => f.priority === p) ? p : -1;
}

function prioClass(p: number): string {
  if (p === 0) return " skip";
  if (p === 6) return " high";
  if (p === 7) return " max";
  return "";
}

// ------------------------------------------------------------------ inline rename
function RenameBox({
  node,
  windows,
  onDone,
}: {
  node: TreeNode;
  windows: boolean;
  onDone: (name: string | null, byKey: boolean) => void;
}) {
  const [value, setValue] = useState(node.name);
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const error = value === node.name ? null : nameError(value, node, windows);

  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    // Select the name without its extension, like Explorer.
    const dot = node.folder ? -1 : node.name.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : node.name.length);
  }, [node]);

  const finish = (commit: boolean, byKey: boolean) => {
    if (finished.current) return;
    if (commit && error) {
      toast("warning", error);
      return;
    }
    finished.current = true;
    onDone(commit && value !== node.name ? value : null, byKey);
  };

  return (
    <input
      ref={ref}
      className={`ft-rename${error ? " invalid" : ""}`}
      value={value}
      spellCheck={false}
      autoComplete="off"
      title={error ?? undefined}
      aria-invalid={!!error}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true, true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false, true);
        }
      }}
      onBlur={() => finish(!error, false)}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    />
  );
}

// ------------------------------------------------------------------ rows
interface RowHandlers {
  toggle: (n: TreeNode) => void;
  check: (n: TreeNode) => void;
  priorityMenu: (n: TreeNode, el: HTMLElement) => void;
  renameDone: (n: TreeNode, name: string | null, byKey: boolean) => void;
}

interface RowProps {
  node: TreeNode;
  /** Changes whenever the node's values were updated in place. */
  version: number;
  cols: ColDef[];
  sel: boolean;
  foc: boolean;
  open: boolean;
  renaming: boolean;
  windows: boolean;
  h: RowHandlers;
}

const Row = memo(function Row({ node: n, cols, sel, foc, open, renaming, windows, h }: RowProps) {
  const checked = n.count > 0 && n.wantedCount === n.count;
  const mixed = n.wantedCount > 0 && n.wantedCount < n.count;
  const Icon = n.folder ? (open ? FolderOpen : Folder) : KIND_ICONS[fileKind(n.name)];
  const cls = ["ft-row", sel && "sel", foc && "foc", n.wantedCount === 0 && "skip"].filter(Boolean).join(" ");
  return (
    <div
      className={cls}
      data-key={n.key}
      role="row"
      aria-selected={sel}
      aria-level={n.depth + 1}
      aria-expanded={n.folder ? open : undefined}
    >
      {cols.map((c) => {
        switch (c.key) {
          case "name":
            return (
              <div key="name" className="ft-cell ft-name" style={{ paddingLeft: 6 + n.depth * 18 }}>
                {n.folder ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    className={`ft-chev${open ? " open" : ""}`}
                    aria-label={open ? "Collapse" : "Expand"}
                    onMouseDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onClick={() => h.toggle(n)}
                  >
                    <ChevronRight />
                  </button>
                ) : (
                  <span className="ft-chev" />
                )}
                <span className="ft-check" onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={checked}
                    indeterminate={mixed}
                    onChange={() => h.check(n)}
                    title={checked ? "Don't download" : "Download"}
                  />
                </span>
                <Icon className={n.folder ? "ft-ic folder" : "ft-ic"} />
                {renaming ? (
                  <RenameBox node={n} windows={windows} onDone={(name, byKey) => h.renameDone(n, name, byKey)} />
                ) : (
                  <span className="ft-label" title={n.name}>
                    {n.name}
                  </span>
                )}
              </div>
            );
          case "size":
            return (
              <div key="size" className="ft-cell r">
                {formatBytes(n.size)}
              </div>
            );
          case "progress": {
            const p = progressOf(n);
            return (
              <div key="progress" className="ft-cell">
                <div className="progress-cell">
                  <Progress value={p} />
                  <span>{formatPercent(p)}</span>
                </div>
              </div>
            );
          }
          case "priority":
            return (
              <div key="priority" className="ft-cell">
                <button
                  type="button"
                  tabIndex={-1}
                  className={`ft-prio${prioClass(n.priority)}`}
                  onMouseDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onClick={(e) => h.priorityMenu(n, e.currentTarget)}
                >
                  <span>{priorityLabel(n.priority)}</span>
                  <ChevronDown />
                </button>
              </div>
            );
          case "remaining":
            return (
              <div key="remaining" className="ft-cell r">
                {formatBytes(remainingOf(n))}
              </div>
            );
          case "availability":
            return (
              <div key="availability" className="ft-cell r">
                {n.availability < 0 ? "–" : formatPercent(Math.min(1, n.availability))}
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
});

// ------------------------------------------------------------------ tree
export interface FileTreeProps {
  files: readonly TreeFile[];
  /** Columns besides name, size and priority. */
  columns?: readonly FileColumn[];
  /** Remembers which folders are open (a torrent id, or the add dialog's token). */
  stateKey: string;
  filter?: string;
  onPriority: (files: TreeFile[], priority: number) => void;
  onRename?: (node: TreeNode, name: string) => void;
  onOpen?: (node: TreeNode) => void;
  onReveal?: (node: TreeNode) => void;
  className?: string;
  /** Shown when there are no rows. */
  empty?: ReactNode;
}

export function FileTree({
  files,
  columns = NO_COLUMNS,
  stateKey,
  filter = "",
  onPriority,
  onRename,
  onOpen,
  onReveal,
  className,
  empty,
}: FileTreeProps) {
  const modelRef = useRef<TreeModel | null>(null);
  const model = useMemo(() => (modelRef.current = syncTree(modelRef.current, files)), [files]);
  const [sort, setSort] = useState<TreeSort>({ key: "name", dir: 1 });
  const [expVersion, setExpVersion] = useState(0);
  const overrides = useMemo(() => expansionFor(stateKey), [stateKey]);
  const isOpen = useCallback((n: TreeNode) => overrides.get(n.key) ?? defaultExpanded(model, n), [overrides, model]);
  const filtering = filter.trim() !== "";
  const rows = useMemo(
    () => flatten(model, isOpen, sort, filter),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, isOpen, sort, filter, expVersion],
  );
  const rowIndex = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => m.set(r.key, i));
    return m;
  }, [rows]);

  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const windows = useStore((s) => /^win/i.test(s.app?.platform ?? ""));
  const density = useStore((s) => s.prefs?.behavior?.density);
  const rowH = density === "compact" ? 28 : 32;

  const el = useRef<HTMLDivElement>(null);
  const [viewH, setViewH] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const ro = new ResizeObserver(() => setViewH(node.clientHeight));
    ro.observe(node);
    setViewH(node.clientHeight);
    return () => ro.disconnect();
  }, []);

  const cols = useMemo(() => {
    const keys: TreeSortKey[] = ["name", "size"];
    if (columns.includes("progress")) keys.push("progress");
    keys.push("priority");
    if (columns.includes("remaining")) keys.push("remaining");
    if (columns.includes("availability")) keys.push("availability");
    return keys.map((k) => COLS[k]);
  }, [columns]);
  const template = cols.map((c) => c.width).join(" ");
  const minWidth = cols.reduce((a, c) => a + c.min, 0);

  const nodeOf = (key: string | null | undefined): TreeNode | undefined => {
    if (!key) return undefined;
    return key.startsWith("f:") ? model.byIndex.get(Number(key.slice(2))) : model.folders.get(key.slice(2));
  };
  const selectedNodes = (): TreeNode[] => [...selected].map(nodeOf).filter((n): n is TreeNode => !!n);

  const scrollToIndex = (i: number) => {
    const node = el.current;
    if (!node || i < 0) return;
    const top = i * rowH;
    const view = node.clientHeight - HEADER_H;
    if (top < node.scrollTop) node.scrollTop = top;
    else if (top + rowH > node.scrollTop + view) node.scrollTop = top + rowH - view;
  };

  // ---------------------------------------------------------------- selection
  const selectOnly = (key: string | null) => {
    setSelected(new Set(key ? [key] : []));
    setFocus(key);
    anchor.current = key;
  };
  const toggleOne = (key: string) => {
    const s = new Set(selected);
    if (s.has(key)) s.delete(key);
    else s.add(key);
    setSelected(s);
    setFocus(key);
    anchor.current = key;
  };
  const selectRangeTo = (key: string, additive: boolean) => {
    const a = anchor.current ? rowIndex.get(anchor.current) ?? -1 : -1;
    const b = rowIndex.get(key) ?? -1;
    if (a < 0 || b < 0) {
      selectOnly(key);
      return;
    }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const s = new Set(additive ? selected : []);
    for (let i = lo; i <= hi; i++) s.add(rows[i].key);
    setSelected(s);
    setFocus(key);
  };

  // ---------------------------------------------------------------- actions
  const setOpen = (n: TreeNode, open: boolean) => {
    overrides.set(n.key, open);
    setExpVersion((v) => v + 1);
  };
  const expandAll = (open: boolean) => {
    for (const f of model.folders.values()) overrides.set(f.key, open);
    setExpVersion((v) => v + 1);
  };
  const toggle = (n: TreeNode) => setOpen(n, !isOpen(n));

  /** Checking downloads what was skipped (keeping other priorities); unchecking skips everything. */
  const setWanted = (fs: TreeFile[]) => {
    if (!fs.length) return;
    if (fs.every((f) => f.priority > 0)) onPriority(fs, 0);
    else onPriority(fs.filter((f) => f.priority === 0), 4);
  };
  const check = (n: TreeNode) => setWanted(filesUnder(n));

  const priorityItems = (targets: TreeNode[]): MenuEntry[] => {
    const fs = filesOf(targets);
    const cur = commonPriority(fs);
    return PRIORITIES.map((p) => ({
      label: p.label,
      checked: cur === p.value,
      onSelect: () => onPriority(fs, p.value),
    }));
  };
  const targetsFor = (n: TreeNode): TreeNode[] => (selected.has(n.key) && selected.size > 1 ? selectedNodes() : [n]);
  const priorityMenu = (n: TreeNode, anchorEl: HTMLElement) => openDropdown(anchorEl, priorityItems(targetsFor(n)));

  const startRename = (n: TreeNode) => {
    if (!onRename) return;
    selectOnly(n.key);
    scrollToIndex(rowIndex.get(n.key) ?? -1);
    setRenaming(n.key);
  };
  const renameDone = (n: TreeNode, name: string | null, byKey: boolean) => {
    setRenaming(null);
    if (byKey) el.current?.focus({ preventScroll: true });
    if (name == null || !onRename) return;
    if (n.folder) {
      // Folder keys are paths: carry the open state and selection over to the new name.
      const parent = parentPath(n);
      const newPath = parent ? `${parent}/${name}` : name;
      moveExpansion(stateKey, n.path, newPath);
      selectOnly(`d:${newPath}`);
    }
    onRename(n, name);
  };

  const menuFor = (targets: TreeNode[]): MenuEntry[] => {
    const one = targets.length === 1 ? targets[0] : null;
    const folders = model.folderCount > 0;
    return [
      onOpen && one && { label: "Open", icon: <ExternalLink />, onSelect: () => onOpen(one) },
      onReveal && one && { label: "Open containing folder", icon: <FolderSearch />, onSelect: () => onReveal(one) },
      { type: "separator" },
      onRename && one && { label: "Rename…", icon: <Pencil />, hint: "F2", onSelect: () => startRename(one) },
      targets.length > 0 && { label: "Priority", icon: <Gauge />, items: () => priorityItems(targets) },
      { type: "separator" },
      folders && { label: "Expand all", icon: <ChevronsUpDown />, onSelect: () => expandAll(true) },
      folders && { label: "Collapse all", icon: <ChevronsDownUp />, onSelect: () => expandAll(false) },
    ];
  };

  const latest = useLatest<RowHandlers>({ toggle, check, priorityMenu, renameDone });
  const h = useMemo<RowHandlers>(
    () => ({
      toggle: (n) => latest.current.toggle(n),
      check: (n) => latest.current.check(n),
      priorityMenu: (n, e) => latest.current.priorityMenu(n, e),
      renameDone: (n, name, byKey) => latest.current.renameDone(n, name, byKey),
    }),
    [latest],
  );

  // ---------------------------------------------------------------- events
  const keyFromEvent = (e: ReactMouseEvent) => (e.target as Element).closest<HTMLElement>("[data-key]")?.dataset.key ?? null;

  const onMouseDown = (e: ReactMouseEvent) => {
    if ((e.target as Element).closest(".ft-head")) return;
    const key = keyFromEvent(e);
    if (!key) {
      if (e.button === 0 && !e.ctrlKey && !e.shiftKey) selectOnly(null);
      return;
    }
    if (e.button === 2) {
      if (!selected.has(key)) selectOnly(key);
      return;
    }
    if (e.button !== 0) return;
    if (e.shiftKey) {
      e.preventDefault();
      selectRangeTo(key, e.ctrlKey || e.metaKey);
    } else if (e.ctrlKey || e.metaKey) toggleOne(key);
    else selectOnly(key);
  };

  const onContextMenu = (e: ReactMouseEvent) => {
    if ((e.target as Element).closest(".ft-head")) {
      e.preventDefault();
      return;
    }
    const key = keyFromEvent(e);
    const n = nodeOf(key);
    if (!n) {
      if (model.folderCount > 0) {
        openContextMenu(e, [
          { label: "Expand all", icon: <ChevronsUpDown />, onSelect: () => expandAll(true) },
          { label: "Collapse all", icon: <ChevronsDownUp />, onSelect: () => expandAll(false) },
        ]);
      } else e.preventDefault();
      return;
    }
    openContextMenu(e, menuFor(selected.has(n.key) ? selectedNodes() : [n]));
  };

  const onDoubleClick = (e: ReactMouseEvent) => {
    if (e.ctrlKey || e.shiftKey || e.metaKey) return;
    const n = nodeOf(keyFromEvent(e));
    if (!n) return;
    if (n.folder) toggle(n);
    else onOpen?.(n);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (renaming || e.altKey) return;
    const count = rows.length;
    const idx = focus ? rowIndex.get(focus) ?? -1 : -1;
    const cur = idx >= 0 ? rows[idx] : undefined;
    const page = Math.max(1, Math.floor((viewH - HEADER_H) / rowH) - 1);
    const ctrl = e.ctrlKey || e.metaKey;
    let next = -1;
    switch (e.key) {
      case "ArrowDown":
        next = idx < 0 ? 0 : Math.min(count - 1, idx + 1);
        break;
      case "ArrowUp":
        next = idx < 0 ? 0 : Math.max(0, idx - 1);
        break;
      case "PageDown":
        next = Math.min(count - 1, Math.max(0, idx) + page);
        break;
      case "PageUp":
        next = Math.max(0, idx - page);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = count - 1;
        break;
      case "ArrowRight":
        if (!cur?.folder || filtering) return;
        e.preventDefault();
        if (!isOpen(cur)) {
          setOpen(cur, true);
          return;
        }
        if (idx + 1 < count && rows[idx + 1].parent === cur) next = idx + 1;
        else return;
        break;
      case "ArrowLeft": {
        if (!cur) return;
        e.preventDefault();
        if (cur.folder && isOpen(cur) && !filtering) {
          setOpen(cur, false);
          return;
        }
        const p = cur.parent && cur.parent.depth >= 0 ? rowIndex.get(cur.parent.key) : undefined;
        if (p == null) return;
        next = p;
        break;
      }
      case " ":
        e.preventDefault();
        setWanted(filesOf(selectedNodes()));
        return;
      case "Enter":
        if (!cur) return;
        e.preventDefault();
        if (cur.folder) toggle(cur);
        else onOpen?.(cur);
        return;
      case "F2":
        if (cur && onRename) {
          e.preventDefault();
          startRename(cur);
        }
        return;
      case "a":
      case "A":
        if (ctrl) {
          e.preventDefault();
          setSelected(new Set(rows.map((r) => r.key)));
        }
        return;
      case "ContextMenu":
      case "F10": {
        if (e.key === "F10" && !e.shiftKey) return;
        e.preventDefault();
        const targets = selectedNodes();
        if (!targets.length) return;
        const row = el.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(focus ?? targets[0].key)}"]`);
        const r = row?.getBoundingClientRect() ?? el.current!.getBoundingClientRect();
        openMenu({ items: menuFor(targets), x: r.left + 48, y: r.top + r.height / 2 });
        return;
      }
      default:
        return;
    }
    if (next < 0 || count === 0) return;
    e.preventDefault();
    const key = rows[next].key;
    if (e.shiftKey) selectRangeTo(key, ctrl);
    else if (ctrl) setFocus(key);
    else selectOnly(key);
    scrollToIndex(next);
  };

  // ---------------------------------------------------------------- render
  const overscan = 8;
  const start = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewH) / rowH) + overscan);
  const root = model.root;
  const allChecked = root.count > 0 && root.wantedCount === root.count;
  const someChecked = root.wantedCount > 0 && root.wantedCount < root.count;
  const SortIcon = sort.dir === 1 ? ArrowUp : ArrowDown;

  const style = {
    "--ft-cols": template,
    "--ft-min": `${minWidth}px`,
    "--ft-row-h": `${rowH}px`,
  } as CSSProperties;

  return (
    <div
      ref={el}
      className={["ft", className].filter(Boolean).join(" ")}
      style={style}
      tabIndex={0}
      role="treegrid"
      aria-multiselectable
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    >
      <div className="ft-head" role="row">
        {cols.map((c) => (
          <div
            key={c.key}
            role="columnheader"
            className={["ft-th", c.key === "name" && "name", c.right && "r", sort.key === c.key && "sorted"].filter(Boolean).join(" ")}
            aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
            onClick={() =>
              setSort((s) => (s.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: c.key === "name" ? 1 : -1 }))
            }
          >
            {c.key === "name" && (
              <span className="ft-check" onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  checked={allChecked}
                  indeterminate={someChecked}
                  disabled={!root.count}
                  onChange={() => check(root)}
                  title={allChecked ? "Skip all files" : "Download all files"}
                />
              </span>
            )}
            {c.right && sort.key === c.key && <SortIcon className="sort-ic" />}
            <span className="ellipsis">{c.label}</span>
            {!c.right && sort.key === c.key && <SortIcon className="sort-ic" />}
          </div>
        ))}
      </div>
      <div className="ft-body" style={{ height: rows.length * rowH }}>
        <div className="ft-rows" style={{ transform: `translateY(${start * rowH}px)` }}>
          {rows.slice(start, end).map((n) => (
            <Row
              key={n.key}
              node={n}
              version={model.version}
              cols={cols}
              sel={selected.has(n.key)}
              foc={focus === n.key}
              open={n.folder && (filtering || isOpen(n))}
              renaming={renaming === n.key}
              windows={windows}
              h={h}
            />
          ))}
        </div>
      </div>
      {rows.length === 0 && <div className="ft-empty">{empty ?? (filtering ? "No files match" : "No files")}</div>}
    </div>
  );
}
