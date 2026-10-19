// Right-click menus for choosing what the sidebar and the details panel show.

import { EyeOff } from "lucide-react";
import type { MenuEntry } from "../../components/ui/Menu";
import { DETAILS_TABS, LAYOUTS, SIDE_SECTIONS, layoutName } from "../../lib/layout";
import type { DetailsTab, Layout, SideSection } from "../../lib/layout";
import { STATUS_FILTERS } from "../../lib/states";
import type { StatusFilter } from "../../lib/states";
import { setLayout, useStore } from "../../store/store";

/** `list` with `key` added or taken out, kept in the order of `all`. */
function toggled<T>(list: readonly T[], key: T, all: readonly T[]): T[] {
  return list.includes(key) ? list.filter((k) => k !== key) : all.filter((k) => k === key || list.includes(k));
}

const layout = (): Layout => useStore.getState().layout;

function presets(): MenuEntry[] {
  const name = layoutName(layout());
  return [
    { type: "label", label: name ? "Layout" : "Layout (your own)" },
    { label: "Simple", checked: name === "simple", onSelect: () => setLayout(LAYOUTS.simple) },
    { label: "Detailed", checked: name === "detailed", onSelect: () => setLayout(LAYOUTS.detailed) },
  ];
}

const STATUS_KEYS = STATUS_FILTERS.map((f) => f.key).filter((k) => k !== "all");
const SECTION_KEYS = SIDE_SECTIONS.map((s) => s.key);
const TAB_KEYS = DETAILS_TABS.map((t) => t.key);

function statusToggles(): MenuEntry[] {
  const shown = layout().status;
  return STATUS_FILTERS.filter((f) => f.key !== "all").map((f) => ({
    label: f.label,
    checked: shown.includes(f.key),
    keepOpen: true,
    onSelect: () => setLayout({ status: toggled(layout().status, f.key, STATUS_KEYS) }),
  }));
}

function sectionToggles(): MenuEntry[] {
  const shown = layout().sections;
  return SIDE_SECTIONS.map((s) => ({
    label: s.label,
    checked: shown.includes(s.key),
    keepOpen: true,
    onSelect: () => setLayout({ sections: toggled(layout().sections, s.key, SECTION_KEYS) }),
  }));
}

/** Right-clicking the sidebar: a heading (`section`) or a status filter (`status`). */
export function sidebarMenu(at: { status?: StatusFilter; section?: SideSection } = {}): MenuEntry[] {
  const statusLabel = at.status && STATUS_FILTERS.find((f) => f.key === at.status)?.label;
  const sectionLabel = at.section && SIDE_SECTIONS.find((s) => s.key === at.section)?.label;
  return [
    at.status &&
      at.status !== "all" &&
      layout().status.includes(at.status) && {
        label: `Hide “${statusLabel}”`,
        icon: <EyeOff />,
        onSelect: () => setLayout({ status: toggled(layout().status, at.status!, STATUS_KEYS) }),
      },
    at.section && {
      label: `Hide ${sectionLabel}`,
      icon: <EyeOff />,
      onSelect: () => setLayout({ sections: toggled(layout().sections, at.section!, SECTION_KEYS) }),
    },
    { type: "separator" },
    ...presets(),
    { type: "separator" },
    { label: "Status filters", items: statusToggles },
    { label: "Sections", items: sectionToggles },
  ];
}

/** Right-clicking a tab of the details panel. */
export function tabsMenu(tab?: DetailsTab): MenuEntry[] {
  const l = layout();
  const label = (k: DetailsTab) => DETAILS_TABS.find((t) => t.key === k)?.label ?? k;
  return [
    tab &&
      l.tabs.length > 1 && {
        label: `Hide ${label(tab)}`,
        icon: <EyeOff />,
        onSelect: () => setLayout({ tabs: toggled(layout().tabs, tab, TAB_KEYS) }),
      },
    { type: "separator" },
    ...presets(),
    { type: "separator" },
    {
      label: "Tabs",
      items: () =>
        DETAILS_TABS.map((t) => {
          const shown = layout().tabs;
          const on = shown.includes(t.key);
          return {
            label: t.label,
            checked: on,
            // One tab always stays.
            disabled: on && shown.length === 1,
            keepOpen: true,
            onSelect: () => setLayout({ tabs: toggled(layout().tabs, t.key, TAB_KEYS) }),
          };
        }),
    },
    {
      label: "Every detail in General",
      checked: l.everyDetail,
      onSelect: () => setLayout({ everyDetail: !layout().everyDetail }),
    },
  ];
}
