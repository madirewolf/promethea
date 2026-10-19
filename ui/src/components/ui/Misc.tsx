import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { FolderOpen, LoaderCircle } from "lucide-react";
import { api } from "../../api/client";
import { useStore } from "../../store/store";
import { formatBytes } from "../../lib/format";
import { useDebounced } from "../../lib/hooks";
import { baseName, parentPath } from "../../lib/paths";
import { IconButton } from "./Button";

// ------------------------------------------------------------------ progress
export function Progress({ value, size, className }: { value: number; size?: "lg"; className?: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className={["progress", size, className].filter(Boolean).join(" ")} role="progressbar" aria-valuenow={Math.round(pct)}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle className="spinner" width={size} height={size} />;
}

// ------------------------------------------------------------------ empty state
export function Empty({
  icon,
  title,
  children,
  actions,
  className,
}: {
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={["empty", className].filter(Boolean).join(" ")}>
      {icon && <div className="empty-icon">{icon}</div>}
      {title && <h3>{title}</h3>}
      {children && <p>{children}</p>}
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ tabs
export interface TabSpec<T extends string> {
  key: T;
  label: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
  children,
}: {
  tabs: TabSpec<T>[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
  /** Extra content at the right end of the tab strip. */
  children?: ReactNode;
}) {
  return (
    <div className={["tabs", className].filter(Boolean).join(" ")} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={value === t.key}
          className={["tab", value === t.key && "on"].filter(Boolean).join(" ")}
          onClick={() => onChange(t.key)}
        >
          {t.icon}
          <span>{t.label}</span>
          {t.badge != null && t.badge !== 0 && <span className="tab-badge">{t.badge}</span>}
        </button>
      ))}
      {children && <div className="tabs-extra">{children}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ path input
interface PathInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** "folder" (default) or "file" for the browse dialog. */
  kind?: "folder" | "open" | "save";
  dialogTitle?: string;
  fileTypes?: string[];
  saveName?: string;
  disabled?: boolean;
  /** Show free space on the volume under the input. */
  showFreeSpace?: boolean;
  autoFocus?: boolean;
  invalid?: boolean;
  /** Bytes about to be written there: the free-space line warns when the drive is short. */
  needed?: number;
  /** Recently used folders, offered before anything is typed. */
  recent?: readonly string[];
  /** The desktop app's Browse button (default true); off when the caller has its own. */
  browse?: boolean;
  /** Goes on the text box, for a `<label htmlFor>`. */
  id?: string;
  /** Its name when no `<label>` points at it. */
  "aria-label"?: string;
}

/**
 * A path box with directory completion (from the backend's filesystem) and,
 * in the desktop app, a native Browse button.
 */
export function PathInput({
  value,
  onChange,
  placeholder,
  kind = "folder",
  dialogTitle,
  fileTypes,
  saveName,
  disabled,
  showFreeSpace,
  autoFocus,
  invalid,
  needed,
  recent,
  browse: showBrowse = true,
  id,
  "aria-label": ariaLabel,
}: PathInputProps) {
  const desktop = useStore((s) => !!s.app?.desktop);
  const local = useStore((s) => !!s.app?.local);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<string[]>([]);
  const [active, setActive] = useState(-1);
  const [free, setFree] = useState<number | null>(null);
  const typed = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const query = useDebounced(value, 150);
  const freeQuery = useDebounced(value, 400);

  useEffect(() => {
    if (!open || !typed.current || kind !== "folder") return;
    let alive = true;
    api
      .completeDirs(query)
      .then((dirs) => alive && (setItems(dirs.slice(0, 12)), setActive(-1)))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [query, open, kind]);

  useEffect(() => {
    if (!showFreeSpace || !freeQuery.trim()) {
      setFree(null);
      return;
    }
    let alive = true;
    api
      .freeSpace(freeQuery)
      .then((r) => alive && setFree(r.free))
      .catch(() => alive && setFree(null));
    return () => {
      alive = false;
    };
  }, [freeQuery, showFreeSpace]);

  const browse = async () => {
    // A file box holds a file's path: the dialog opens in its folder, on that name.
    const file = kind !== "folder" && !/[\\/]$/.test(value.trim());
    try {
      const paths = await api.dialog({
        kind,
        title: dialogTitle ?? (kind === "folder" ? "Choose a folder" : "Choose a file"),
        directory: (file ? parentPath(value) : value.trim()) || undefined,
        fileTypes,
        saveName: kind === "save" ? (file && baseName(value)) || saveName : saveName,
      });
      if (paths[0]) onChange(paths[0]);
    } catch {
      /* dialog closed */
    }
  };

  const shown = kind !== "folder" ? [] : typed.current ? items : (recent ?? []).filter((p) => p !== value);

  const pick = (p: string) => {
    onChange(p);
    typed.current = true;
    setActive(-1);
    inputRef.current?.focus();
  };

  return (
    <div className="path-input">
      <div className={["input-wrap", invalid && "invalid"].filter(Boolean).join(" ")}>
        <input
          ref={inputRef}
          id={id}
          aria-label={ariaLabel}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          autoFocus={autoFocus}
          className="mono-ish"
          onChange={(e) => {
            typed.current = true;
            setOpen(true);
            onChange(e.target.value);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (!open || !shown.length) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => (a + 1) % shown.length);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (a <= 0 ? shown.length - 1 : a - 1));
            } else if ((e.key === "Tab" || e.key === "Enter") && active >= 0 && active < shown.length) {
              e.preventDefault();
              pick(shown[active]);
            } else if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        />
        {desktop && local && showBrowse && (
          <IconButton label="Browse" size="sm" onClick={browse} disabled={disabled}>
            <FolderOpen />
          </IconButton>
        )}
      </div>
      {open && !disabled && shown.length > 0 && (
        <div className="path-suggest" onMouseDown={(e) => e.preventDefault()}>
          {!typed.current && <div className="path-suggest-head">Recent</div>}
          {shown.map((p, i) => (
            <button
              key={p}
              type="button"
              tabIndex={-1}
              className={i === active ? "active" : undefined}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(p)}
            >
              {p}
            </button>
          ))}
        </div>
      )}
      {showFreeSpace && free != null && (
        <div className={["path-free", needed != null && needed > free && "short"].filter(Boolean).join(" ")}>
          {formatBytes(free)} free on this drive
          {needed != null && needed > free && <> · needs {formatBytes(needed)}</>}
        </div>
      )}
    </div>
  );
}
