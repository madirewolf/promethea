import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";
import { create } from "zustand";

// ------------------------------------------------------------------ model
export interface MenuAction {
  type?: "item";
  label: string;
  icon?: ReactNode;
  /** Right-aligned text, e.g. a keyboard shortcut. */
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  /** Shows a check mark in the icon slot. */
  checked?: boolean;
  onSelect?: () => void;
  /** Submenu (a function is evaluated when the submenu opens). */
  items?: MenuEntry[] | (() => MenuEntry[]);
  /** Keep the menu open after selecting (for toggles in long lists). */
  keepOpen?: boolean;
}

export type MenuEntry = MenuAction | { type: "separator" } | { type: "label"; label: string } | false | null | undefined;

interface MenuSpec {
  items: MenuEntry[];
  x: number;
  y: number;
  /** When set, the menu drops down from this rectangle instead of opening at (x, y). */
  anchor?: DOMRect;
  align?: "start" | "end";
  onClose?: () => void;
  /** Minimum width (e.g. the anchor's width). */
  minWidth?: number;
}

const useMenuStore = create<{ menu: MenuSpec | null; seq: number }>(() => ({ menu: null, seq: 0 }));

export function openMenu(spec: MenuSpec): void {
  const prev = useMenuStore.getState().menu;
  prev?.onClose?.();
  useMenuStore.setState((s) => ({ menu: spec, seq: s.seq + 1 }));
}

export function closeMenu(): void {
  const prev = useMenuStore.getState().menu;
  if (!prev) return;
  useMenuStore.setState({ menu: null });
  prev.onClose?.();
}

/** Open a context menu at the mouse position. */
export function openContextMenu(e: ReactMouseEvent | MouseEvent, items: MenuEntry[]): void {
  e.preventDefault();
  e.stopPropagation();
  openMenu({ items, x: e.clientX, y: e.clientY });
}

/** Open a dropdown below an element (usually the clicked button). */
export function openDropdown(el: Element, items: MenuEntry[], opts: { align?: "start" | "end"; matchWidth?: boolean; onClose?: () => void } = {}): void {
  const r = el.getBoundingClientRect();
  openMenu({
    items,
    x: r.left,
    y: r.bottom,
    anchor: r,
    align: opts.align ?? "start",
    minWidth: opts.matchWidth ? r.width : undefined,
    onClose: opts.onClose,
  });
}

export function useMenuOpen(): boolean {
  return useMenuStore((s) => s.menu !== null);
}

// ------------------------------------------------------------------ rendering
function clean(items: MenuEntry[]): Exclude<MenuEntry, false | null | undefined>[] {
  const out: Exclude<MenuEntry, false | null | undefined>[] = [];
  for (const it of items) {
    if (!it) continue;
    if (it.type === "separator" && (out.length === 0 || out[out.length - 1].type === "separator")) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].type === "separator") out.pop();
  return out;
}

function isAction(it: Exclude<MenuEntry, false | null | undefined>): it is MenuAction {
  return it.type === undefined || it.type === "item";
}

export function MenuHost() {
  const { menu, seq } = useMenuStore();
  useEffect(() => {
    if (!menu) return;
    const down = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.(".menu")) closeMenu();
    };
    const blur = () => closeMenu();
    const wheel = (e: WheelEvent) => {
      if (!(e.target as Element).closest?.(".menu")) closeMenu();
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("blur", blur);
    window.addEventListener("resize", blur);
    window.addEventListener("wheel", wheel, true);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("blur", blur);
      window.removeEventListener("resize", blur);
      window.removeEventListener("wheel", wheel, true);
    };
  }, [menu]);
  if (!menu) return null;
  return createPortal(
    <MenuPanel
      key={seq}
      items={menu.items}
      x={menu.x}
      y={menu.y}
      anchor={menu.anchor}
      align={menu.align}
      minWidth={menu.minWidth}
      root
      onBack={closeMenu}
    />,
    document.body,
  );
}

interface PanelProps {
  items: MenuEntry[];
  x: number;
  y: number;
  anchor?: DOMRect;
  align?: "start" | "end";
  minWidth?: number;
  root?: boolean;
  /** For submenus: the parent item's rectangle (to flip left when needed). */
  parentRect?: DOMRect;
  onBack: () => void;
}

function MenuPanel({ items: raw, x, y, anchor, align, minWidth, root, parentRect, onBack }: PanelProps) {
  const items = clean(raw);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<{ index: number; rect: DOMRect; items: MenuEntry[] } | null>(null);
  const hoverTimer = useRef(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (anchor) {
      left = align === "end" ? anchor.right - w : anchor.left;
      top = anchor.bottom + 4;
      if (top + h > vh - 8 && anchor.top - h - 4 > 8) top = anchor.top - h - 4;
    } else if (parentRect) {
      left = parentRect.right + 2;
      top = parentRect.top - 5;
      if (left + w > vw - 8) left = parentRect.left - w - 2;
    }
    left = Math.max(8, Math.min(left, vw - w - 8));
    top = Math.max(8, Math.min(top, vh - h - 8));
    setPos({ left, top });
  }, [x, y, anchor, align, parentRect]);

  // Not before it's placed: until then it's `visibility: hidden`, which can't take focus.
  const placed = pos !== null;
  useEffect(() => {
    if (!placed || !(root || parentRect)) return;
    const prev = root ? document.activeElement : null;
    ref.current?.focus({ preventScroll: true });
    if (!(prev instanceof HTMLElement)) return;
    // Closing hands focus back, unless what the menu did took it.
    return () => {
      const now = document.activeElement;
      if ((!now || now === document.body) && prev.isConnected) prev.focus({ preventScroll: true });
    };
  }, [placed, root, parentRect]);

  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  const enabled = (i: number) => {
    const it = items[i];
    return !!it && isAction(it) && !it.disabled;
  };

  const move = (dir: 1 | -1) => {
    if (!items.length) return;
    let i = active;
    for (let n = 0; n < items.length; n++) {
      i = (i + dir + items.length) % items.length;
      if (enabled(i)) {
        setActive(i);
        return;
      }
    }
  };

  const openSub = (i: number) => {
    const it = items[i];
    if (!it || !isAction(it) || !it.items || it.disabled) {
      setSub(null);
      return;
    }
    const el = ref.current?.querySelector<HTMLElement>(`[data-index="${i}"]`);
    if (!el) return;
    const subItems = typeof it.items === "function" ? it.items() : it.items;
    setSub({ index: i, rect: el.getBoundingClientRect(), items: subItems });
  };

  const activate = (i: number) => {
    const it = items[i];
    if (!it || !isAction(it) || it.disabled) return;
    if (it.items) {
      openSub(i);
      return;
    }
    if (!it.keepOpen) closeMenu();
    it.onSelect?.();
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (sub) return; // the submenu has focus and handles keys
    e.stopPropagation();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Home":
        e.preventDefault();
        setActive(-1);
        move(1);
        break;
      case "End":
        e.preventDefault();
        setActive(items.length);
        move(-1);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (active >= 0) openSub(active);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (!root) onBack();
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (active >= 0) activate(active);
        break;
      case "Escape":
        e.preventDefault();
        if (root) closeMenu();
        else onBack();
        break;
      case "Tab":
        e.preventDefault();
        closeMenu();
        break;
    }
  };

  return (
    <>
      <div
        ref={ref}
        className="menu"
        role="menu"
        tabIndex={-1}
        style={{
          left: pos?.left ?? x,
          top: pos?.top ?? y,
          visibility: pos ? "visible" : "hidden",
          minWidth: minWidth ? Math.max(200, minWidth) : undefined,
        }}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
        onMouseLeave={() => {
          window.clearTimeout(hoverTimer.current);
          if (!sub) setActive(-1);
        }}
      >
        {items.length === 0 && <div className="menu-empty">Nothing here</div>}
        {items.map((it, i) => {
          if (it.type === "separator") return <div key={i} className="menu-sep" role="separator" />;
          if (it.type === "label") {
            return (
              <div key={i} className="menu-label">
                {it.label}
              </div>
            );
          }
          const cls = [
            "menu-item",
            i === active && "active",
            sub?.index === i && "open",
            it.danger && "danger",
            it.checked && "checked",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={i}
              type="button"
              data-index={i}
              role={it.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
              aria-checked={it.checked}
              aria-haspopup={it.items ? "menu" : undefined}
              className={cls}
              disabled={it.disabled}
              tabIndex={-1}
              onMouseEnter={() => {
                setActive(i);
                window.clearTimeout(hoverTimer.current);
                if (sub?.index === i) return;
                hoverTimer.current = window.setTimeout(() => {
                  if (it.items) openSub(i);
                  else setSub(null);
                }, it.items ? 90 : 160);
              }}
              onClick={() => activate(i)}
            >
              <span className="mi-icon">{it.checked ? <Check /> : it.icon}</span>
              <span className="mi-label">{it.label}</span>
              {it.hint && <span className="mi-hint">{it.hint}</span>}
              {it.items && <ChevronRight className="mi-chev" />}
            </button>
          );
        })}
      </div>
      {sub && (
        <MenuPanel
          key={sub.index}
          items={sub.items}
          x={sub.rect.right}
          y={sub.rect.top}
          parentRect={sub.rect}
          onBack={() => {
            setSub(null);
            ref.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}
